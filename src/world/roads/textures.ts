/**
 * Procedural fallback surfaces for the road network.
 *
 * The Materials module owns the shared PBR library, but it is allowed to come
 * up empty (or late), and a city whose streets are untextured grey is a failed
 * city. So Roads carries its own small bakery: a handful of tiling
 * albedo/normal/roughness sets authored from a height field, with the normal
 * map derived from that same height field by Sobel rather than guessed from
 * the albedo. When `ctx.materials` does provide a set, that one wins.
 *
 * Everything here is deterministic, so two runs of the city are identical.
 */
import * as THREE from 'three';
import type { TextureSet } from '../../core/Context';

export type SurfaceName =
  | 'asphalt' | 'concrete' | 'cobblestone' | 'brick_paver' | 'gravel'
  | 'concrete_sidewalk' | 'ballast' | 'granite' | 'steel';

/* ------------------------------------------------------------------ noise */

function h2(x: number, y: number, seed: number): number {
  let n = Math.imul(x | 0, 374761393) ^ Math.imul(y | 0, 668265263) ^ Math.imul(seed, 2246822519);
  n = Math.imul(n ^ (n >>> 13), 1274126177);
  return ((n ^ (n >>> 16)) >>> 0) / 4294967296;
}

const smooth = (t: number): number => t * t * (3 - 2 * t);

/** Tiling value noise: the lattice wraps at `period`, so the map is seamless. */
function vnoise(x: number, y: number, period: number, seed: number): number {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const xf = smooth(x - xi);
  const yf = smooth(y - yi);
  const w = (v: number): number => ((v % period) + period) % period;
  const x0 = w(xi); const x1 = w(xi + 1);
  const y0 = w(yi); const y1 = w(yi + 1);
  const a = h2(x0, y0, seed); const b = h2(x1, y0, seed);
  const c = h2(x0, y1, seed); const d = h2(x1, y1, seed);
  return (a + (b - a) * xf) + ((c + (d - c) * xf) - (a + (b - a) * xf)) * yf;
}

/** Tiling fBm in [0,1]. `base` lattice cells across the whole tile. */
function fbm(u: number, v: number, base: number, octaves: number, seed: number): number {
  let sum = 0;
  let amp = 1;
  let norm = 0;
  let freq = base;
  for (let o = 0; o < octaves; o++) {
    sum += vnoise(u * freq, v * freq, freq, seed + o * 131) * amp;
    norm += amp;
    amp *= 0.5;
    freq *= 2;
  }
  return sum / norm;
}

/* ------------------------------------------------------------ bake helpers */

interface Field {
  res: number;
  /** Height in arbitrary units; only its gradient matters. */
  h: Float32Array;
  /** sRGB bytes. */
  rgb: Uint8ClampedArray;
  /** Perceptual roughness 0-1. */
  rough: Float32Array;
}

function field(res: number): Field {
  return {
    res,
    h: new Float32Array(res * res),
    rgb: new Uint8ClampedArray(res * res * 4),
    rough: new Float32Array(res * res),
  };
}

function dataTex(
  data: Uint8Array, res: number, srgb: boolean, aniso: number, repeat = 1,
): THREE.DataTexture {
  // TS 5.7 splits ArrayBufferLike from ArrayBuffer in the DOM lib; three's
  // DataTexture takes the narrower BufferSource, so widen the view type here.
  const buf = data as unknown as Uint8Array<ArrayBuffer>;
  const t = new THREE.DataTexture(buf, res, res, THREE.RGBAFormat, THREE.UnsignedByteType);
  t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  t.wrapS = THREE.RepeatWrapping;
  t.wrapT = THREE.RepeatWrapping;
  t.magFilter = THREE.LinearFilter;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.generateMipmaps = true;
  t.anisotropy = aniso;
  t.repeat.set(repeat, repeat);
  t.needsUpdate = true;
  return t;
}

/**
 * Sobel the height field into a tangent-space normal map. `strength` is the
 * world height of one unit of `h` relative to one texel, so the slope is
 * physically meaningful rather than an eyeballed multiplier.
 */
