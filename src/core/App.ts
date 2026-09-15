import * as THREE from 'three';
import { QUALITY, RENDER, type QualityTier } from './config';
import type { Ctx, WorldModule } from './Context';
import { detectTier, gpuName } from './gpu';
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
  }

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

  start(): void {
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

  private tick = (now: number): void => {
    if (!this.running) return;
    this.frameHandle = requestAnimationFrame(this.tick);

    // Clamp dt so a background tab or a hitch doesn't teleport the simulation.
    const dt = Math.min((now - this.lastTime) / 1000, 0.1);
    this.lastTime = now;
    this.ctx.elapsed += dt;

    const { renderer } = this.ctx;
    renderer.info.reset();

    for (const m of this.modules) {
      try {
        m.update?.(dt, this.ctx);
      } catch (err) {
        console.error(`[${m.name}] update failed`, err);
        m.update = undefined; // don't spam every frame
      }
    }

    if (this.renderOverride) this.renderOverride(dt);
    else renderer.render(this.ctx.scene, this.ctx.camera);

    this.ctx.stats.fps = Math.round(1 / Math.max(dt, 1e-4));
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
