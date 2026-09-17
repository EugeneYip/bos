import * as THREE from 'three';
import { QUALITY, RENDER, type QualityTier } from './config';
import type { Ctx, WorldModule } from './Context';
import { detectTier, gpuName, MOBILE } from './gpu';
import { safeRead, safeStore } from '../ui/dom';

export class App {
  readonly ctx: Ctx;
  private modules: WorldModule[] = [];
  private listeners = new Map<string, Array<(p?: unknown) => void>>();
  private running = false;
  private lastTime = 0;
  private frameHandle = 0;
  /** Set by the post-processing module to take over presentation. */
  renderOverride: ((dt: number) => void) | null = null;

  /**
   * What the GPU probe picked at boot, whatever the user has since chosen.
   * The settings panel reports this, and a hint that silently rewrote itself to
   * agree with the last click would be worse than no hint.
   */
  readonly detectedTier: QualityTier;
  /** What the GPU probe actually read, for the settings panel to report. */
  readonly gpu: string;

  /**
   * Pixels rendered per CSS pixel, or `null` to follow the quality tier's cap.
   *
   * This is the sharpness of the image and nothing else, and it is separate
   * from the tier on purpose. The tier caps it — `low` allows 1.0, so on a
   * Retina display the frame was being drawn at a quarter of the panel's pixels
   * and then stretched over it, and the post chain's own 0.72 upscale on top of
   * that took it to about a seventh. Plenty of machines that cannot afford
   * four shadow cascades can afford their own screen's resolution.
   */
  private resolution: number | null = null;
  /** One second of frame times at 60 Hz, for a frame rate that means something. */
  private frameTimes = new Float32Array(60);
  private frameCursor = 0;

