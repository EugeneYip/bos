import * as THREE from 'three';
import type { App } from '../core/App';
import type { Ctx, WorldModule } from '../core/Context';
import { RENDER } from '../core/config';
import { makeRT, disposeRT, PingPong, RTPool } from './core/rt';
import { GpuTimer } from './core/timer';
import type { Pass } from './core/quad';
import { defaultSettings, preset, type PostSettings, type DeepPartial } from './settings';
import { createTaaPass, haltonJitterTable, type TaaUniforms } from './passes/taa';
import { createGtaoPass, createGtaoDenoisePass, createGtaoTemporalPass } from './passes/gtao';
import { createSsrPass, createSsrResolvePass, createGBufferMaterial, SSR_LAYER } from './passes/ssr';
import { createCompositePass } from './passes/composite';
import {
  createBloomPrefilterPass, createBloomDownPass, createBloomUpPass, createStreakPass,
} from './passes/bloom';
import { createLumSeedPass, createLumReducePass, createAdaptPass } from './passes/exposure';
import { createVelocityPass, createTileMaxPass, createNeighborMaxPass, createMotionBlurPass } from './passes/motionBlur';
import { createDofCocPass, createDofGatherPass, createDofCompositePass } from './passes/dof';
import { createEasuPass, createRcasPass } from './passes/upscale';
import { createGradePass } from './passes/grade';

/**
 * The post-processing chain.
 *
 * Everything upstream of the grade stays in linear HDR; the grade is the one
 * place the image is tonemapped and written to sRGB. `App` sets ACES on the
 * renderer for the no-post fallback, so this module turns the renderer's own
 * tonemapper OFF while it is active and re-applies it on dispose — otherwise
 * the frame would be tonemapped twice.
 *
 * Per-frame order, and why:
 *
 *   jitter -> scene (HDR + depth)
 *   velocity            camera reprojection, used by TAA and motion blur
 *   G-buffer            view normal + roughness, only if SSR is on
 *   GTAO -> denoise -> temporal
 *   SSR -> resolve
 *   composite           folds AO and SSR into the lit colour
 *   TAA                 resolves the jitter; must see a converged HDR frame
 *   motion blur         after TAA, or it fights the history
 *   depth of field
 *   bloom pyramid       from the resolved frame
 *   exposure            metered off the same frame, adapted over time
 *   grade               tonemap + bloom + lens + sRGB
 *   upscale             EASU/RCAS when rendering below native
 */

/** Scene layer the SSR G-buffer pass renders. */
const GBUFFER_LAYER = SSR_LAYER;

interface Targets {
  scene: THREE.WebGLRenderTarget;
  gbuffer: THREE.WebGLRenderTarget | null;
}

export class Post implements WorldModule {
  readonly name = 'Post';

  private app: App | null = null;
  private ctx: Ctx | null = null;
  private settings: PostSettings = defaultSettings();
  private timer: GpuTimer | null = null;
  private pool = new RTPool();

  /** Backbuffer size, and the (possibly smaller) size the scene renders at. */
  private width = 2;
  private height = 2;
  private rw = 2;
  private rh = 2;

  private rt: Targets = { scene: null as unknown as THREE.WebGLRenderTarget, gbuffer: null };
  private taaHistory: PingPong | null = null;
  private aoHistory: PingPong | null = null;
  private lumHistory: PingPong | null = null;
  private bloomChain: THREE.WebGLRenderTarget[] = [];

  private passes: Record<string, Pass> = {};
  private taa: Pass<TaaUniforms> | null = null;
  private gbufferMat: THREE.ShaderMaterial | null = null;
  /** Meshes enrolled into the SSR G-buffer, and when we last looked. */
  private ssrEnrolled = 0;
  private ssrScanAt = -1;

  private jitterTable = haltonJitterTable(16);
  private frame = 0;
  private historyValid = 0;
  /** Previous frame's unjittered projection and view, for reprojection. */
  private prevProj = new THREE.Matrix4();
  private prevView = new THREE.Matrix4();
  /** prevProj * prevView * inverse(currView) — applied to a VIEW position. */
  private reproject = new THREE.Matrix4();
  /** prevView * inverse(currView), for the AO pass's depth rejection. */
  private prevViewRel = new THREE.Matrix4();
  private projInv = new THREE.Matrix4();
  private unjittered = new THREE.Matrix4();
  private jitter = new THREE.Vector2();
  private lastCamPos = new THREE.Vector3();
  private lastCamQuat = new THREE.Quaternion();
  private cameraMotion = 0;
  private failed = false;

  /**
   * Called from `main.ts` before `init`. `Ctx` deliberately does not expose
   * the App, so presentation ownership is handed over explicitly rather than
   * reached for through a global.
   */
  attach(app: App): void {
    this.app = app;
  }

