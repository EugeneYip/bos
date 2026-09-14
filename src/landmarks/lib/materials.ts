/**
 * Material resolution for the landmark meshes.
 *
 * Policy: prefer the shared library (`ctx.materials`) so the landmarks sit in
 * the same colour world as the background building stock, but *never* depend on
 * it. The Materials module is built concurrently and may still be the stub in
 * `core/App.ts`, which returns the same grey `MeshStandardMaterial` for every
 * name. We probe for that and silently fall back to locally-authored PBR.
 *
 * Detection: ask the library for a name that cannot possibly exist. If the
 * result is indistinguishable from the result for a real family, the library
 * is a stub and we author everything ourselves.
 */
import * as THREE from 'three';
import type { Ctx, TextureSet } from '../../core/Context';
import {
  brickTexture,
  graniteTexture,
  marbleTexture,
  boardConcreteTexture,
  copperPatinaTexture,
  goldLeafRoughness,
  noiseNormal,
  windowLightAtlas,
} from './textures';

export interface SurfaceOpts {
  color?: number;
  roughness?: number;
  metalness?: number;
  /** World metres covered by one texture tile. */
  tile?: number;
  emissive?: number;
  emissiveIntensity?: number;
  envMapIntensity?: number;
  flatShading?: boolean;
  side?: THREE.Side;
  transparent?: boolean;
  opacity?: number;
  normalScale?: number;
}

/** Families this module knows how to author locally. */
export type Family =
  | 'brick'
  | 'brownstone'
  | 'granite'
  | 'stone'
  | 'marble'
  | 'sandstone'
  | 'concrete'
  | 'metal'
  | 'darkmetal'
  | 'gold'
  | 'copper'
  | 'slate'
  | 'glass'
  | 'paint';

const PROBE = '__landmark_probe_does_not_exist__';

export class LandmarkMaterials {
  private cache = new Map<string, THREE.Material>();
  private all: THREE.Material[] = [];
  private libraryIsReal: boolean | null = null;
  private envRef: THREE.Texture | null = null;
  /** Materials whose emissive is driven by the day/night cycle. */
  private nightLit: THREE.MeshStandardMaterial[] = [];

  constructor(private ctx: Ctx) {}

  /**
   * True when `ctx.materials` looks like a genuine library rather than the
   * bootstrap stub. Cached; the probe only runs once.
   */
  hasLibrary(): boolean {
    if (this.libraryIsReal !== null) return this.libraryIsReal;
    let real = false;
    try {
      const lib = this.ctx.materials;
      if (lib && typeof lib.get === 'function') {
        const probe = lib.get(PROBE);
        const brick = lib.get('brick');
        const glass = lib.get('glass');
        // A real library differentiates families; the stub returns an identical
        // grey for every name. Also accept a library that exposes texture sets.
        const differs =
          !!probe && !!brick && !!glass && (signature(brick) !== signature(probe) || signature(glass) !== signature(probe));
        const hasTex = typeof lib.textures === 'function' && !!lib.textures('brick');
        real = differs || hasTex;
      }
    } catch {
      real = false;
    }
    this.libraryIsReal = real;
    return real;
  }

  /** Texture set from the shared library, or undefined. */
  private libTextures(name: string): TextureSet | undefined {
    if (!this.hasLibrary()) return undefined;
    try {
      return this.ctx.materials.textures(name);
    } catch {
      return undefined;
    }
  }

  /** Current environment map, re-read each call so late Sky init is picked up. */
  private env(): THREE.Texture | null {
    return this.ctx.envMap ?? this.envRef;
  }

  /** Propagate a newly-published env map onto every material we've made. */
  refreshEnvironment(): void {
    const env = this.ctx.envMap;
    if (env === this.envRef) return;
    this.envRef = env;
    for (const m of this.all) {
      const mm = m as THREE.MeshStandardMaterial;
      if ('envMap' in mm) {
        mm.envMap = env;
        mm.needsUpdate = true;
      }
    }
  }

  private track<T extends THREE.Material>(m: T): T {
    this.all.push(m);
    return m;
  }

  private key(family: string, o: SurfaceOpts): string {
    return `${family}|${o.color ?? ''}|${o.roughness ?? ''}|${o.metalness ?? ''}|${o.tile ?? ''}|${o.emissive ?? ''}|${o.side ?? ''}|${o.opacity ?? ''}|${o.flatShading ?? ''}|${o.envMapIntensity ?? ''}`;
  }

