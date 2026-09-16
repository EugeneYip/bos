import * as THREE from 'three';
import type { App } from './App';

/**
 * Deterministic control surface used by the automated visual-QA harness
 * (`qa/shoot.mjs`) and by anyone debugging from the console. Kept tiny and
 * stable: the QA harness and the review agents depend on these exact names.
 */
export interface DebugApi {
  /** Park the camera at an absolute world position looking at a target. */
  setView(pos: [number, number, number], target: [number, number, number]): void;
  /** Jump to a named viewpoint from qa/viewpoints.json semantics. */
  setTime(hour: number, dayOfYear?: number): void;
  /** Wait until N frames have been rendered since the call. */
  settle(frames?: number): Promise<void>;
  stats(): Record<string, number | string>;
  setQuality(tier: 'low' | 'medium' | 'high' | 'ultra'): void;
  /**
   * Show or hide every object whose name contains `match`, and return how many
   * were touched. Deciding which module owns a suspect pixel is otherwise a
   * rebuild-and-look loop, and a wrong guess there costs a quarter of an hour.
   */
  toggle(match: string, visible: boolean): number;
  /**
   * The handful of numbers that explain why a frame came out the brightness it
   * did: exposure, the key light, and whether image-based lighting is actually
   * bound. `shadows: false` turns off shadow casting, which reads out the
   * sun-to-sky ratio directly — a shadowed surface that barely changes is not
   * being shadowed, it is receiving no ambient.
   */
  probe(opts?: { shadows?: boolean }): Record<string, number | boolean>;
  /**
   * What is under this screen pixel?
   *
   * `toggle` is the wrong tool for attributing a pixel and has misled me three
   * times: it is silently defeated by any module that writes `visible` in its
   * own update (CDLOD's terrain patches, and the water module's reflection
   * pass, which keeps running with every water mesh hidden). Diffing two
   * screenshots is worse -- the city animates and the post chain is
   * stochastic, so two frames differ everywhere.
   *
   * This raycasts instead, and reports the names of what it hits, nearest
   * first, with distances. `x` and `y` are CSS pixels from the top-left.
   */
  pick(x: number, y: number, max?: number): Array<{ name: string; dist: number; material: string }>;
  /**
   * One-shot report of everything that could differ between two machines.
   *
   * Exists because a render can be correct here and wrong on someone else's
   * GPU, and the fastest way through that is their numbers rather than my
   * guesses. Auto-runs and prints when the page is loaded with `?diag=1`.
   */
  diag(): Record<string, unknown>;
  /**
   * What the vehicles are doing: how many, how fast, and which edges are
   * carrying an implausible number of them. 'Full of traffic' is a report
   * this project keeps getting and a still frame cannot distinguish a queue
   * at a light from a permanent deadlock.
   */
  traffic(): Record<string, number | string>;
}