  async init(ctx: Ctx): Promise<void> {
    this.ctx = ctx;
    if (!this.app) {
      console.warn('[Post] not attached to an App; leaving the renderer to present');
      return;
    }

    this.applyTier(ctx);
    this.applyUrlOverrides();
    const r = ctx.renderer;
    this.timer = new GpuTimer(r);

    try {
      this.build(ctx);
    } catch (err) {
      console.error('[Post] failed to build the chain; falling back to direct rendering', err);
      this.failed = true;
      return;
    }

    // From here the grade owns the tonemap. Leaving ACES on the renderer as
    // well would apply it twice.
    r.toneMapping = THREE.NoToneMapping;
    this.app.renderOverride = (dt) => this.present(dt);

    ctx.on('quality-changed', () => { this.applyTier(ctx); this.resize(this.width, this.height, ctx); });
    ctx.on('post:set', (p) => this.apply(p as DeepPartial<PostSettings>));
    ctx.on('photo-mode', (on) => { this.settings.dof.enabled = on !== false; });

    console.info(
      `[Post] chain up at ${(this.settings.renderScale * 100).toFixed(0)}% scale — ` +
      `taa:${this.settings.taa.enabled} ao:${this.settings.ao.enabled} ssr:${this.settings.ssr.enabled} ` +
      `bloom:${this.settings.bloom.enabled} mb:${this.settings.motionBlur.enabled} ` +
      `timer:${this.timer.supported ? 'gpu' : 'cpu'}`,
    );
  }

  /* --------------------------------------------------------------- setup */

  /** Fold the quality tier into the settings block. */
  private applyTier(ctx: Ctx): void {
    const q = ctx.quality;
    const s = this.settings;
    const ultra = ctx.tier === 'ultra';

    s.taa.enabled = q.taa;
    s.bloom.enabled = q.bloom;
    s.bloom.levels = ctx.tier === 'low' ? 4 : ctx.tier === 'medium' ? 5 : 6;
    s.exposure.enabled = true;

    // The expensive half of the chain is reserved for `ultra`. Screen-space
    // reflections need a second scene submit for the G-buffer, and motion
    // blur needs a velocity buffer plus four more full-screen passes; both
    // together cost more than everything else combined, and on `high` the
    // frame budget is better spent holding 60 fps.
    s.ao.enabled = q.ssao;
    s.ao.slices = ultra ? Math.max(3, Math.round(q.ssaoSamples / 5)) : 2;
    s.ao.halfRes = !ultra;
    s.ssr.enabled = q.ssr && ultra;
    s.ssr.steps = ultra ? 40 : 24;
    s.motionBlur.enabled = q.motionBlur && ultra;

    s.renderScale = ctx.tier === 'low' ? 0.72 : ctx.tier === 'medium' ? 0.85 : 1;
    s.finalAA = q.taa ? 'none' : 'fxaa';
    s.profile = ultra || ctx.tier === 'high';
  }

  /**
   * `?post=off` bypasses the chain; `?post=taa,bloom` runs only the named
   * stages. Bisecting a post chain by editing code and rebuilding is slow,
   * and every stage can plausibly be the one ruining the frame.
   */
  private applyUrlOverrides(): void {
    const q = new URLSearchParams(location.search).get('post');
    if (!q) return;
    const s = this.settings;
    if (q === 'off') { s.enabled = false; return; }
    const want = new Set(q.split(',').map((n) => n.trim().toLowerCase()).filter(Boolean));
    s.taa.enabled = want.has('taa');
    s.ao.enabled = want.has('ao');
    s.ssr.enabled = want.has('ssr');
    s.bloom.enabled = want.has('bloom');
    s.motionBlur.enabled = want.has('mb') || want.has('motionblur');
    s.dof.enabled = want.has('dof');
    s.exposure.enabled = want.has('exposure');
    s.lens.grain = want.has('grain');
    s.lens.vignette = want.has('vignette');
    s.lens.chromaticAberration = want.has('ca');
    s.renderScale = want.has('half') ? 0.5 : 1;
    console.info(`[Post] url override -> ${[...want].join(',') || '(grade only)'}`);
  }

  private build(ctx: Ctx): void {
    const p = this.passes;
    p.composite = createCompositePass();
    p.grade = createGradePass();
    this.taa = createTaaPass();

    p.gtao = createGtaoPass(this.settings.ao.slices, 6);
    p.gtaoDenoise = createGtaoDenoisePass();
    p.gtaoTemporal = createGtaoTemporalPass();

    p.ssr = createSsrPass(this.settings.ssr.steps, this.settings.ssr.refineSteps);
    p.ssrResolve = createSsrResolvePass();

    p.bloomPrefilter = createBloomPrefilterPass();
    p.bloomDown = createBloomDownPass();
    p.bloomUp = createBloomUpPass();
    p.streak = createStreakPass();

    p.lumSeed = createLumSeedPass();
    p.lumReduce = createLumReducePass();
    p.adapt = createAdaptPass();

    p.velocity = createVelocityPass();
    p.tileMax = createTileMaxPass();
    p.neighborMax = createNeighborMaxPass();
    p.motionBlur = createMotionBlurPass(this.settings.motionBlur.samples);

    p.dofCoc = createDofCocPass();
    p.dofFar = createDofGatherPass(false, 24);
    p.dofNear = createDofGatherPass(true, 16);
    p.dofComposite = createDofCompositePass();

    p.easu = createEasuPass();
    p.rcas = createRcasPass();

    this.gbufferMat = createGBufferMaterial(0.5, 0.04);

    const size = new THREE.Vector2();
    ctx.renderer.getSize(size);
    this.resize(size.x, size.y, ctx);
  }