  /**
   * The workhorse. Builds (and caches) a PBR material for a surface family,
   * using shared textures when the library has them.
   */
  surface(family: Family, opts: SurfaceOpts = {}): THREE.MeshStandardMaterial {
    const k = this.key(family, opts);
    const hit = this.cache.get(k);
    if (hit) return hit as THREE.MeshStandardMaterial;

    const d = DEFAULTS[family];
    const color = opts.color ?? d.color;
    const tile = opts.tile ?? d.tile;
    const params: THREE.MeshStandardMaterialParameters = {
      color,
      roughness: opts.roughness ?? d.roughness,
      metalness: opts.metalness ?? d.metalness,
      envMapIntensity: opts.envMapIntensity ?? d.env,
      flatShading: opts.flatShading ?? false,
      side: opts.side ?? THREE.FrontSide,
    };
    if (opts.transparent) {
      params.transparent = true;
      params.opacity = opts.opacity ?? 1;
    }
    if (opts.emissive !== undefined) {
      params.emissive = new THREE.Color(opts.emissive);
      params.emissiveIntensity = opts.emissiveIntensity ?? 1;
    }

    const m = new THREE.MeshStandardMaterial(params);
    m.name = `landmark:${family}`;

    // Shared library textures first…
    const shared = this.libTextures(LIB_ALIAS[family] ?? family);
    if (shared) {
      const rep = tile / (shared.tileMeters || tile);
      m.map = cloneRepeat(shared.map, rep);
      if (shared.normalMap) m.normalMap = cloneRepeat(shared.normalMap, rep);
      if (shared.roughnessMap) m.roughnessMap = cloneRepeat(shared.roughnessMap, rep);
      if (shared.aoMap) m.aoMap = cloneRepeat(shared.aoMap, rep);
    } else {
      // …otherwise author locally.
      const local = this.localMaps(family, color);
      if (local.map) m.map = local.map;
      if (local.normalMap) m.normalMap = local.normalMap;
      if (local.roughnessMap) m.roughnessMap = local.roughnessMap;
      // Local maps already carry the family colour; don't double-tint.
      if (local.map) m.color.set(local.neutral ? color : 0xffffff);
    }
    if (m.normalMap) m.normalScale.set(opts.normalScale ?? d.normalScale, opts.normalScale ?? d.normalScale);
    const env = this.env();
    if (env) m.envMap = env;

    this.cache.set(k, m);
    return this.track(m);
  }

  /** Locally-authored map set for a family. `neutral` means the map is greyscale. */
  private localMaps(family: Family, color: number): {
    map?: THREE.Texture;
    normalMap?: THREE.Texture;
    roughnessMap?: THREE.Texture;
    neutral?: boolean;
  } {
    switch (family) {
      case 'brick':
      case 'brownstone':
        return { map: brickTexture(color), normalMap: noiseNormal(0.9, 5) };
      case 'granite':
      case 'stone':
        return { map: graniteTexture(color), normalMap: noiseNormal(0.55, 11) };
      case 'sandstone':
        return { map: graniteTexture(color, 0.16), normalMap: noiseNormal(0.5, 13) };
      case 'marble':
        return { map: marbleTexture(color), normalMap: noiseNormal(0.2, 19) };
      case 'concrete':
        return { map: boardConcreteTexture(color), normalMap: noiseNormal(0.7, 23) };
      case 'copper':
        return { map: copperPatinaTexture(color), normalMap: noiseNormal(0.35, 29) };
      case 'gold':
        return { roughnessMap: goldLeafRoughness(), normalMap: noiseNormal(0.14, 1861) };
      case 'slate':
        return { map: graniteTexture(color, 0.12), normalMap: noiseNormal(0.4, 37) };
      default:
        return {};
    }
  }

  /**
   * 23.75-carat gold leaf. Metal workflow: `color` is the F0 reflectance, which
   * for gold is linear (1.00, 0.71, 0.29) -> sRGB #ffdb92. Warmed very slightly
   * and roughened by the leaf map so it gleams rather than mirrors.
   */
  gold(opts: SurfaceOpts = {}): THREE.MeshStandardMaterial {
    // Try the shared library's 'gold' first — the Materials module may author a
    // better one. Only accept it if the library is genuinely populated.
    if (this.hasLibrary()) {
      try {
        const m = this.ctx.materials.get('gold');
        const std = m as THREE.MeshStandardMaterial;
        if (std && std.isMeshStandardMaterial && std.metalness > 0.6) {
          return this.track(std);
        }
      } catch {
        /* fall through to the local author */
      }
    }
    return this.surface('gold', {
      color: 0xffd489,
      metalness: 1,
      roughness: 0.24,
      envMapIntensity: 1.5,
      ...opts,
    });
  }