export function installDebugApi(app: App): void {
  const { ctx } = app;
  let frames = 0;
  const origOverride = app.renderOverride;
  void origOverride;

  // Count frames independently of any module so `settle` is always accurate.
  const countFrames = { name: 'FrameCounter', update: () => { frames++; } };
  (app as unknown as { modules: unknown[] }).modules?.push?.(countFrames);

  const api: DebugApi = {
    setView(pos, target) {
      ctx.emit('debug-set-view', { pos, target });
      ctx.camera.position.set(pos[0], pos[1], pos[2]);
      ctx.camera.lookAt(new THREE.Vector3(target[0], target[1], target[2]));
      ctx.camera.updateMatrixWorld(true);

      // Say so when the pose is on or under the deck.
      //
      // `setView` deliberately bypasses the rig, and the rig is the thing that
      // clamps the camera above the ground -- orbit slides along the terrain,
      // fly holds 1.6 m. So a QA pose can sit below the surface, and then the
      // lower part of the frame looks *underneath* the world, where there is no
      // geometry, and fills with the clear colour. That reads as a large flat
      // untextured region exactly matching the fog colour, it survives every
      // layer toggle, and `pick` returns nothing for it -- which is a very
      // convincing impression of a terrain or water bug. It cost a long
      // investigation once; a pose 17 cm above the Common's grass was all it
      // was.
      const g = ctx.sampleHeight?.(pos[0], pos[2]);
      if (Number.isFinite(g)) {
        const agl = pos[1] - (g as number);
        if (agl < 1.2) {
          console.warn(
            `[debug] setView is ${agl.toFixed(2)} m above ground (${(g as number).toFixed(2)} m) `
            + 'at this position: the frame will show the void under the world. '
            + 'Raise the camera.',
          );
        }
      }
    },
    setTime(hour, dayOfYear) {
      ctx.timeOfDay = hour;
      if (dayOfYear !== undefined) ctx.dayOfYear = dayOfYear;
      ctx.emit('time-changed', hour);
    },
    settle(n = 12) {
      const start = frames;
      return new Promise<void>((resolve) => {
        const check = () => (frames - start >= n ? resolve() : requestAnimationFrame(check));
        check();
      });
    },
    stats: () => ({ ...ctx.stats }),
    setQuality: (tier) => app.setQuality(tier),
    toggle(match, visible) {
      let n = 0;
      ctx.scene.traverse((o) => {
        if (o.name.includes(match)) { o.visible = visible; n++; }
      });
      return n;
    },
    pick(x, y, max = 6) {
      const el = ctx.renderer.domElement;
      const ndc = new THREE.Vector2(
        (x / el.clientWidth) * 2 - 1,
        -(y / el.clientHeight) * 2 + 1,
      );
      const ray = new THREE.Raycaster();
      // The city spans tens of kilometres, so the default 0..Infinity is fine
      // but the precision is not: nudge the near plane off the camera.
      ray.near = 0.1;
      ray.far = 40000;
      ray.setFromCamera(ndc, ctx.camera);
      ctx.camera.updateMatrixWorld(true);
      const hits = ray.intersectObject(ctx.scene, true);
      const out: Array<{ name: string; dist: number; material: string }> = [];
      for (const h of hits) {
        const o = h.object as THREE.Mesh;
        let name = o.name;
        if (!name) {
          for (let p: THREE.Object3D | null = o.parent; p; p = p.parent) {
            if (p.name) { name = `${p.name} (child)`; break; }
          }
        }
        const m = Array.isArray(o.material) ? o.material[0] : o.material;
        out.push({ name: name || '(unnamed)', dist: Math.round(h.distance),
          material: (m as THREE.Material | undefined)?.name ?? '(none)' });
        if (out.length >= max) break;
      }
      return out;
    },
    traffic() {
      const m = app.get('Traffic') as unknown as
        { report?: () => Record<string, number | string> } | undefined;
      return m?.report?.() ?? { error: 'Traffic module has no report()' };
    },
    diag() {
      const r = ctx.renderer;
      const gl = r.getContext() as WebGL2RenderingContext;
      const dbg = gl.getExtension('WEBGL_debug_renderer_info');
      const ext = (n: string): boolean => !!gl.getExtension(n);
      const mat = (() => {
        let m: THREE.ShaderMaterial | null = null;
        ctx.scene.traverse((o) => {
          const mm = (o as THREE.Mesh).material as THREE.ShaderMaterial | undefined;
          if (!m && (o.name || '').startsWith('water:chunk') && mm?.isShaderMaterial) m = mm;
        });
        return m;
      })();
      const envTex = ctx.envMap as THREE.Texture | null;
      const out: Record<string, unknown> = {
        gpu: dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : 'unknown',
        tier: ctx.tier,
        pixelRatio: r.getPixelRatio(),
        drawingBuffer: [r.domElement.width, r.domElement.height],
        // The float formats the post chain depends on. RGBA32F in particular is
        // renderable on some drivers and not others, and the luminance history
        // that auto-exposure carries across frames is the one target that asks
        // for it.
        colorBufferFloat: ext('EXT_color_buffer_float'),
        colorBufferHalfFloat: ext('EXT_color_buffer_half_float'),
        textureFloatLinear: ext('OES_texture_float_linear'),
        textureHalfFloatLinear: ext('OES_texture_half_float_linear'),
        floatBlend: ext('EXT_float_blend'),
        timerQuery: ext('EXT_disjoint_timer_query_webgl2'),
        maxTextureSize: gl.getParameter(gl.MAX_TEXTURE_SIZE),
        // Presentation. If these look sane and the image does not, the fault is
        // upstream of the grade.
        exposure: +ctx.exposure.toFixed(4),
        toneMappingExposure: +r.toneMappingExposure.toFixed(4),
        toneMapping: r.toneMapping,
        environmentIntensity: ctx.scene.environmentIntensity,
        envBound: !!envTex,
        envType: envTex?.type ?? null,
        envMapping: envTex?.mapping ?? null,
        envSize: envTex?.image ? [envTex.image.width, envTex.image.height] : null,
        sunIntensity: +ctx.sun.intensity.toFixed(4),
        sunElevation: +ctx.sun.elevation.toFixed(4),
        // The water's own inputs, since that is what looks wrong.
        water: mat ? {
          envIntensity: (mat as THREE.ShaderMaterial).uniforms.uEnvIntensity?.value,
          reflStrength: (mat as THREE.ShaderMaterial).uniforms.uReflStrength?.value,
          reflMaxLod: (mat as THREE.ShaderMaterial).uniforms.uReflMaxLod?.value,
          reflBound: !!(mat as THREE.ShaderMaterial).uniforms.uReflMap?.value,
          skyViewBound: !!(mat as THREE.ShaderMaterial).uniforms.uApSkyView?.value,
          defines: Object.keys((mat as THREE.ShaderMaterial).defines ?? {}),
        } : null,
        stats: { ...ctx.stats },
      };
      console.info('[diag]', JSON.stringify(out));
      return out;
    },
    probe(opts) {
      if (opts?.shadows !== undefined) {
        ctx.renderer.shadowMap.enabled = opts.shadows;
        ctx.scene.traverse((o) => {
          const l = o as THREE.DirectionalLight;
          if (l.isDirectionalLight) l.castShadow = opts.shadows!;
        });
      }
      return {
        agl: (() => {
          const g = ctx.sampleHeight?.(ctx.camera.position.x, ctx.camera.position.z);
          return Number.isFinite(g) ? +(ctx.camera.position.y - (g as number)).toFixed(2) : -1;
        })(),
        exposure: ctx.exposure,
        exposureBase: ctx.renderer.toneMappingExposure,
        sunIntensity: ctx.sun.intensity,
        sunElevation: ctx.sun.elevation,
        envBound: ctx.scene.environment !== null,
        environmentIntensity: ctx.scene.environmentIntensity,
        aerialBound: ctx.aerial !== null,
        shadowsOn: ctx.renderer.shadowMap.enabled,
      };
    },
  };

  (window as unknown as Record<string, unknown>).__debug = api;

  // `?diag=1` prints the report once the city is up, so a bug that only
  // reproduces on someone else's GPU can be reported with numbers.
  if (new URLSearchParams(location.search).get('diag') === '1') {
    const waitReady = (): void => {
      if ((window as unknown as { __ready?: boolean }).__ready) api.diag();
      else setTimeout(waitReady, 500);
    };
    waitReady();
  }
}
