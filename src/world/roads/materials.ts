/**
 * Material resolution for the road network.
 *
 * Roads need materials with `vertexColors` on (every ribbon carries wear,
 * patching and paint colour in its vertex stream) and with polygon offset
 * configured per decal layer, so we build our own `MeshStandardMaterial`s
 * rather than taking finished ones from the library. The *textures* still come
 * from `ctx.materials` whenever it has them; only when it does not do we fall
 * back to the local bakery in `textures.ts`.
 *
 * Depth: every layer is separated by polygon offset, not by a vertical lift.
 * Offset scales with the depth slope, so it holds at 2 km as well as at 2 m —
 * a fixed lift does not, and on a slope a lift also shifts the surface
 * sideways relative to the terrain it is supposed to be glued to.
 */
import * as THREE from 'three';
import type { Ctx, TextureSet } from '../../core/Context';
import { type SurfaceName, fallbackSet } from './textures';

export type MatKey =
  | 'asphalt' | 'concrete' | 'cobble' | 'brick' | 'gravel'
  | 'walk_concrete' | 'walk_brick' | 'kerb' | 'ballast' | 'steel'
  | 'paint' | 'structure' | 'void';

interface Recipe {
  /** Surface family used for the fallback bake. */
  fallback: SurfaceName;
  /** Names to try in `ctx.materials.textures()`, best first. */
  library: string[];
  roughness: number;
  metalness: number;
  /** Polygon-offset depth layer: bigger pulls further toward the camera. */
  layer: number;
  /** Multiplies the resolved tile size (finer paint normals, etc). */
  tileScale?: number;
  transparent?: boolean;
  /** Drop the albedo map and drive colour purely from vertex colour. */
  noAlbedo?: boolean;
}

const RECIPES: Record<MatKey, Recipe> = {
  asphalt: { fallback: 'asphalt', library: ['road_asphalt', 'asphalt', 'tarmac'], roughness: 1, metalness: 0, layer: 1 },
  concrete: { fallback: 'concrete', library: ['road_concrete', 'concrete'], roughness: 1, metalness: 0, layer: 1 },
  cobble: { fallback: 'cobblestone', library: ['cobblestone', 'setts', 'granite_setts'], roughness: 1, metalness: 0, layer: 1 },
  brick: { fallback: 'brick_paver', library: ['brick_paver', 'brick_pavement', 'brick'], roughness: 1, metalness: 0, layer: 1 },
  gravel: { fallback: 'gravel', library: ['gravel', 'dirt', 'ground'], roughness: 1, metalness: 0, layer: 1 },
  walk_concrete: { fallback: 'concrete_sidewalk', library: ['concrete_sidewalk', 'sidewalk', 'concrete'], roughness: 1, metalness: 0, layer: 2 },
  walk_brick: { fallback: 'brick_paver', library: ['brick_paver', 'brick_pavement'], roughness: 1, metalness: 0, layer: 2 },
  kerb: { fallback: 'granite', library: ['granite', 'kerb', 'curb', 'stone'], roughness: 1, metalness: 0, layer: 2 },
  ballast: { fallback: 'ballast', library: ['ballast', 'gravel'], roughness: 1, metalness: 0, layer: 1 },
  steel: { fallback: 'steel', library: ['cast_iron', 'metal', 'steel'], roughness: 1, metalness: 0.85, layer: 3 },
  paint: { fallback: 'asphalt', library: ['road_asphalt', 'asphalt'], roughness: 0.62, metalness: 0, layer: 6, tileScale: 0.16, transparent: true, noAlbedo: true },
  structure: { fallback: 'concrete', library: ['bridge_concrete', 'concrete'], roughness: 1, metalness: 0, layer: 0 },
  void: { fallback: 'asphalt', library: [], roughness: 1, metalness: 0, layer: 0 },
};

/** Metres of world covered by one UV tile, per key. Filled during resolve. */
export type TileSizes = Record<MatKey, number>;

export class RoadMaterials {
  private mats = new Map<MatKey, THREE.Material>();
  private tiles = new Map<MatKey, number>();
  private owned: THREE.Material[] = [];
  readonly anisotropy: number;

  constructor(private ctx: Ctx) {
    this.anisotropy = Math.max(1, ctx.quality?.anisotropy ?? 4);
  }

  /** Resolves a texture set from the shared library, else bakes a fallback. */
  private setFor(rec: Recipe): TextureSet {
    const lib = this.ctx.materials;
    if (lib && typeof lib.textures === 'function') {
      for (const name of rec.library) {
        try {
          const s = lib.textures(name);
          if (s && s.map) return s;
        } catch {
          /* a half-initialised library must never take the roads down */
        }
      }
    }
    return fallbackSet(rec.fallback, this.anisotropy);
  }

  get(key: MatKey): THREE.Material {
    const hit = this.mats.get(key);
    if (hit) return hit;

    const rec = RECIPES[key];
    let m: THREE.Material;

    if (key === 'void') {
      // A tunnel bore is genuinely unlit: anything else makes the mouth glow.
      m = new THREE.MeshBasicMaterial({ color: 0x04050a, fog: true, side: THREE.FrontSide });
      this.tiles.set(key, 1);
    } else {
      const set = this.setFor(rec);
      const tile = Math.max(0.2, set.tileMeters * (rec.tileScale ?? 1));
      this.tiles.set(key, tile);

      const std = new THREE.MeshStandardMaterial({
        color: 0xffffff,
        vertexColors: true,
        roughness: rec.roughness,
        metalness: rec.metalness,
        map: rec.noAlbedo ? null : set.map,
        normalMap: set.normalMap ?? null,
        roughnessMap: set.roughnessMap ?? null,
        aoMap: set.aoMap ?? null,
        envMapIntensity: 1,
        side: THREE.FrontSide,
      });
      // `tileScale` only changes the UVs we author, never the texture itself:
      // paint telegraphs the aggregate beneath it, so it reuses the asphalt
      // normal at a much finer scale.
      if (std.normalMap) std.normalScale.set(rec.noAlbedo ? 0.45 : 0.9, rec.noAlbedo ? 0.45 : 0.9);
      if (rec.transparent) {
        std.transparent = true;
        std.depthWrite = false;
      }
      m = std;
    }

    if (rec.layer > 0) {
      m.polygonOffset = true;
      m.polygonOffsetFactor = -rec.layer;
      m.polygonOffsetUnits = -rec.layer * 2.2;
    }
    if (this.ctx.envMap && m instanceof THREE.MeshStandardMaterial) {
      m.envMap = this.ctx.envMap;
    }

    this.mats.set(key, m);
    this.owned.push(m);
    return m;
  }

  /** World metres per UV tile for a key; call after `get`. */
  tile(key: MatKey): number {
    if (!this.tiles.has(key)) this.get(key);
    return this.tiles.get(key) ?? 4;
  }

  dispose(): void {
    for (const m of this.owned) m.dispose();
    this.owned.length = 0;
    this.mats.clear();
  }
}

/** Maps a carriageway surface family onto a material key. */
export function surfaceMat(s: string): MatKey {
  switch (s) {
    case 'cobblestone': return 'cobble';
    case 'brick': return 'brick';
    case 'gravel': return 'gravel';
    case 'concrete': return 'concrete';
    default: return 'asphalt';
  }
}