  /**
   * Curtain-wall glass. `MeshPhysicalMaterial` so we get real Fresnel plus a
   * clear-coat-ish sheen; mirror glass (the Hancock) wants high metalness and
   * very low roughness, vision glass on a residential tower wants more.
   */
  glass(opts: {
    color?: number;
    roughness?: number;
    metalness?: number;
    envMapIntensity?: number;
    reflectivity?: number;
    opacity?: number;
    key?: string;
  } = {}): THREE.MeshPhysicalMaterial {
    const k = `glass|${JSON.stringify(opts)}`;
    const hit = this.cache.get(k);
    if (hit) return hit as THREE.MeshPhysicalMaterial;
    const m = new THREE.MeshPhysicalMaterial({
      color: opts.color ?? 0x2a4560,
      roughness: opts.roughness ?? 0.06,
      metalness: opts.metalness ?? 0.9,
      envMapIntensity: opts.envMapIntensity ?? 1.25,
      reflectivity: opts.reflectivity ?? 1,
      clearcoat: 0.35,
      clearcoatRoughness: 0.08,
    });
    m.name = `landmark:glass${opts.key ? `:${opts.key}` : ''}`;
    const env = this.env();
    if (env) m.envMap = env;
    this.cache.set(k, m);
    return this.track(m);
  }

  /**
   * Glass that also emits light from individual panes at night. The window
   * atlas is sampled through `emissiveMap` with one texel per pane (see
   * `curtainwall.ts` for the UV convention), so every window gets its own
   * brightness and ~45% are dark.
   */
  litGlass(
    seed: number,
    base: Parameters<LandmarkMaterials['glass']>[0] = {},
    litFraction = 0.5,
  ): THREE.MeshStandardMaterial {
    const k = `litglass|${seed}|${JSON.stringify(base)}|${litFraction}`;
    const hit = this.cache.get(k);
    if (hit) return hit as THREE.MeshStandardMaterial;
    const m = new THREE.MeshStandardMaterial({
      color: base.color ?? 0x2a4560,
      roughness: base.roughness ?? 0.07,
      metalness: base.metalness ?? 0.88,
      envMapIntensity: base.envMapIntensity ?? 1.25,
      emissive: new THREE.Color(0xffffff),
      emissiveIntensity: 0,
    });
    m.name = `landmark:litglass:${seed}`;
    m.emissiveMap = windowLightAtlas(seed, litFraction);
    const env = this.env();
    if (env) m.envMap = env;
    this.cache.set(k, m);
    this.nightLit.push(m);
    return this.track(m);
  }

  /** Unlit-looking self-illuminated surface (neon, beacons, signage). */
  emissive(color: number, intensity = 1, opts: { night?: boolean; toneMapped?: boolean } = {}): THREE.MeshStandardMaterial {
    const k = `emis|${color}|${intensity}|${opts.night ?? false}`;
    const hit = this.cache.get(k);
    if (hit) return hit as THREE.MeshStandardMaterial;
    const m = new THREE.MeshStandardMaterial({
      color: 0x0a0a0a,
      roughness: 0.5,
      metalness: 0,
      emissive: new THREE.Color(color),
      emissiveIntensity: intensity,
    });
    m.name = `landmark:emissive`;
    m.toneMapped = opts.toneMapped ?? true;
    if (opts.night) this.nightLit.push(m);
    this.cache.set(k, m);
    return this.track(m);
  }

  /**
   * Adopt an externally-authored material so it participates in the day/night
   * drive and in disposal. Use for one-off emissives a landmark builds itself
   * (the Citgo sign's artwork, Fenway's scoreboard) that still need to fade up
   * after dusk. Honours `userData.nightPeak` like the built-in emissives.
   */
  registerNightLit(m: THREE.MeshStandardMaterial): THREE.MeshStandardMaterial {
    if (!this.nightLit.includes(m)) this.nightLit.push(m);
    return this.track(m);
  }

  /**
   * Drive night lighting from the sun elevation. Windows fade up as the sun
   * drops below ~6 degrees and are fully on after civil twilight.
   */
  updateNight(ctx: Ctx): void {
    const e = ctx.sun?.elevation ?? 0.5;
    // 0 at +8 degrees, 1 at -4 degrees.
    const t = THREE.MathUtils.clamp((0.14 - e) / 0.21, 0, 1);
    // These emissives are display-referred; the sky lifts exposure ~4x after
    // dark, so scale back down or the dome and the Citgo sign clip to white.
    const comp = 2.5 / Math.max(ctx.renderer.toneMappingExposure || 2.5, 0.1);
    const k = t * t * (3 - 2 * t) * comp;
    for (const m of this.nightLit) {
      m.emissiveIntensity = k * (m.userData.nightPeak ?? 1);
    }
  }