  resize(width: number, height: number, ctx: Ctx): void {
    if (this.failed || !this.app) return;
    const dpr = ctx.renderer.getPixelRatio();
    this.width = Math.max(2, Math.round(width * dpr));
    this.height = Math.max(2, Math.round(height * dpr));
    const s = Math.max(0.5, Math.min(1, this.settings.renderScale));
    this.rw = Math.max(2, Math.round(this.width * s));
    this.rh = Math.max(2, Math.round(this.height * s));

    disposeRT(this.rt.scene);
    disposeRT(this.rt.gbuffer);
    this.rt.scene = makeRT(this.rw, this.rh, { depth: true, name: 'post.scene' });
    this.rt.gbuffer = this.settings.ssr.enabled
      ? makeRT(this.rw, this.rh, { type: THREE.HalfFloatType, name: 'post.gbuffer' })
      : null;

    this.taaHistory?.dispose();
    this.taaHistory = new PingPong(this.rw, this.rh, { name: 'post.taa' });
    const aoScale = this.settings.ao.halfRes ? 0.5 : 1;
    this.aoHistory?.dispose();
    this.aoHistory = new PingPong(this.rw * aoScale, this.rh * aoScale, { name: 'post.ao' });
    this.lumHistory?.dispose();
    this.lumHistory = new PingPong(1, 1, { type: THREE.FloatType, filter: THREE.NearestFilter, name: 'post.lum' });

    for (const rt of this.bloomChain) disposeRT(rt);
    this.bloomChain = [];
    let bw = this.rw >> 1;
    let bh = this.rh >> 1;
    for (let i = 0; i < this.settings.bloom.levels && bw > 4 && bh > 4; i++) {
      this.bloomChain.push(makeRT(bw, bh, { name: `post.bloom${i}` }));
      bw = Math.max(4, bw >> 1);
      bh = Math.max(4, bh >> 1);
    }

    this.historyValid = 0;
    this.pool.dispose();
  }

  /** Runtime settings patch from the HUD. */
  apply(patch: DeepPartial<PostSettings>): void {
    const merge = (dst: Record<string, unknown>, src: Record<string, unknown>): void => {
      for (const [k, v] of Object.entries(src)) {
        if (v && typeof v === 'object' && !Array.isArray(v) && typeof dst[k] === 'object') {
          merge(dst[k] as Record<string, unknown>, v as Record<string, unknown>);
        } else if (v !== undefined) dst[k] = v;
      }
    };
    // The HUD emits { key, value } for single toggles as well as full patches.
    const flat = patch as unknown as { key?: string; value?: unknown };
    if (typeof flat.key === 'string') {
      const k = flat.key;
      const on = flat.value !== false;
      const map: Record<string, () => void> = {
        bloom: () => { this.settings.bloom.enabled = on; },
        ssao: () => { this.settings.ao.enabled = on; },
        ao: () => { this.settings.ao.enabled = on; },
        ssr: () => { this.settings.ssr.enabled = on; },
        taa: () => { this.settings.taa.enabled = on; },
        motionBlur: () => { this.settings.motionBlur.enabled = on; },
        dof: () => { this.settings.dof.enabled = on; },
        grain: () => { this.settings.lens.grain = on; },
        vignette: () => { this.settings.lens.vignette = on; },
        enabled: () => { this.settings.enabled = on; },
      };
      map[k]?.();
      return;
    }
    merge(this.settings as unknown as Record<string, unknown>, patch as Record<string, unknown>);
    if (patch.grade?.preset) Object.assign(this.settings.grade, preset(patch.grade.preset));
  }

  /**
   * Put every surface smooth and shiny enough to be worth tracing onto the
   * SSR layer: glass curtain wall, the water, polished metal. Everything else
   * stays off it, which keeps the G-buffer pass to the handful of draws that
   * actually reflect rather than a second full submit of the city.
   */
  private enrolSsr(ctx: Ctx): void {
    const s = this.settings.ssr;
    let n = 0;
    ctx.scene.traverse((o) => {
      const m = o as THREE.Mesh;
      if (!m.isMesh || !m.material) return;
      const mats = Array.isArray(m.material) ? m.material : [m.material];
      let shiny = false;
      for (const mat of mats) {
        const std = mat as THREE.MeshStandardMaterial;
        // ShaderMaterials (the water) declare themselves through userData.
        if ((mat.userData as { ssr?: boolean }).ssr) { shiny = true; break; }
        if (std.roughness === undefined) continue;
        if (std.roughness <= s.autoEnrolRoughness || std.metalness >= s.autoEnrolMetalness) {
          shiny = true;
          break;
        }
      }
      if (shiny) { m.layers.enable(GBUFFER_LAYER); n++; } else { m.layers.disable(GBUFFER_LAYER); }
    });
    if (n !== this.ssrEnrolled) {
      this.ssrEnrolled = n;
      (this.ctx ?? ctx).stats['post.ssrMeshes'] = n;
    }
  }

  /* --------------------------------------------------------------- frame */