function bakeNormal(f: Field, strength: number): Uint8Array {
  const { res, h } = f;
  const out = new Uint8Array(res * res * 4);
  const at = (x: number, y: number): number => h[((y + res) % res) * res + ((x + res) % res)];
  for (let y = 0; y < res; y++) {
    for (let x = 0; x < res; x++) {
      const gx =
        (at(x + 1, y - 1) + 2 * at(x + 1, y) + at(x + 1, y + 1)) -
        (at(x - 1, y - 1) + 2 * at(x - 1, y) + at(x - 1, y + 1));
      const gy =
        (at(x - 1, y + 1) + 2 * at(x, y + 1) + at(x + 1, y + 1)) -
        (at(x - 1, y - 1) + 2 * at(x, y - 1) + at(x + 1, y - 1));
      let nx = -gx * strength;
      let ny = -gy * strength;
      const nz = 1;
      const il = 1 / Math.hypot(nx, ny, nz);
      nx *= il;
      ny *= il;
      const i = (y * res + x) * 4;
      out[i] = (nx * 0.5 + 0.5) * 255;
      out[i + 1] = (ny * 0.5 + 0.5) * 255;
      out[i + 2] = nz * il * 255;
      out[i + 3] = 255;
    }
  }
  return out;
}

function bakeOrm(f: Field): Uint8Array {
  const { res, rough } = f;
  const out = new Uint8Array(res * res * 4);
  for (let i = 0; i < res * res; i++) {
    out[i * 4] = 255;                        // AO (unused, kept for packing)
    out[i * 4 + 1] = rough[i] * 255;         // roughness -> G
    out[i * 4 + 2] = 0;                      // metalness -> B
    out[i * 4 + 3] = 255;
  }
  return out;
}

function setPx(f: Field, i: number, r: number, g: number, b: number): void {
  f.rgb[i * 4] = r * 255;
  f.rgb[i * 4 + 1] = g * 255;
  f.rgb[i * 4 + 2] = b * 255;
  f.rgb[i * 4 + 3] = 255;
}

/* ---------------------------------------------------------------- authors */

function authorAsphalt(res: number, seed: number): Field {
  const f = field(res);
  for (let y = 0; y < res; y++) {
    for (let x = 0; x < res; x++) {
      const i = y * res + x;
      const u = x / res;
      const v = y / res;
      // Aggregate: fine high-frequency chips over a slow patch variation.
      const chip = fbm(u, v, 64, 3, seed);
      const patch = fbm(u, v, 4, 3, seed + 91);
      const seam = Math.abs(fbm(u, v, 3, 2, seed + 7) - 0.5);
      // Tar seams: thin dark ridges where the paving passes joined up.
      const tar = seam < 0.012 ? 1 - seam / 0.012 : 0;
      const patched = patch > 0.63 ? Math.min(1, (patch - 0.63) * 5) : 0;

      const base = 0.105 + patch * 0.055 + (chip - 0.5) * 0.075;
      const lum = base * (1 - patched * 0.28) + tar * -0.03;
      const warm = 1 + (chip - 0.5) * 0.1;
      setPx(f, i, lum * warm, lum * 1.005, lum * 1.03);
      f.h[i] = chip * 0.55 + patch * 0.22 - tar * 1.4;
      f.rough[i] = 0.80 + (chip - 0.5) * 0.14 - patched * 0.07;
    }
  }
  return f;
}

function authorConcrete(res: number, seed: number, sidewalk: boolean): Field {
  const f = field(res);
  // Sidewalk slabs: 2 x 2 score-jointed panels per tile.
  const panels = sidewalk ? 2 : 0;
  for (let y = 0; y < res; y++) {
    for (let x = 0; x < res; x++) {
      const i = y * res + x;
      const u = x / res;
      const v = y / res;
      const grain = fbm(u, v, 48, 3, seed);
      const stain = fbm(u, v, 5, 4, seed + 53);
      let joint = 0;
      if (panels) {
        const ju = Math.abs(((u * panels) % 1) - 0.5);
        const jv = Math.abs(((v * panels) % 1) - 0.5);
        const d = Math.min(0.5 - ju, 0.5 - jv) * (1 / panels);
        joint = d < 0.006 ? 1 - d / 0.006 : 0;
      }
      const lum = (0.335 + stain * 0.105 + (grain - 0.5) * 0.06) * (1 - joint * 0.42);
      setPx(f, i, lum * 1.015, lum, lum * 0.965);
      f.h[i] = grain * 0.3 + stain * 0.12 - joint * 2.2;
      f.rough[i] = 0.74 + (grain - 0.5) * 0.12 + stain * 0.06;
    }
  }
  return f;
}

/**
 * Granite setts. Boston's cobbles are small rectangular blocks laid in courses
 * with wide mortar joints — Acorn Street, not a cartoon hex pattern.
 */
