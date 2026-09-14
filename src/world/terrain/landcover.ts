/**
 * Rasterises the OSM area polygons into the land-cover maps the terrain shader
 * splats with.
 *
 * Rather than carrying one weight per material (seven RGBA8 city-sized textures
 * is absurd), the cover map is a single RGBA8:
 *
 *   R  green cover      -> grass
 *   G  canopy litter    -> mulch / leaf litter under trees
 *   B  granular cover   -> sand (beaches, dunes, harbour bed)
 *   A  "hardness" key   -> splits whatever is left over between concrete,
 *                          gravel and asphalt along a single smooth axis
 *
 * The leftover `1 - (R+G+B)` is the paved/bare fraction, so a single texture
 * fetch reconstructs all seven surfaces. Boundaries are softened in the shader
 * with a domain warp instead of being pre-blurred, which keeps kerbs and pitch
 * markings straight while making natural edges organic.
 */
import type { AreaRecord } from '../../core/types';
import { fillPolygon, type RasterGrid } from './raster';

export const COVER_STRIDE = 4;

/** Byte arrays handed to the GPU must be backed by a plain ArrayBuffer. */
export type Bytes = Uint8Array<ArrayBuffer>;

/** Hardness-key stops, matched by the shader's three-way ramp. */
export const HARD = {
  concrete: 10,
  gravel: 107,
  urban: 165,
  asphalt: 242,
} as const;

export interface CoverKey {
  /** 0-255 per channel; -1 leaves the channel untouched. */
  r: number; g: number; b: number; a: number;
  /** Rasterisation order; higher wins. */
  pass: number;
}

const KEYS: Partial<Record<AreaRecord['kind'], CoverKey>> = {
  forest:   { r: 90,  g: 168, b: 0,  a: HARD.gravel,   pass: 0 },
  wetland:  { r: 184, g: 40,  b: 26, a: HARD.gravel,   pass: 0 },
  golf:     { r: 255, g: 0,   b: 0,  a: HARD.gravel,   pass: 1 },
  park:     { r: 235, g: 12,  b: 0,  a: HARD.gravel,   pass: 1 },
  cemetery: { r: 224, g: 18,  b: 0,  a: HARD.gravel,   pass: 2 },
  grass:    { r: 255, g: 0,   b: 0,  a: HARD.gravel,   pass: 2 },
  // pass 3 is reserved for water, handled separately
  beach:    { r: 0,   g: 0,   b: 255, a: HARD.gravel,  pass: 4 },
  sand:     { r: 0,   g: 0,   b: 255, a: HARD.gravel,  pass: 4 },
  railyard: { r: 0,   g: 0,   b: 20,  a: HARD.gravel,  pass: 5 },
  parking:  { r: 0,   g: 0,   b: 0,   a: HARD.asphalt, pass: 5 },
  runway:   { r: 0,   g: 0,   b: 0,   a: 230,          pass: 5 },
  pitch:    { r: 232, g: 0,   b: 22,  a: HARD.gravel,  pass: 6 },
  plaza:    { r: 0,   g: 0,   b: 0,   a: HARD.concrete, pass: 7 },
  pier:     { r: 0,   g: 0,   b: 0,   a: 34,           pass: 8 },
};

export interface LandCover {
  grid: RasterGrid;
  /** RGBA8, `width*height*4`. */
  cover: Bytes;
  /** 1 where an OSM water/river polygon covers the cell. */
  waterMask: Bytes;
  /** Target bed depth below the local water plane, in 0.05 m units. */
  waterDepth: Bytes;
  /** Water-surface elevation, in 0.01 m units (the Charles basin sits at 0.6). */
  waterElev: Bytes;
  /** Non-zero where the terrain must be lifted to a deck (piers). */
  deckElev: Bytes;
}

function ringArea(outline: readonly number[]): number {
  let s = 0;
  const n = outline.length;
  for (let i = 0; i < n; i += 2) {
    const j = (i + 2) % n;
    s += outline[i] * outline[j + 1] - outline[j] * outline[i + 1];
  }
  return Math.abs(s) * 0.5;
}

export function rasteriseLandCover(areas: readonly AreaRecord[], grid: RasterGrid): LandCover {
  const n = grid.width * grid.height;
  const cover = new Uint8Array(n * COVER_STRIDE);
  const waterMask = new Uint8Array(n);
  const waterDepth = new Uint8Array(n);
  const waterElev = new Uint8Array(n);
  const deckElev = new Uint8Array(n);

  // Default: bare urban ground. Roads and buildings cover most of it; what
  // shows through wants to read as grimy pavement, not as bright grass.
  for (let k = 0; k < n; k++) cover[k * 4 + 3] = HARD.urban;

  interface Job { rec: AreaRecord; pass: number; area: number }
  const jobs: Job[] = [];
  for (const rec of areas) {
    const water = rec.kind === 'water' || rec.kind === 'river';
    const key = KEYS[rec.kind];
    if (!water && !key) continue;
    jobs.push({ rec, pass: water ? 3 : key!.pass, area: ringArea(rec.outline) });
  }
  // Later passes paint over earlier ones; inside a pass, small features win so
  // a ball pitch still reads on top of the park that contains it.
  jobs.sort((a, b) => (a.pass - b.pass) || (b.area - a.area));

  for (const job of jobs) {
    const rec = job.rec;
    const rings: readonly number[][] = rec.holes?.length
      ? [rec.outline, ...rec.holes]
      : [rec.outline];

    if (job.pass === 3) {
      // Water: mask + a bed depth derived from the surface area, so the harbour
      // gets a real shelf while a duck pond does not.
      const km2 = job.area / 1e6;
      const depthM = Math.min(12.4, Math.max(1.4, Math.sqrt(km2) * 7.2 + 1.3));
      const depthByte = Math.round(depthM / 0.05);
      const elevByte = Math.max(0, Math.min(255, Math.round(rec.elevation / 0.01)));
      fillPolygon(rings, grid, (row, i0, i1) => {
        for (let i = i0; i < i1; i++) {
          const k = row + i;
          waterMask[k] = 1;
          if (depthByte > waterDepth[k]) waterDepth[k] = depthByte;
          if (elevByte > waterElev[k]) waterElev[k] = elevByte;
        }
      });
      continue;
    }

    const key = KEYS[rec.kind]!;
    const { r, g, b, a } = key;
    const isPier = rec.kind === 'pier';
    const deck = isPier ? Math.max(1, Math.min(255, Math.round(rec.elevation / 0.05))) : 0;
    fillPolygon(rings, grid, (row, i0, i1) => {
      for (let i = i0; i < i1; i++) {
        const k = row + i;
        const c = k * 4;
        cover[c] = r;
        cover[c + 1] = g;
        cover[c + 2] = b;
        cover[c + 3] = a;
        if (isPier) {
          // A wharf deck is land, however much water the polygon overlaps.
          waterMask[k] = 0;
          if (deck > deckElev[k]) deckElev[k] = deck;
        }
      }
    });
  }

  return { grid, cover, waterMask, waterDepth, waterElev, deckElev };
}