  update(_dt: number, ctx: Ctx): void {
    // Jitter is applied to the camera *before* App renders, which is why the
    // projection is set up here rather than inside present().
    if (this.failed || !this.app || !this.settings.enabled) return;
    const cam = ctx.camera;

    // How much the camera moved this frame drives TAA feedback and motion blur.
    const dp = cam.position.distanceTo(this.lastCamPos);
    const dq = 1 - Math.abs(cam.quaternion.dot(this.lastCamQuat));
    this.cameraMotion = Math.min(dp * 0.12 + dq * 40, 1);
    this.lastCamPos.copy(cam.position);
    this.lastCamQuat.copy(cam.quaternion);

    cam.updateMatrixWorld();
    cam.updateProjectionMatrix();
    this.unjittered.copy(cam.projectionMatrix);

    if (this.settings.taa.enabled) {
      const [jx, jy] = this.jitterTable[this.frame % this.jitterTable.length];
      const s = this.settings.taa.jitterScale;
      this.jitter.set((jx * 2 * s) / this.rw, (jy * 2 * s) / this.rh);
      cam.projectionMatrix.elements[8] += this.jitter.x;
      cam.projectionMatrix.elements[9] += this.jitter.y;
      cam.projectionMatrixInverse.copy(cam.projectionMatrix).invert();
    } else {
      this.jitter.set(0, 0);
    }
  }

  /** Owns presentation while the chain is up. */
  private present(dt: number): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const r = ctx.renderer;

    if (this.failed || !this.settings.enabled) {
      // The grade owns the tonemap while the chain is up; bypassing it means
      // handing that job back, or the frame presents untonemapped and black.
      if (r.toneMapping !== THREE.ACESFilmicToneMapping) {
        r.toneMapping = THREE.ACESFilmicToneMapping;
      }
      r.setRenderTarget(null);
      r.render(ctx.scene, ctx.camera);
      return;
    }
    if (r.toneMapping !== THREE.NoToneMapping) r.toneMapping = THREE.NoToneMapping;