function authorCobble(res: number, seed: number): Field {
  const f = field(res);
  const cols = 9;   // setts across the tile
  const rows = 13;  // courses down the tile
  for (let y = 0; y < res; y++) {
    for (let x = 0; x < res; x++) {
      const i = y * res + x;
      const u = x / res;
      const v = y / res;
      const row = Math.floor(v * rows);
      const stagger = (row % 2) * 0.5;
      const cu = u * cols + stagger;
      const col = Math.floor(cu);
      const fu = cu - col;
      const fv = v * rows - row;
      // Rounded-rectangle field: 1 at the crown of a sett, 0 in the joint.
      const ex = Math.max(0, 1 - Math.abs(fu - 0.5) / 0.42);
      const ey = Math.max(0, 1 - Math.abs(fv - 0.5) / 0.40);
      const dome = Math.pow(Math.min(ex, ey), 0.55);
      const id = h2(col, row, seed);
      const id2 = h2(col, row, seed + 999);
      const grain = fbm(u, v, 96, 2, seed + 17);
      // Weathered granite: cool greys with the odd warm or dark block.
      const tone = 0.20 + id * 0.16 + (grain - 0.5) * 0.05;
      const warm = 1 + (id2 - 0.5) * 0.14;
      const wear = 0.55 + dome * 0.45;
      const lum = tone * wear + (1 - dome) * -0.035;
      setPx(f, i, lum * warm, lum * (1 + (id2 - 0.5) * 0.04), lum * (1.06 - (id2 - 0.5) * 0.1));
      f.h[i] = dome * 1.0 + (grain - 0.5) * 0.12 + id * 0.08;
      // Polished crowns, gritty joints.
      f.rough[i] = 0.86 - dome * 0.30 + (grain - 0.5) * 0.06;
    }
  }
  return f;
}

/** Clay pavers in running bond — Beacon Hill and Back Bay footways. */
function authorBrickPaver(res: number, seed: number): Field {
  const f = field(res);
  const cols = 8;
  const rows = 16;
  for (let y = 0; y < res; y++) {
    for (let x = 0; x < res; x++) {
      const i = y * res + x;
      const u = x / res;
      const v = y / res;
      const row = Math.floor(v * rows);
      const stagger = (row % 2) * 0.5;
      const cu = u * cols + stagger;
      const col = Math.floor(cu);
      const fu = cu - col;
      const fv = v * rows - row;
      const joint = fu < 0.045 || fu > 0.955 || fv < 0.09 || fv > 0.91 ? 1 : 0;
      const edge = Math.min(
        Math.min(fu, 1 - fu) / 0.09,
        Math.min(fv, 1 - fv) / 0.16,
      );
      const bevel = Math.max(0, Math.min(1, edge));
      const id = h2(col, row, seed);
      const grain = fbm(u, v, 80, 2, seed + 31);
      const lum = (0.115 + id * 0.075 + (grain - 0.5) * 0.035) * (joint ? 0.62 : 1);
      // Warm red clay, mortar joints grey.
      const r = joint ? lum * 1.0 : lum * 1.62;
      const g = joint ? lum * 0.98 : lum * 0.84;
      const b = joint ? lum * 0.94 : lum * 0.70;
      setPx(f, i, r, g, b);
      f.h[i] = (joint ? -1.1 : 0) + bevel * 0.7 + (grain - 0.5) * 0.1;
      f.rough[i] = joint ? 0.9 : 0.72 + (grain - 0.5) * 0.1;
    }
  }
  return f;
}

function authorGravel(res: number, seed: number, coarse: boolean): Field {
  const f = field(res);
  const cells = coarse ? 26 : 44;
  for (let y = 0; y < res; y++) {
    for (let x = 0; x < res; x++) {
      const i = y * res + x;
      const u = x / res;
      const v = y / res;
      // Worley-ish: nearest jittered lattice point gives convincing stones.
      const gx = u * cells;
      const gy = v * cells;
      const cx = Math.floor(gx);
      const cy = Math.floor(gy);
      let best = 9;
      let bid = 0;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const px = ((cx + dx) % cells + cells) % cells;
          const py = ((cy + dy) % cells + cells) % cells;
          const jx = cx + dx + h2(px, py, seed);
          const jy = cy + dy + h2(px, py, seed + 77);
          const d = Math.hypot(gx - jx, gy - jy);
          if (d < best) { best = d; bid = h2(px, py, seed + 303); }
        }
      }
      const stone = Math.max(0, 1 - best / 0.62);
      const grain = fbm(u, v, 72, 2, seed + 5);
      const tone = coarse ? 0.16 + bid * 0.13 : 0.20 + bid * 0.15;
      const lum = tone * (0.6 + stone * 0.5) + (grain - 0.5) * 0.04;
      setPx(f, i, lum * 1.04, lum, lum * 0.94);
      f.h[i] = stone * 1.1 + (grain - 0.5) * 0.25;
      f.rough[i] = 0.9 - stone * 0.12;
    }
  }
  return f;
}

