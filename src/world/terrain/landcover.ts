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

/** Dilation radius around the paved surfaces, in metres. */
const INFIELD_REACH = 220;
/** Coarse cell size for the dilation, in metres. */
const INFIELD_CELL = 32;

/**
 * Where Logan's mown grass goes: `reach` is the aeroway mask dilated by
 * {@link INFIELD_REACH}, `mask` is the undilated pavement itself.
 *
 * Logan is the one place where the urban default is plainly wrong. Its aeroway
 * polygons cover the runways, taxiways and aprons; the land between them is
 * mown grass, and nothing in the extract says so. Left as the default it
 * splats to 58% gravel, which rendered the whole peninsula as a pale sheet --
 * brighter than the buildings standing on it and twice the luma of a city
 * road.
 *
 * Dilating rather than filling a hull matters: a convex hull of Logan's
 * runways reaches well into East Boston, and the axis-aligned box of one
 * runway on a 20-degree bearing is 1100 x 2800 m. The dilation runs on a
 * coarse grid because a separable max filter at a 130 m radius over four
 * million cells is not something to do at load.
 */
function airfieldInfieldMask(
  areas: readonly AreaRecord[],
  grid: RasterGrid,
): { mask: Uint8Array; reach: Uint8Array } | null {
  const paved = areas.filter((a) => a.kind === 'runway');
  if (!paved.length) return null;

  const n = grid.width * grid.height;
  const mask = new Uint8Array(n);
  let minI = grid.width, maxI = -1, minJ = grid.height, maxJ = -1;
  for (const rec of paved) {
    const rings: readonly number[][] = rec.holes?.length ? [rec.outline, ...rec.holes] : [rec.outline];
    fillPolygon(rings, grid, (row, i0, i1, j) => {
      for (let i = i0; i < i1; i++) mask[row + i] = 1;
      if (i0 < minI) minI = i0;
      if (i1 > maxI) maxI = i1;
      if (j < minJ) minJ = j;
      if (j > maxJ) maxJ = j;
    });
  }
  if (maxI < 0) return null;

  const stepI = Math.max(1, Math.round(INFIELD_CELL / grid.spacingX));
  const stepJ = Math.max(1, Math.round(INFIELD_CELL / grid.spacingZ));
  const padI = Math.ceil(INFIELD_REACH / (stepI * grid.spacingX));
  const padJ = Math.ceil(INFIELD_REACH / (stepJ * grid.spacingZ));
  const ci0 = Math.max(0, Math.floor(minI / stepI) - padI - 1);
  const ci1 = Math.min(Math.ceil(grid.width / stepI), Math.ceil(maxI / stepI) + padI + 1);
  const cj0 = Math.max(0, Math.floor(minJ / stepJ) - padJ - 1);
  const cj1 = Math.min(Math.ceil(grid.height / stepJ), Math.ceil(maxJ / stepJ) + padJ + 1);
  const cw = ci1 - ci0, ch = cj1 - cj0;
  if (cw <= 0 || ch <= 0) return null;

  const coarse = new Uint8Array(cw * ch);
  for (let cj = 0; cj < ch; cj++) {
    for (let ci = 0; ci < cw; ci++) {
      const j0 = (cj0 + cj) * stepJ, i0 = (ci0 + ci) * stepI;
      let hit = 0;
      for (let j = j0; j < Math.min(j0 + stepJ, grid.height) && !hit; j++) {
        const row = j * grid.width;
        for (let i = i0; i < Math.min(i0 + stepI, grid.width); i++) {
          if (mask[row + i]) { hit = 1; break; }
        }
      }
      coarse[cj * cw + ci] = hit;
    }
  }
  const tmp = new Uint8Array(cw * ch);
  for (let cj = 0; cj < ch; cj++) {
    for (let ci = 0; ci < cw; ci++) {
      let hit = 0;
      for (let d = -padI; d <= padI && !hit; d++) {
        const x = ci + d;
        if (x >= 0 && x < cw && coarse[cj * cw + x]) hit = 1;
      }
      tmp[cj * cw + ci] = hit;
    }
  }
  const reach = new Uint8Array(n);
  for (let cj = 0; cj < ch; cj++) {
    for (let ci = 0; ci < cw; ci++) {
      let hit = 0;
      for (let d = -padJ; d <= padJ && !hit; d++) {
        const y = cj + d;
        if (y >= 0 && y < ch && tmp[y * cw + ci]) hit = 1;
      }
      if (!hit) continue;
      const j0 = (cj0 + cj) * stepJ, i0 = (ci0 + ci) * stepI;
      for (let j = j0; j < Math.min(j0 + stepJ, grid.height); j++) {
        const row = j * grid.width;
        for (let i = i0; i < Math.min(i0 + stepI, grid.width); i++) reach[row + i] = 1;
      }
    }
  }
  return { mask, reach };
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
  /** 1 where some area polygon has had its say, so the infield fill leaves it. */
  const painted = new Uint8Array(n);

  // Default: bare urban ground. Roads and buildings cover most of it; what
  // shows through wants to read as grimy pavement, not as bright grass.
  for (let k = 0; k < n; k++) cover[k * 4 + 3] = HARD.urban;

  // --- airfield infield ---------------------------------------------------
  //
  // Logan is the one place where the urban default is plainly wrong. Its
  // aeroway polygons cover the runways, taxiways and aprons; the land between
  // them is mown grass, and there is no polygon in the extract that says so.
  // Left as the default it splats to 58% gravel, which rendered the whole
  // peninsula as a pale grey sheet -- brighter than the buildings on it and
  // twice the luma of a city road.
  //
  // So the aeroway mask is dilated and the surround painted grass, before
  // every other pass, so water still wins where the harbour reaches in and the
  // pavement still wins where it actually is. The dilation happens on a coarse
  // grid because a separable max filter over four million cells at a
  // 130 m radius is not something to do at load.
  const airfield = airfieldInfieldMask(areas, grid);

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
        painted[k] = 1;
        if (isPier) {
          // A wharf deck is land, however much water the polygon overlaps.
          waterMask[k] = 0;
          if (deck > deckElev[k]) deckElev[k] = deck;
        }
      }
    });
  }

  // Fill what is left between Logan's pavement with mown grass.
  //
  // Only cells no polygon touched. The extract already has 81 grass polygons
  // around the airport and 21 parking ones, and an earlier version of this ran
  // last and overrode everything except water -- which would have turned
  // Central Parking into a lawn. What it is for is the gaps between all of
  // that, which default to `HARD.urban` and splat to 58% gravel: a pale grey
  // sheet, brighter than the buildings standing on it and twice the luma of a
  // city road.
  if (airfield) {
    const g = KEYS.grass!;
    const { reach } = airfield;
    let filled = 0;
    let paved = 0;
    for (let k = 0; k < n; k++) {
      if (!reach[k] || waterMask[k]) continue;
      const c = k * 4;
      if (!painted[k]) {
        cover[c] = g.r;
        cover[c + 1] = g.g;
        cover[c + 2] = g.b;
        cover[c + 3] = g.a;
        filled++;
        continue;
      }
      // Airside ground that is not grass is pavement, so say so.
      //
      // Sowing only the untouched cells left long strips of the airfield
      // sitting in the hard-surface ramp's gravel band, which renders as a
      // pale sheet -- and the airport module draws its own dark apron mesh
      // over the middle of it, so the two met along hard edges and the
      // airfield came out as near-black slabs against near-white ones. There
      // is no gravel airside; whatever a polygon called it, if it is not
      // growing anything out here it is paved.
      if (cover[c] < 64) { cover[c + 3] = HARD.asphalt; paved++; }
    }
    console.info(`[LandCover] airfield infield ${filled} cells sown, ${paved} re-paved`);
  }

  return { grid, cover, waterMask, waterDepth, waterElev, deckElev };
}