  constructor(readonly canvas: HTMLCanvasElement, tierOverride?: QualityTier) {
    const renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: false, // handled by the post pipeline (TAA/SMAA)
      alpha: false,
      powerPreference: 'high-performance',
      stencil: false,
      depth: true,
      logarithmicDepthBuffer: false,
    });

    this.gpu = gpuName(renderer);
    this.detectedTier = detectTier(renderer);
    // A remembered choice beats the probe, and an explicit `?q=` beats both.
    // Without this the probe re-ran on every reload, so a machine that measures
    // as `low` would answer every deliberate upgrade by forgetting it — which
    // looks exactly like a control that does not work.
    const stored = safeRead('bh-tier');
    const remembered = stored && stored in QUALITY ? (stored as QualityTier) : undefined;
    const tier = tierOverride ?? remembered ?? this.detectedTier;
    const quality = QUALITY[tier];

    const storedRes = Number(safeRead('bh-res'));
    if (storedRes >= 0.4 && storedRes <= 4) this.resolution = storedRes;
    renderer.setPixelRatio(this.pixelRatioFor(quality.maxPixelRatio));
    renderer.setSize(window.innerWidth, window.innerHeight, false);
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = RENDER.exposure;
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    renderer.shadowMap.autoUpdate = true;
    renderer.info.autoReset = false;

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(
      RENDER.fov,
      window.innerWidth / window.innerHeight,
      RENDER.near,
      RENDER.far,
    );
    camera.position.set(-420, 260, 520);
    camera.lookAt(0, 40, 0);

    this.ctx = {
      scene,
      camera,
      renderer,
      clock: new THREE.Clock(),
      tier,
      quality,
      elapsed: 0,
      timeOfDay: 17.1,
      dayOfYear: 262,
      sun: {
        direction: new THREE.Vector3(0.4, 0.5, 0.76).normalize(),
        color: new THREE.Color(1, 0.95, 0.88),
        intensity: 1,
        elevation: 0.52,
        azimuth: 4.1,
      },
      sampleHeight: () => 0,
      envMap: null,
      aerial: null,
      exposure: RENDER.exposure,
      resolution: 1,
      lampField: null,
      // Replaced by the Materials module during init; this stub keeps the app
      // bootable if Materials ever fails so the rest of the scene still shows.
      materials: {
        textures: () => undefined,
        get: () => new THREE.MeshStandardMaterial({ color: 0x9a9a92, roughness: 0.9 }),
        register: () => {},
      },
      stats: {},
      on: (evt, fn) => {
        const arr = this.listeners.get(evt) ?? [];
        arr.push(fn);
        this.listeners.set(evt, arr);
      },
      emit: (evt, payload) => {
        for (const fn of this.listeners.get(evt) ?? []) fn(payload);
      },
    };

    window.addEventListener('resize', this.onResize);
    this.installContextHandlers();
  }

  /**
   * Drop the CPU-side copy of static geometry attributes once the GPU has
   * them.
   *
   * three.js keeps `attribute.array` alive after uploading it, and this scene
   * has 1,580 geometries holding 386 MB of them. That is not a rounding error
   * against a ~900 MB heap, and on iOS Safari it is the difference between
   * running and being killed: a visitor on an iPad reported the page looping
   * on the loading screen, succeeding for about a second, then starting over,
   * which is that tab's out-of-memory reload. The quality tier does not help
   * -- `low` still builds every building and every road, and measures 846 MB
   * against high's 900.
   *
   * On a desktop `position` and the index stay, so `__debug.pick` keeps
   * working; that alone takes 386 MB to 221. On a phone or tablet they go
   * too, once the bounding sphere has been computed from them -- nothing in
   * the runtime raycasts, `Raycaster` appears only in the debug API, and a
   * diagnostic that cannot run on a device that cannot load the page is not
   * worth 165 MB.
   *
   * The reason not to do this would be context restore, which re-uploads from
   * exactly these arrays -- but that path was never going to work here anyway.
   * Everything baked once into a render target at boot is gone with the
   * context, so a restore lands in a world with no atmosphere LUTs and no
   * material atlases, which is why `onContextLost` asks for a reload.
   *
   * Dynamic and instanced attributes are left alone: the cars rewrite their
   * roll, steer and brake streams every frame.
   */
  private releaseStaticAttributes(): void {
    const seen = this.releasedGeoms;
    this.ctx.scene.traverse((o) => {
      const g = (o as THREE.Mesh).geometry;
      if (!g || seen.has(g)) return;
      seen.add(g);
      // Frustum culling computes this lazily, and it needs positions. Force
      // it now, while they are still here.
      if (!g.boundingSphere) g.computeBoundingSphere();
      if (MOBILE && g.index && g.index.array && g.index.usage === THREE.StaticDrawUsage) {
        g.index.onUpload(function onUploaded(this: THREE.BufferAttribute) {
          (this as unknown as { array: unknown }).array = null;
        });
      }
      for (const name in g.attributes) {
        if (name === 'position' && !MOBILE) continue;
        const a = g.attributes[name] as THREE.BufferAttribute;
        if (!a || !a.array) continue;
        if ((a as unknown as { isInstancedBufferAttribute?: boolean }).isInstancedBufferAttribute) continue;
        if (a.usage !== THREE.StaticDrawUsage) continue;
        a.onUpload(function onUploaded(this: THREE.BufferAttribute) {
          (this as unknown as { array: unknown }).array = null;
        });
      }
    });
  }

  private releasedGeoms = new WeakSet<THREE.BufferGeometry>();
  private releaseCountdown = 0;

  /** Modules initialise in registration order, so declare dependencies first. */
  add(...mods: WorldModule[]): this {
    this.modules.push(...mods);
    return this;
  }

  get<T extends WorldModule>(name: string): T | undefined {
    return this.modules.find((m) => m.name === name) as T | undefined;
  }

  async init(onProgress?: (label: string, frac: number) => void): Promise<void> {
    for (let i = 0; i < this.modules.length; i++) {
      const m = this.modules[i];
      onProgress?.(m.name, i / this.modules.length);
      // Yield to the browser so the loading screen can actually paint.
      await new Promise((r) => requestAnimationFrame(r));
      try {
        await m.init?.(this.ctx);
      } catch (err) {
        console.error(`[${m.name}] init failed`, err);
      }
    }
    onProgress?.('ready', 1);
    this.onResize();
  }

  /**
   * Called when the GPU takes the WebGL context away, with a short reason.
   *
   * There was no handler at all until a visitor reported the site 'kept
   * jumping out'. A lost context does not throw and does not stop
   * `requestAnimationFrame` -- every draw call simply becomes a no-op, so the
   * canvas freezes on its last frame or goes black and the page sits there
   * looking broken with nothing in the console. Safari drops the context
   * readily under memory pressure, and this scene asks for a lot: about
   * 900 MB of JS heap, 386 MB of which is the CPU-side copy three.js keeps of
   * every geometry attribute.
   */
  onContextLost: ((restorable: boolean) => void) | null = null;
  private contextLost = false;

  /** Whether the GPU context is currently gone. */
  get lost(): boolean {
    return this.contextLost;
  }

  private installContextHandlers(): void {
    this.canvas.addEventListener('webglcontextlost', (e) => {
      // Without preventDefault the browser will not even try to restore it.
      e.preventDefault();
      this.contextLost = true;
      this.stop();
      console.error('[App] WebGL context lost');
      this.onContextLost?.(true);
    });
    this.canvas.addEventListener('webglcontextrestored', () => {
      // three.js re-uploads geometry and textures from their CPU copies, but
      // everything baked once into a render target at boot -- the atmosphere
      // LUTs, the terrain's surface array, the material atlases -- is gone,
      // and re-running that is a bigger job than it looks. Say so plainly
      // rather than resume into a half-built world.
      console.warn('[App] WebGL context restored; a reload is needed to rebuild the baked targets');
      this.onContextLost?.(false);
    });
  }

  start(): void {
    if (this.contextLost) return;
    if (this.running) return;
    this.running = true;
    this.ctx.clock.start();
    this.lastTime = performance.now();
    this.frameHandle = requestAnimationFrame(this.tick);
  }

  stop(): void {
    this.running = false;
    cancelAnimationFrame(this.frameHandle);
  }

  private moduleMs = new Map<string, number>();
  private moduleWorst = new Map<string, number>();
  private cpuUpdate = 0;
  private cpuRender = 0;
  private cpuWorstUpdate = 0;

  private tick = (now: number): void => {
    if (!this.running) return;
    this.frameHandle = requestAnimationFrame(this.tick);

    // Clamp dt so a background tab or a hitch doesn't teleport the simulation.
    const dt = Math.min((now - this.lastTime) / 1000, 0.1);
    this.lastTime = now;
    this.ctx.elapsed += dt;

    const { renderer } = this.ctx;
    renderer.info.reset();

    // Buildings and roads stream in for a long while after boot, so this
    // cannot be a one-shot at startup. The callback has to be attached before
    // the attribute's first upload, and a sweep of ~1,600 geometries every
    // two seconds costs nothing measurable.
    if (--this.releaseCountdown <= 0) {
      this.releaseCountdown = 120;
      this.releaseStaticAttributes();
    }

    // Two wall-clock spans, which is the one kind of timing this project can
    // still trust. Every per-pass GPU timer here reports a number larger than
    // the frame containing it -- three modules each run their own
    // TIME_ELAPSED query and WebGL2 allows exactly one in flight -- so the
    // split that matters is measured on the CPU, where the clock is honest:
    // how long the modules take to think, and how long the driver takes to
    // accept the frame. Anything left over is the GPU actually working.
    const tu = performance.now();
    for (const m of this.modules) {
      const t0 = performance.now();
      try {
        m.update?.(dt, this.ctx);
      } catch (err) {
        console.error(`[${m.name}] update failed`, err);
        m.update = undefined; // don't spam every frame
      }
      // Per-module, so 'the modules are slow' can name one. Reported only
      // above a third of a millisecond, or fifteen names drown the stats.
      const el = performance.now() - t0;
      const prev = this.moduleMs.get(m.name) ?? 0;
      const ema = prev * 0.9 + el * 0.1;
      this.moduleMs.set(m.name, ema);
      if (ema >= 0.3) this.ctx.stats[`cpu.${m.name}`] = Math.round(ema * 100) / 100;
      else delete this.ctx.stats[`cpu.${m.name}`];

      // And the worst frame each has ever had. The mean is the wrong statistic
      // for work that only happens when something streams: `fps.low` sits at
      // 10 at every viewpoint in the project, day and night, parked or moving,
      // which is a ~100 ms stall arriving regularly. An exponential average
      // reads about zero through that, so a high-water mark is kept per
      // module and only the ones that have actually stalled are reported.
      if (el > (this.moduleWorst.get(m.name) ?? 0)) {
        this.moduleWorst.set(m.name, el);
        if (el >= 4) this.ctx.stats[`worst.${m.name}`] = Math.round(el * 10) / 10;
      }
    }
    const tr = performance.now();

    if (this.renderOverride) this.renderOverride(dt);
    else renderer.render(this.ctx.scene, this.ctx.camera);
    const te = performance.now();

    this.cpuUpdate = this.cpuUpdate * 0.9 + (tr - tu) * 0.1;
    this.cpuRender = this.cpuRender * 0.9 + (te - tr) * 0.1;
    this.cpuWorstUpdate = Math.max(this.cpuWorstUpdate, tr - tu);
    this.ctx.stats['cpu.update'] = Math.round(this.cpuUpdate * 100) / 100;
    this.ctx.stats['cpu.submit'] = Math.round(this.cpuRender * 100) / 100;
    this.ctx.stats['cpu.update.worst'] = Math.round(this.cpuWorstUpdate * 10) / 10;

    // A single frame's reciprocal is not a frame rate. Reported raw, this stat
    // gave 10 and 60 for the same viewpoint on consecutive runs and sent me
    // chasing performance regressions that were not there. Track the mean and
    // the worst of a rolling second instead: `fps` is what it feels like, and
    // `fps.low` is the hitch you actually notice.
    const f = this.frameTimes;
    f[this.frameCursor++ % f.length] = Math.max(dt, 1e-4);
    const n = Math.min(this.frameCursor, f.length);
    let sum = 0;
    let worst = 0;
    for (let i = 0; i < n; i++) { sum += f[i]; if (f[i] > worst) worst = f[i]; }
    this.ctx.stats.fps = Math.round(n / sum);
    this.ctx.stats['fps.low'] = Math.round(1 / worst);
    this.ctx.stats.calls = renderer.info.render.calls;
    this.ctx.stats.tris = renderer.info.render.triangles;
  };

  /** Pixels per CSS pixel, honouring a user override over the tier's cap. */
  private pixelRatioFor(cap: number): number {
    const dpr = window.devicePixelRatio || 1;
    return this.resolution !== null
      ? Math.max(0.4, Math.min(this.resolution, 4))
      : Math.min(dpr, cap);
  }

  setQuality(tier: QualityTier): void {
    this.ctx.tier = tier;
    this.ctx.quality = QUALITY[tier];
    this.ctx.renderer.setPixelRatio(this.pixelRatioFor(QUALITY[tier].maxPixelRatio));
    safeStore('bh-tier', tier);
    this.onResize();
    this.ctx.emit('quality-changed', tier);
  }

  /**
   * Sets pixels rendered per CSS pixel. `null` hands the decision back to the
   * quality tier.
   */
  setResolution(scale: number | null): void {
    this.resolution = scale;
    if (scale === null) safeStore('bh-res', '');
    else safeStore('bh-res', String(scale));
    this.ctx.renderer.setPixelRatio(this.pixelRatioFor(this.ctx.quality.maxPixelRatio));
    this.ctx.resolution = this.ctx.renderer.getPixelRatio();
    this.onResize();
    // The post chain renders at a fraction of this again on the lower tiers;
    // asking for a resolution explicitly should not then be undercut by it.
    this.ctx.emit('resolution-changed', scale);
  }

  /** Pixels per CSS pixel currently in force, and whether the user chose it. */
  get resolutionState(): { ratio: number; explicit: boolean; dpr: number } {
    return {
      ratio: this.ctx.renderer.getPixelRatio(),
      explicit: this.resolution !== null,
      dpr: window.devicePixelRatio || 1,
    };
  }

  private onResize = (): void => {
    const w = window.innerWidth;
    const h = window.innerHeight;
    this.ctx.camera.aspect = w / h;
    this.ctx.camera.updateProjectionMatrix();
    this.ctx.renderer.setSize(w, h, false);
    for (const m of this.modules) m.resize?.(w, h, this.ctx);
  };

  dispose(): void {
    this.stop();
    window.removeEventListener('resize', this.onResize);
    for (const m of this.modules) m.dispose?.(this.ctx);
    this.ctx.renderer.dispose();
  }
}
