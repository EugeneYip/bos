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
    probe(opts) {
      if (opts?.shadows !== undefined) {
        ctx.renderer.shadowMap.enabled = opts.shadows;
        ctx.scene.traverse((o) => {
          const l = o as THREE.DirectionalLight;
          if (l.isDirectionalLight) l.castShadow = opts.shadows!;
        });
      }
      return {
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
}