/** Sawn granite kerbstone: tight grain, faint saw marks, occasional chip. */
function authorGranite(res: number, seed: number): Field {
  const f = field(res);
  for (let y = 0; y < res; y++) {
    for (let x = 0; x < res; x++) {
      const i = y * res + x;
      const u = x / res;
      const v = y / res;
      const speck = fbm(u, v, 110, 2, seed);
      const band = fbm(u, v, 6, 3, seed + 61);
      const saw = Math.sin(v * Math.PI * 2 * 48) * 0.5 + 0.5;
      const lum = 0.235 + band * 0.06 + (speck - 0.5) * 0.13;
      setPx(f, i, lum * 1.01, lum, lum * 1.02);
      f.h[i] = (speck - 0.5) * 0.5 + saw * 0.06;
      f.rough[i] = 0.66 + (speck - 0.5) * 0.16;
    }
  }
  return f;
}

/** Cast iron: for manhole covers, gully grates and rail heads. */
function authorSteel(res: number, seed: number): Field {
  const f = field(res);
  for (let y = 0; y < res; y++) {
    for (let x = 0; x < res; x++) {
      const i = y * res + x;
      const u = x / res;
      const v = y / res;
      const grain = fbm(u, v, 56, 3, seed);
      const rust = Math.max(0, fbm(u, v, 7, 3, seed + 23) - 0.56) * 2.2;
      const lum = 0.085 + grain * 0.06;
      setPx(f, i, lum + rust * 0.10, lum + rust * 0.045, lum + rust * 0.012);
      f.h[i] = (grain - 0.5) * 0.4;
      f.rough[i] = 0.52 + grain * 0.2 + rust * 0.22;
    }
  }
  return f;
}

/* ------------------------------------------------------------------ public */

interface Recipe {
  res: number;
  tile: number;
  strength: number;
  make: (res: number, seed: number) => Field;
}

const RECIPES: Record<SurfaceName, Recipe> = {
  asphalt: { res: 256, tile: 7.5, strength: 0.10, make: (r, s) => authorAsphalt(r, s) },
  concrete: { res: 256, tile: 6.0, strength: 0.09, make: (r, s) => authorConcrete(r, s, false) },
  concrete_sidewalk: { res: 256, tile: 2.6, strength: 0.16, make: (r, s) => authorConcrete(r, s, true) },
  cobblestone: { res: 512, tile: 2.55, strength: 0.30, make: (r, s) => authorCobble(r, s) },
  brick_paver: { res: 512, tile: 1.95, strength: 0.24, make: (r, s) => authorBrickPaver(r, s) },
  gravel: { res: 256, tile: 3.4, strength: 0.22, make: (r, s) => authorGravel(r, s, false) },
  ballast: { res: 256, tile: 2.6, strength: 0.30, make: (r, s) => authorGravel(r, s, true) },
  granite: { res: 256, tile: 1.9, strength: 0.13, make: (r, s) => authorGranite(r, s) },
  steel: { res: 128, tile: 1.1, strength: 0.18, make: (r, s) => authorSteel(r, s) },
};

const SEEDS: Record<SurfaceName, number> = {
  asphalt: 11, concrete: 23, concrete_sidewalk: 37, cobblestone: 53,
  brick_paver: 71, gravel: 97, ballast: 113, granite: 131, steel: 151,
};

const cache = new Map<SurfaceName, TextureSet>();

/** Bakes (once) and returns the fallback set for a surface family. */
export function fallbackSet(name: SurfaceName, anisotropy: number): TextureSet {
  const hit = cache.get(name);
  if (hit) return hit;
  const rec = RECIPES[name];
  const f = rec.make(rec.res, SEEDS[name]);
  const aniso = Math.max(1, Math.min(16, anisotropy));
  const set: TextureSet = {
    map: dataTex(new Uint8Array(f.rgb), rec.res, true, aniso),
    normalMap: dataTex(bakeNormal(f, rec.strength * rec.res * 0.02), rec.res, false, aniso),
    roughnessMap: dataTex(bakeOrm(f), rec.res, false, aniso),
    tileMeters: rec.tile,
  };
  cache.set(name, set);
  return set;
}

export function disposeFallbacks(): void {
  for (const s of cache.values()) {
    s.map.dispose();
    s.normalMap?.dispose();
    s.roughnessMap?.dispose();
  }
  cache.clear();
}