  dispose(): void {
    for (const m of this.all) m.dispose();
    this.all.length = 0;
    this.cache.clear();
    this.nightLit.length = 0;
  }
}

/**
 * One `LandmarkMaterials` per `Ctx`, so every landmark built for the same world
 * shares (and therefore batches) the same material instances — and so the
 * standalone inspector gets its own set without leaking into the city.
 */
const perCtx = new WeakMap<Ctx, LandmarkMaterials>();

export function materialsFor(ctx: Ctx): LandmarkMaterials {
  let m = perCtx.get(ctx);
  if (!m) {
    m = new LandmarkMaterials(ctx);
    perCtx.set(ctx, m);
  }
  return m;
}

/** Map our family names onto the shared library's vocabulary. */
const LIB_ALIAS: Record<string, string> = {
  granite: 'stone',
  marble: 'stone',
  sandstone: 'stone',
  darkmetal: 'metal',
  paint: 'plaster',
};

interface Defaults {
  color: number;
  roughness: number;
  metalness: number;
  tile: number;
  env: number;
  normalScale: number;
}

const DEFAULTS: Record<Family, Defaults> = {
  brick: { color: 0x8d4f3c, roughness: 0.93, metalness: 0, tile: 2.4, env: 0.8, normalScale: 0.8 },
  brownstone: { color: 0x7a5642, roughness: 0.9, metalness: 0, tile: 2.6, env: 0.8, normalScale: 0.7 },
  granite: { color: 0x9c9a94, roughness: 0.82, metalness: 0, tile: 3.2, env: 0.9, normalScale: 0.6 },
  stone: { color: 0xa8a49a, roughness: 0.8, metalness: 0, tile: 3.2, env: 0.9, normalScale: 0.6 },
  marble: { color: 0xe9e6de, roughness: 0.45, metalness: 0, tile: 4, env: 1.0, normalScale: 0.25 },
  sandstone: { color: 0xb08663, roughness: 0.85, metalness: 0, tile: 3.0, env: 0.85, normalScale: 0.5 },
  concrete: { color: 0xa8a49b, roughness: 0.88, metalness: 0, tile: 3.2, env: 0.85, normalScale: 0.7 },
  metal: { color: 0xb6bcc2, roughness: 0.35, metalness: 0.95, tile: 2, env: 1.15, normalScale: 0.3 },
  darkmetal: { color: 0x3c4148, roughness: 0.45, metalness: 0.9, tile: 2, env: 1.0, normalScale: 0.3 },
  gold: { color: 0xffd489, roughness: 0.24, metalness: 1, tile: 2.7, env: 1.5, normalScale: 0.3 },
  copper: { color: 0x5fa38c, roughness: 0.6, metalness: 0.35, tile: 2.4, env: 1.0, normalScale: 0.4 },
  slate: { color: 0x4e535a, roughness: 0.72, metalness: 0, tile: 2.2, env: 0.9, normalScale: 0.5 },
  glass: { color: 0x2a4560, roughness: 0.07, metalness: 0.9, tile: 2, env: 1.25, normalScale: 0.2 },
  paint: { color: 0xf2efe8, roughness: 0.6, metalness: 0, tile: 3, env: 0.9, normalScale: 0.2 },
};

function signature(m: THREE.Material): string {
  const s = m as THREE.MeshStandardMaterial;
  return `${m.type}|${s.color ? s.color.getHexString() : ''}|${s.roughness ?? ''}|${s.metalness ?? ''}|${s.map ? 'm' : ''}`;
}

function cloneRepeat(t: THREE.Texture, rep: number): THREE.Texture {
  // The shared library bakes its maps on the GPU, so they are render-target
  // textures: the pixels live in a framebuffer attachment, not in a CPU image.
  // Such a texture CANNOT be cloned — three.js keys the GL texture off the
  // texture object, so a clone resolves to no binding at all and samples
  // black. Share the original instead and let the geometry's world-metre UVs
  // carry the tiling, which is what the library's `tileMeters` already
  // assumes.
  if (t.isRenderTargetTexture) return t;

  const c = t.clone();
  c.wrapS = c.wrapT = THREE.RepeatWrapping;
  c.repeat.set(rep, rep);
  c.needsUpdate = true;
  return c;
}