    try {
      this.renderChain(dt, ctx);
    } catch (err) {
      console.error('[Post] chain threw; reverting to direct rendering', err);
      this.failed = true;
      r.toneMapping = THREE.ACESFilmicToneMapping;
      if (this.app) this.app.renderOverride = null;
      r.setRenderTarget(null);
      r.render(ctx.scene, ctx.camera);
    } finally {
      this.pool.recycle();
    }
  }

  private renderChain(dt: number, ctx: Ctx): void {
    const r = ctx.renderer;
    const cam = ctx.camera;
    const s = this.settings;
    const t = this.timer;
    const p = this.passes;
    const rw = this.rw;
    const rh = this.rh;
    const texel = new THREE.Vector2(1 / rw, 1 / rh);

    // Every temporal pass reconstructs a VIEW-space position from depth and
    // then applies uReproject, so the matrix must be
    // prevProj * prevView * inverse(currView) — not a clip-to-clip transform.
    // inverse(currView) is just the camera's world matrix.
    this.reproject
      .multiplyMatrices(this.prevProj, this.prevView)
      .multiply(cam.matrixWorld);
    this.prevViewRel.multiplyMatrices(this.prevView, cam.matrixWorld);
    this.projInv.copy(this.unjittered).invert();

    /* ---- scene ---------------------------------------------------------- */
    t?.begin('scene');
    r.setRenderTarget(this.rt.scene);
    r.clear();
    r.render(ctx.scene, cam);
    t?.end();
    const depth = this.rt.scene.depthTexture!;

    /* ---- velocity ------------------------------------------------------- */
    let velocity: THREE.WebGLRenderTarget | null = null;
    // A still camera produces no blur, so the velocity buffer, the two tile
    // reductions, the neighbour-max and the gather are all pure cost. Skip
    // the whole branch below a threshold rather than blur by zero pixels.
    const wantVelocity = s.motionBlur.enabled && this.historyValid > 0 && this.cameraMotion > 0.004;
    if (wantVelocity) {
      t?.begin('velocity');
      velocity = this.pool.acquire(rw, rh, { type: THREE.HalfFloatType });
      const v = p.velocity.uniforms;
      v.tDepth.value = depth;
      v.uProjInv.value = this.projInv;
      v.uReproject.value = this.reproject;
      (v.uSize.value as THREE.Vector2).set(rw, rh);
      v.uScale.value = (s.motionBlur.shutterAngle / 360) * Math.min(1 / Math.max(dt, 1e-3) / 60, 2);
      v.uMaxPixels.value = s.motionBlur.maxBlurPixels;
      p.velocity.render(r, velocity);
      t?.end();
    }

    /* ---- G-buffer for SSR ---------------------------------------------- */
    // The world streams in over several seconds, so rescan periodically until
    // it settles. Rendering an empty G-buffer costs a full scene traversal
    // and buys nothing, so SSR is skipped entirely when nothing is enrolled.
    if (s.ssr.enabled && (this.frame < 4 || ctx.elapsed - this.ssrScanAt > 4)) {
      this.ssrScanAt = ctx.elapsed;
      this.enrolSsr(ctx);
    }
    let gbuffer: THREE.Texture | null = null;
    if (s.ssr.enabled && this.ssrEnrolled > 0 && this.rt.gbuffer && this.gbufferMat) {
      t?.begin('gbuffer');
      const prevMask = cam.layers.mask;
      const prevOverride = ctx.scene.overrideMaterial;
      cam.layers.set(GBUFFER_LAYER);
      ctx.scene.overrideMaterial = this.gbufferMat;
      r.setRenderTarget(this.rt.gbuffer);
      r.setClearColor(0x000000, 0);
      r.clear();
      r.render(ctx.scene, cam);
      ctx.scene.overrideMaterial = prevOverride;
      cam.layers.mask = prevMask;
      gbuffer = this.rt.gbuffer.texture;
      t?.end();
    }

    /* ---- ambient occlusion ---------------------------------------------- */
    let ao: THREE.Texture | null = null;
    if (s.ao.enabled && this.aoHistory) {
      t?.begin('ao');
      const scale = s.ao.halfRes ? 0.5 : 1;
      const aw = Math.max(2, Math.round(rw * scale));
      const ah = Math.max(2, Math.round(rh * scale));
      const raw = this.pool.acquire(aw, ah, { type: THREE.HalfFloatType });

      const g = p.gtao.uniforms;
      g.tDepth.value = depth;
      g.uProjInv.value = this.projInv;
      (g.uTexelFull.value as THREE.Vector2).set(1 / aw, 1 / ah);
      // Projection scale: pixels per metre at one metre of depth.
      g.uProjScale.value = (ah * 0.5) / Math.tan((cam.fov * Math.PI) / 360);
      g.uRadius.value = s.ao.radius;
      g.uThickness.value = s.ao.thickness;
      g.uMaxDistance.value = s.ao.maxDistance;
      g.uPower.value = s.ao.power;
      g.uFrame.value = this.frame;
      p.gtao.render(r, raw);

      // Separable bilateral denoise, then reproject against the history.
      const blurA = this.pool.acquire(aw, ah, { type: THREE.HalfFloatType });
      const d = p.gtaoDenoise.uniforms;
      d.tAO.value = raw.texture;
      (d.uTexel.value as THREE.Vector2).set(1 / aw, 1 / ah);
      (d.uDir.value as THREE.Vector2).set(1, 0);
      p.gtaoDenoise.render(r, blurA);
      const blurB = this.pool.acquire(aw, ah, { type: THREE.HalfFloatType });
      d.tAO.value = blurA.texture;
      (d.uDir.value as THREE.Vector2).set(0, 1);
      p.gtaoDenoise.render(r, blurB);

      const tp = p.gtaoTemporal.uniforms;
      tp.tAO.value = blurB.texture;
      tp.tHistory.value = this.aoHistory.read.texture;
      tp.tDepth.value = depth;
      tp.uProjInv.value = this.projInv;
      tp.uReproject.value = this.reproject;
      tp.uPrevView.value = this.prevViewRel;
      tp.uValid.value = this.historyValid;
      p.gtaoTemporal.render(r, this.aoHistory.write);
      ao = this.aoHistory.write.texture;
      this.aoHistory.swap();
      t?.end();
    }

    /* ---- screen-space reflections --------------------------------------- */
    let ssr: THREE.Texture | null = null;
    if (gbuffer) {
      t?.begin('ssr');
      const half = this.pool.acquire(rw >> 1, rh >> 1, { type: THREE.HalfFloatType });
      const su = p.ssr.uniforms;
      su.tColor.value = this.rt.scene.texture;
      su.tDepth.value = depth;
      su.tGBuffer.value = gbuffer;
      su.uProj.value = this.unjittered;
      su.uProjInv.value = this.projInv;
      (su.uTexel.value as THREE.Vector2).set(2 / rw, 2 / rh);
      su.uMaxDistance.value = s.ssr.maxDistance;
      su.uThickness.value = s.ssr.thickness;
      su.uMaxRoughness.value = s.ssr.maxRoughness;
      su.uNear.value = RENDER.near;
      su.uFrame.value = this.frame;
      p.ssr.render(r, half);

      const res = this.pool.acquire(rw >> 1, rh >> 1, { type: THREE.HalfFloatType });
      const rs = p.ssrResolve.uniforms;
      rs.tSSR.value = half.texture;
      rs.tGBuffer.value = gbuffer;
      (rs.uTexel.value as THREE.Vector2).set(2 / rw, 2 / rh);
      (rs.uDir.value as THREE.Vector2).set(1, 0);
      p.ssrResolve.render(r, res);
      ssr = res.texture;
      t?.end();
    }

    /* ---- composite AO + SSR into the lit frame -------------------------- */
    t?.begin('composite');
    let color = this.pool.acquire(rw, rh, { type: THREE.HalfFloatType });
    const c = p.composite.uniforms;
    c.tColor.value = this.rt.scene.texture;
    c.tDepth.value = depth;
    c.tAO.value = ao;
    c.tSSR.value = ssr;
    c.tGBuffer.value = gbuffer;
    c.uProjInv.value = this.projInv;
    (c.uAoTexel.value as THREE.Vector2).set(1 / rw, 1 / rh);
    c.uAoIntensity.value = s.ao.intensity;
    c.uAoBounce.value = s.ao.bounceStrength;
    c.uSsrIntensity.value = s.ssr.intensity;
    c.uHasAO.value = ao ? 1 : 0;
    c.uHasSSR.value = ssr ? 1 : 0;
    p.composite.render(r, color);
    t?.end();

    /* ---- temporal antialiasing ------------------------------------------ */
    if (s.taa.enabled && this.taa && this.taaHistory) {
      t?.begin('taa');
      const tu = this.taa.uniforms;
      tu.tCurrent.value = color.texture;
      tu.tHistory.value = this.taaHistory.read.texture;
      tu.tDepth.value = depth;
      (tu.uTexel.value as THREE.Vector2).copy(texel);
      (tu.uSize.value as THREE.Vector2).set(rw, rh);
      tu.uProjInv.value = this.projInv;
      tu.uReproject.value = this.reproject;
      tu.uFeedbackStill.value = s.taa.feedbackStill;
      tu.uFeedbackMoving.value = s.taa.feedbackMoving;
      tu.uClipGamma.value = s.taa.varianceClipGamma;
      tu.uValid.value = this.historyValid;
      (tu.uJitter.value as THREE.Vector2).copy(this.jitter);
      this.taa.render(r, this.taaHistory.write);
      color = this.taaHistory.write;
      this.taaHistory.swap();
      t?.end();
    }

    /* ---- motion blur ----------------------------------------------------- */
    if (velocity) {
      t?.begin('motionBlur');
      const tw = Math.max(2, Math.ceil(rw / 20));
      const th = Math.max(2, Math.ceil(rh / 20));
      const tileA = this.pool.acquire(tw, rh, { type: THREE.HalfFloatType });
      const tm = p.tileMax.uniforms;
      tm.tVel.value = velocity.texture;
      (tm.uTexel.value as THREE.Vector2).copy(texel);
      (tm.uDir.value as THREE.Vector2).set(1, 0);
      tm.uSteps.value = 20;
      p.tileMax.render(r, tileA);
      const tileB = this.pool.acquire(tw, th, { type: THREE.HalfFloatType });
      tm.tVel.value = tileA.texture;
      (tm.uDir.value as THREE.Vector2).set(0, 1);
      p.tileMax.render(r, tileB);

      const nb = this.pool.acquire(tw, th, { type: THREE.HalfFloatType });
      const nu = p.neighborMax.uniforms;
      nu.tTile.value = tileB.texture;
      (nu.uTexel.value as THREE.Vector2).set(1 / tw, 1 / th);
      p.neighborMax.render(r, nb);

      const out = this.pool.acquire(rw, rh, { type: THREE.HalfFloatType });
      const mb = p.motionBlur.uniforms;
      mb.tColor.value = color.texture;
      mb.tVel.value = velocity.texture;
      mb.tNeighbor.value = nb.texture;
      (mb.uSize.value as THREE.Vector2).set(rw, rh);
      (mb.uTexel.value as THREE.Vector2).copy(texel);
      mb.uFrame.value = this.frame;
      p.motionBlur.render(r, out);
      color = out;
      t?.end();
    }

    /* ---- depth of field --------------------------------------------------- */
    if (s.dof.enabled) {
      t?.begin('dof');
      const focal = s.dof.focalLengthMm > 0
        ? s.dof.focalLengthMm
        : (s.dof.focusDistance > 0 ? 24 / (2 * Math.tan((cam.fov * Math.PI) / 360)) : 35);
      const hw = Math.max(2, rw >> 1);
      const hh = Math.max(2, rh >> 1);
      const coc = this.pool.acquire(hw, hh, { type: THREE.HalfFloatType });
      const cu = p.dofCoc.uniforms;
      cu.tColor.value = color.texture;
      cu.tDepth.value = depth;
      cu.uProjInv.value = this.projInv;
      (cu.uSrcTexel.value as THREE.Vector2).copy(texel);
      cu.uFocusDistance.value = s.dof.focusDistance > 0 ? s.dof.focusDistance : 60;
      cu.uFocalLength.value = focal;
      cu.uAperture.value = s.dof.fStop;
      cu.uMaxCoC.value = s.dof.maxCoCPixels;
      cu.uImageHeight.value = hh;
      p.dofCoc.render(r, coc);

      const far = this.pool.acquire(hw, hh, { type: THREE.HalfFloatType });
      for (const [pass, dst] of [[p.dofFar, far], [p.dofNear, this.pool.acquire(hw, hh, { type: THREE.HalfFloatType })]] as const) {
        const gu = pass.uniforms;
        gu.tSrc.value = coc.texture;
        (gu.uTexel.value as THREE.Vector2).set(1 / hw, 1 / hh);
        gu.uMaxCoC.value = s.dof.maxCoCPixels;
        gu.uBlades.value = s.dof.blades;
        gu.uCurvature.value = s.dof.bladeCurvature;
        gu.uBokehBias.value = s.dof.bokehBias;
        gu.uFrame.value = this.frame;
        pass.render(r, dst);
        if (pass === p.dofNear) {
          const out = this.pool.acquire(rw, rh, { type: THREE.HalfFloatType });
          const dc = p.dofComposite.uniforms;
          dc.tColor.value = color.texture;
          dc.tFar.value = far.texture;
          dc.tNear.value = dst.texture;
          dc.tDepth.value = depth;
          dc.uProjInv.value = this.projInv;
          dc.uFocusDistance.value = cu.uFocusDistance.value;
          dc.uFocalLength.value = focal;
          dc.uAperture.value = s.dof.fStop;
          dc.uMaxCoC.value = s.dof.maxCoCPixels * 2;
          dc.uImageHeight.value = rh;
          p.dofComposite.render(r, out);
          color = out;
        }
      }
      t?.end();
    }

    /* ---- bloom ------------------------------------------------------------ */
    let bloomTex: THREE.Texture | null = null;
    let streakTex: THREE.Texture | null = null;
    if (s.bloom.enabled && this.bloomChain.length) {
      t?.begin('bloom');
      const pre = p.bloomPrefilter.uniforms;
      pre.tSrc.value = color.texture;
      (pre.uTexel.value as THREE.Vector2).copy(texel);
      pre.uThreshold.value = s.bloom.threshold;
      pre.uKnee.value = s.bloom.knee;
      p.bloomPrefilter.render(r, this.bloomChain[0]);

      for (let i = 1; i < this.bloomChain.length; i++) {
        const du = p.bloomDown.uniforms;
        du.tSrc.value = this.bloomChain[i - 1].texture;
        (du.uTexel.value as THREE.Vector2).set(
          1 / this.bloomChain[i - 1].width, 1 / this.bloomChain[i - 1].height);
        p.bloomDown.render(r, this.bloomChain[i]);
      }
      // Additive up-sweep back through the pyramid.
      p.bloomUp.setBlending(THREE.CustomBlending, THREE.OneFactor, THREE.OneFactor);
      for (let i = this.bloomChain.length - 1; i > 0; i--) {
        const uu = p.bloomUp.uniforms;
        uu.tSrc.value = this.bloomChain[i].texture;
        (uu.uTexel.value as THREE.Vector2).set(
          1 / this.bloomChain[i].width, 1 / this.bloomChain[i].height);
        uu.uRadius.value = 1;
        uu.uSpread.value = s.bloom.spread;
        p.bloomUp.render(r, this.bloomChain[i - 1]);
      }
      p.bloomUp.setBlending(THREE.NoBlending);
      bloomTex = this.bloomChain[0].texture;

      if (s.bloom.streak > 0.001) {
        const lvl = this.bloomChain[Math.min(2, this.bloomChain.length - 1)];
        const sa = this.pool.acquire(lvl.width, lvl.height, { type: THREE.HalfFloatType });
        const st = p.streak.uniforms;
        st.tSrc.value = lvl.texture;
        (st.uTexel.value as THREE.Vector2).set(1 / lvl.width, 1 / lvl.height);
        (st.uDir.value as THREE.Vector2).set(1, 0);
        st.uStride.value = 1;
        p.streak.render(r, sa);
        streakTex = sa.texture;
      }
      t?.end();
    }

    /* ---- auto exposure ---------------------------------------------------- */
    let exposureTex: THREE.Texture | null = null;
    if (s.exposure.enabled && this.lumHistory) {
      t?.begin('exposure');
      let lw = 64;
      let lh = 64;
      const seed = this.pool.acquire(lw, lh, { type: THREE.FloatType, filter: THREE.NearestFilter });
      const ls = p.lumSeed.uniforms;
      ls.tColor.value = color.texture;
      (ls.uSrcTexel.value as THREE.Vector2).copy(texel);
      ls.uMinLum.value = s.exposure.minLuminance;
      ls.uMaxLum.value = s.exposure.maxLuminance;
      ls.uCenterWeight.value = s.exposure.centerWeight;
      p.lumSeed.render(r, seed);

      let src = seed;
      while (lw > 1) {
        const nw = Math.max(1, lw >> 2);
        const nh = Math.max(1, lh >> 2);
        const dst = this.pool.acquire(nw, nh, { type: THREE.FloatType, filter: THREE.NearestFilter });
        const lr = p.lumReduce.uniforms;
        lr.tSrc.value = src.texture;
        (lr.uSrcTexel.value as THREE.Vector2).set(1 / lw, 1 / lh);
        lr.uTaps.value = 4;
        p.lumReduce.render(r, dst);
        src = dst;
        lw = nw;
        lh = nh;
      }

      const au = p.adapt.uniforms;
      au.tReduced.value = src.texture;
      au.tPrev.value = this.lumHistory.read.texture;
      au.uDt.value = Math.min(dt, 0.1);
      au.uSpeedUp.value = s.exposure.speedUp;
      au.uSpeedDown.value = s.exposure.speedDown;
      au.uKey.value = s.exposure.keyValue;
      au.uCompensation.value = s.exposure.compensation;
      au.uMinLum.value = s.exposure.minLuminance;
      au.uMaxLum.value = s.exposure.maxLuminance;
      au.uValid.value = this.historyValid;
      p.adapt.render(r, this.lumHistory.write);
      exposureTex = this.lumHistory.write.texture;
      this.lumHistory.swap();
      t?.end();
    }

    /* ---- grade: tonemap, bloom, lens, sRGB -------------------------------- */
    t?.begin('grade');
    const g = s.grade;
    const gu = p.grade.uniforms;
    gu.tColor.value = color.texture;
    gu.tBloom.value = bloomTex;
    gu.tStreak.value = streakTex;
    gu.tExposure.value = exposureTex;
    (gu.uTexel.value as THREE.Vector2).copy(texel);
    gu.uAspect.value = rw / rh;
    // The sky publishes its own exposure on the renderer; the grade applies it
    // since the renderer's tonemapper is off while the chain is up.
    gu.uExposureBase.value = r.toneMappingExposure;
    gu.uAutoStrength.value = exposureTex ? s.exposure.strength : 0;
    gu.uBloomIntensity.value = s.bloom.enabled ? s.bloom.intensity : 0;
    gu.uStreakIntensity.value = streakTex ? s.bloom.streak : 0;
    (gu.uStreakTint.value as THREE.Vector3).fromArray(s.bloom.streakTint);
    gu.uHalation.value = s.lens.halation ? s.lens.halationStrength : 0;
    gu.uCA.value = s.lens.chromaticAberration ? s.lens.chromaticStrength : 0;
    gu.uVignette.value = s.lens.vignette ? s.lens.vignetteStrength : 0;
    gu.uVignetteRoundness.value = s.lens.vignetteRoundness;
    gu.uGrain.value = s.lens.grain ? s.lens.grainStrength : 0;
    gu.uGrainShadowBias.value = s.lens.grainShadowBias;
    gu.uTime.value = ctx.elapsed;
    gu.uWhitePoint.value = g.whitePoint;
    gu.uContrast.value = g.contrast;
    gu.uContrastPivot.value = g.contrastPivot;
    gu.uSaturation.value = g.saturation;
    gu.uTemperature.value = g.temperature;
    gu.uTint.value = g.tint;
    (gu.uLift.value as THREE.Vector3).fromArray(g.curve.lift);
    (gu.uGamma.value as THREE.Vector3).fromArray(g.curve.gamma);
    (gu.uGain.value as THREE.Vector3).fromArray(g.curve.gain);
    (gu.uShadowTint.value as THREE.Vector3).fromArray(g.shadowTint);
    (gu.uHighlightTint.value as THREE.Vector3).fromArray(g.highlightTint);
    gu.uSplitBalance.value = g.splitToneBalance;
    gu.uLutStrength.value = 0;
    p.grade.setDefine('TONEMAP_MODE', g.tonemap === 'agx' ? 2 : g.tonemap === 'none' ? 0 : 1);
    p.grade.setDefine('USE_BLOOM', bloomTex ? 1 : undefined);
    p.grade.setDefine('USE_STREAK', streakTex ? 1 : undefined);
    p.grade.setDefine('USE_CA', s.lens.chromaticAberration ? 1 : undefined);
    p.grade.setDefine('USE_VIGNETTE', s.lens.vignette ? 1 : undefined);
    p.grade.setDefine('USE_GRAIN', s.lens.grain ? 1 : undefined);
    p.grade.setDefine('USE_DITHER', s.dither ? 1 : undefined);

    const upscaling = this.rw !== this.width || this.rh !== this.height;
    const graded = upscaling ? this.pool.acquire(rw, rh, { type: THREE.HalfFloatType }) : null;
    p.grade.render(r, graded);
    t?.end();

    /* ---- upscale ---------------------------------------------------------- */
    if (upscaling && graded) {
      t?.begin('upscale');
      const eu = p.easu.uniforms;
      eu.tSrc.value = graded.texture;
      (eu.uInputSize.value as THREE.Vector2).set(rw, rh);
      (eu.uOutputSize.value as THREE.Vector2).set(this.width, this.height);
      const sharp = this.pool.acquire(this.width, this.height, { type: THREE.HalfFloatType });
      p.easu.render(r, sharp);
      const ru = p.rcas.uniforms;
      ru.tSrc.value = sharp.texture;
      (ru.uTexel.value as THREE.Vector2).set(1 / this.width, 1 / this.height);
      ru.uSharpness.value = s.upscaleSharpness;
      p.rcas.render(r, null);
      t?.end();
    }

    /* ---- bookkeeping ------------------------------------------------------ */
    this.prevProj.copy(this.unjittered);
    this.prevView.copy(cam.matrixWorldInverse);
    this.historyValid = 1;
    this.frame++;
    t?.collect();

    if (s.profile && t) {
      for (const [label, ms] of t.ms) ctx.stats[`post.${label}`] = `${ms.toFixed(2)}ms`;
      const total = t.total(['scene']);
      if (total > 0) ctx.stats['post.total'] = `${total.toFixed(2)}ms`;
    }

    // Restore the unjittered projection so anything reading the camera between
    // frames (picking, the HUD's frustum, the QA harness) sees the true one.
    cam.projectionMatrix.copy(this.unjittered);
    cam.projectionMatrixInverse.copy(this.unjittered).invert();
  }

  dispose(ctx: Ctx): void {
    if (this.app) this.app.renderOverride = null;
    ctx.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    disposeRT(this.rt.scene);
    disposeRT(this.rt.gbuffer);
    for (const rt of this.bloomChain) disposeRT(rt);
    this.taaHistory?.dispose();
    this.aoHistory?.dispose();
    this.lumHistory?.dispose();
    this.pool.dispose();
    for (const pass of Object.values(this.passes)) pass.dispose();
    this.taa?.dispose();
    this.gbufferMat?.dispose();
  }
}
