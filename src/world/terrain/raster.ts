/**
 * Polygon scanline rasteriser and chamfer distance transform, both specialised
 * for the terrain's regular grid. Used to burn the OSM area polygons into the
 * land-cover maps and the water mask.
 */

export interface RasterGrid {
  width: number;
  height: number;
  originX: number;
  originZ: number;
  spacingX: number;
  spacingZ: number;
}

interface Edge {
  /** Grid-space endpoints, ordered so z0 < z1. */
  x0: number; z0: number; x1: number; z1: number;
  /** dx/dz. */
  slope: number;
  jMin: number;
  jMax: number;
}

/**
 * Fills `rings` (outer ring first, then holes; each flat `[x,z,...]` in world
 * metres) using the even-odd rule, which handles holes and self-overlap without
 * caring about winding order — OSM multipolygons are inconsistent about it.
 *
 * `span(rowOffset, i0, i1)` is called with an inclusive-exclusive column range.
 */
export function fillPolygon(
  rings: readonly (readonly number[])[],
  g: RasterGrid,
  span: (rowOffset: number, i0: number, i1: number, j: number) => void,
): void {
  const edges: Edge[] = [];
  const invSX = 1 / g.spacingX;
  const invSZ = 1 / g.spacingZ;
  let jLo = Infinity;
  let jHi = -Infinity;

  for (const ring of rings) {
    const n = ring.length;
    if (n < 6) continue;
    for (let a = 0; a < n; a += 2) {
      const b = (a + 2) % n;
      const ax = (ring[a] - g.originX) * invSX;
      const az = (ring[a + 1] - g.originZ) * invSZ;
      const bx = (ring[b] - g.originX) * invSX;
      const bz = (ring[b + 1] - g.originZ) * invSZ;
      if (az === bz) continue;
      const up = az < bz;
      const z0 = up ? az : bz;
      const z1 = up ? bz : az;
      const x0 = up ? ax : bx;
      const x1 = up ? bx : ax;
      // Sample at row centres (integer j) using the half-open rule [z0, z1).
      const jMin = Math.max(0, Math.ceil(z0));
      const jMax = Math.min(g.height - 1, Math.ceil(z1) - 1);
      if (jMax < jMin) continue;
      edges.push({ x0, z0, x1, z1, slope: (x1 - x0) / (z1 - z0), jMin, jMax });
      if (jMin < jLo) jLo = jMin;
      if (jMax > jHi) jHi = jMax;
    }
  }
  if (!edges.length || jHi < jLo) return;

  edges.sort((p, q) => p.jMin - q.jMin);

  const active: Edge[] = [];
  const xs: number[] = [];
  let next = 0;
  const w = g.width;

  for (let j = jLo; j <= jHi; j++) {
    while (next < edges.length && edges[next].jMin <= j) active.push(edges[next++]);
    if (!active.length) continue;

    xs.length = 0;
    for (let k = active.length - 1; k >= 0; k--) {
      const e = active[k];
      if (e.jMax < j) { active[k] = active[active.length - 1]; active.pop(); continue; }
      xs.push(e.x0 + (j - e.z0) * e.slope);
    }
    if (xs.length < 2) continue;
    xs.sort(numeric);

    const rowOffset = j * w;
    for (let k = 0; k + 1 < xs.length; k += 2) {
      let i0 = Math.round(xs[k]);
      let i1 = Math.round(xs[k + 1]);
      if (i1 <= 0 || i0 >= w) continue;
      if (i0 < 0) i0 = 0;
      if (i1 > w) i1 = w;
      if (i1 > i0) span(rowOffset, i0, i1, j);
    }
  }
}

function numeric(a: number, b: number): number { return a - b; }

/**
 * Unsigned chamfer (3-4) distance transform in metres, seeded from the boundary
 * between set and unset cells of `mask`. The result is then signed: negative
 * inside the mask, positive outside. Stored in decimetres in an Int16Array so a
 * city-sized grid costs 9 MB rather than 18.
 */
export function signedDistanceDecimetres(
  mask: Uint8Array,
  w: number,
  h: number,
  cellX: number,
  cellZ: number,
): Int16Array {
  const INF = 1e9;
  const d = new Float32Array(w * h).fill(INF);
  const cell = (cellX + cellZ) * 0.5;
  const ORTH = 0.95509 * cell;
  const DIAG = 1.36930 * cell;
  const half = cell * 0.5;

  // Seed: any cell whose 4-neighbourhood straddles the boundary sits half a
  // cell from the true edge.
  for (let j = 0; j < h; j++) {
    const row = j * w;
    for (let i = 0; i < w; i++) {
      const k = row + i;
      const m = mask[k];
      const l = i > 0 ? mask[k - 1] : m;
      const r = i < w - 1 ? mask[k + 1] : m;
      const u = j > 0 ? mask[k - w] : m;
      const dn = j < h - 1 ? mask[k + w] : m;
      if (m !== l || m !== r || m !== u || m !== dn) d[k] = half;
    }
  }

  // Forward pass.
  for (let j = 0; j < h; j++) {
    const row = j * w;
    for (let i = 0; i < w; i++) {
      const k = row + i;
      let v = d[k];
      if (j > 0) {
        const up = k - w;
        if (d[up] + ORTH < v) v = d[up] + ORTH;
        if (i > 0 && d[up - 1] + DIAG < v) v = d[up - 1] + DIAG;
        if (i < w - 1 && d[up + 1] + DIAG < v) v = d[up + 1] + DIAG;
      }
      if (i > 0 && d[k - 1] + ORTH < v) v = d[k - 1] + ORTH;
      d[k] = v;
    }
  }
  // Backward pass.
  for (let j = h - 1; j >= 0; j--) {
    const row = j * w;
    for (let i = w - 1; i >= 0; i--) {
      const k = row + i;
      let v = d[k];
      if (j < h - 1) {
        const dn = k + w;
        if (d[dn] + ORTH < v) v = d[dn] + ORTH;
        if (i > 0 && d[dn - 1] + DIAG < v) v = d[dn - 1] + DIAG;
        if (i < w - 1 && d[dn + 1] + DIAG < v) v = d[dn + 1] + DIAG;
      }
      if (i < w - 1 && d[k + 1] + ORTH < v) v = d[k + 1] + ORTH;
      d[k] = v;
    }
  }

  const out = new Int16Array(w * h);
  for (let k = 0; k < out.length; k++) {
    let v = d[k] * 10;
    if (v > 32000) v = 32000;
    out[k] = mask[k] ? -v : v;
  }
  return out;
}
