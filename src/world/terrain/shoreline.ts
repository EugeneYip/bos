/**
 * Shoreline treatment.
 *
 * The shipped DEM is flat at roughly zero across the harbour and the Charles —
 * there is no bathymetry in it at all. Left alone that gives the water module a
 * dead-flat bed, no shallow-water colour gradient, and a coin-flip z-fight
 * between the ground and the water plane. So we carve the water polygons into
 * the heightfield: an exponential shelf that drops away from the shoreline at a
 * rate set by the size of the water body, and a matching guarantee that no land
 * cell sits below its local water plane.
 *
 * Boston has ~75 km of shoreline and it is the first thing anyone checks.
 */
import type { Heightfield } from './Heightfield';
import type { LandCover } from './landcover';
import { HARD } from './landcover';
import { signedDistanceDecimetres } from './raster';

export interface ShoreResult {
  /** Signed distance to the waterline in decimetres; negative inside water. */
  shoreDist: Int16Array;
  /** Deepest carved point, metres (negative). */
  deepest: number;
  /** Number of cells carved. */
  carved: number;
}

export function carveShoreline(hf: Heightfield, lc: LandCover): ShoreResult {
  const w = hf.width;
  const h = hf.height;
  const n = w * h;
  const shoreDist = signedDistanceDecimetres(lc.waterMask, w, h, hf.spacingX, hf.spacingZ);

  const data = hf.data;
  const { waterMask, waterDepth, waterElev, deckElev, cover } = lc;
  let deepest = 0;
  let carved = 0;

  for (let k = 0; k < n; k++) {
    const sd = shoreDist[k] * 0.1;
    const we = waterElev[k] * 0.01;

    if (waterMask[k]) {
      const din = -sd;
      const maxD = waterDepth[k] * 0.05;
      // A shelf that reaches ~63% of full depth at 12x the depth inshore, i.e.
      // a 1:12 bed slope — close to a real dredged harbour approach.
      const fall = Math.max(14, maxD * 12);
      const depth = maxD * (1 - Math.exp(-din / fall)) + Math.min(din * 0.06, 0.5);
      const target = we - depth;
      if (data[k] > target) { data[k] = target; carved++; }
      if (data[k] < deepest) deepest = data[k];

      // Silty bed: sand-dominant, no vegetation.
      const c = k * 4;
      cover[c] = 0;
      cover[c + 1] = 0;
      cover[c + 2] = 196;
      cover[c + 3] = HARD.gravel;
    } else {
      // Land must never dip below its local water plane near the shoreline, or
      // the water surface floods over it and the illusion dies instantly.
      const rise = sd < 15 ? 0.06 + sd * 0.028 : 0.48;
      const floor = we + rise;
      if (data[k] < floor) data[k] = floor;
    }

    const deck = deckElev[k];
    if (deck) {
      const y = deck * 0.05;
      if (data[k] < y) data[k] = y;
    }
  }

  smoothNearShore(data, shoreDist, w, h);
  hf.refreshRange();
  return { shoreDist, deepest, carved };
}

/**
 * One light 3x3 pass restricted to a band around the waterline. The polygon
 * rasterisation is binary, so without this the shore reads as a staircase of
 * 4.5 m steps under a grazing sun.
 */
function smoothNearShore(data: Float32Array, sd: Int16Array, w: number, h: number): void {
  const BAND = 90; // decimetres
  const src = new Float32Array(data);
  for (let j = 1; j < h - 1; j++) {
    const row = j * w;
    for (let i = 1; i < w - 1; i++) {
      const k = row + i;
      const d = sd[k];
      if (d > BAND || d < -BAND) continue;
      const s = src[k - w - 1] + src[k - w] + src[k - w + 1]
        + src[k - 1] + src[k] * 4 + src[k + 1]
        + src[k + w - 1] + src[k + w] + src[k + w + 1];
      data[k] = s * (1 / 12);
    }
  }
}
