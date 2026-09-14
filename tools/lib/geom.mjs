/**
 * Planar geometry helpers used by every extractor: OSM multipolygon ring
 * stitching, orientation/area, simplification, point-in-polygon and a uniform
 * grid index for the "is this tree inside a building?" style queries.
 *
 * All functions work on flat `[x0,z0, x1,z1, ...]` arrays in world metres unless
 * stated otherwise. Rings are stored *open* (last point != first point), matching
 * `BuildingRecord.outline` in src/core/types.ts.
 */

/** Signed area of a flat ring. Positive = CCW in a +X-right/+Z-down frame... */
export function signedArea(ring) {
  let s = 0;
  const n = ring.length / 2;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    s += (ring[j * 2] * ring[i * 2 + 1]) - (ring[i * 2] * ring[j * 2 + 1]);
  }
  return s / 2;
}

export const area = (ring) => Math.abs(signedArea(ring));

/**
 * World space is +X east, +Z south, so it is left-handed when drawn as (x, z) on
 * paper: a ring that is counter-clockwise when viewed from above (+Y down the -Y
 * axis, the way the camera sees it) has a *negative* shoelace value in (x, z).
 * `ensureWinding(ring, true)` returns a ring that is CCW as seen from above.
 */
export function ensureWinding(ring, ccwFromAbove) {
  const s = signedArea(ring);
  const isCcwFromAbove = s < 0;
  if (isCcwFromAbove !== ccwFromAbove) reverseRing(ring);
  return ring;
}

export function reverseRing(ring) {
  const n = ring.length / 2;
  for (let i = 0, j = n - 1; i < j; i++, j--) {
    const x = ring[i * 2], z = ring[i * 2 + 1];
    ring[i * 2] = ring[j * 2]; ring[i * 2 + 1] = ring[j * 2 + 1];
    ring[j * 2] = x; ring[j * 2 + 1] = z;
  }
  return ring;
}

/** Drop the duplicated closing vertex and any repeated/collinear-degenerate points. */
export function cleanRing(ring, eps = 0.05) {
  const out = [];
  const n = ring.length / 2;
  for (let i = 0; i < n; i++) {
    const x = ring[i * 2], z = ring[i * 2 + 1];
    if (!Number.isFinite(x) || !Number.isFinite(z)) continue;
    const m = out.length;
    if (m >= 2 && Math.abs(out[m - 2] - x) < eps && Math.abs(out[m - 1] - z) < eps) continue;
    out.push(x, z);
  }
  // closing vertex
  while (out.length >= 4 &&
         Math.abs(out[0] - out[out.length - 2]) < eps &&
         Math.abs(out[1] - out[out.length - 1]) < eps) {
    out.length -= 2;
  }
  return out;
}

export function centroid(ring) {
  let a = 0, cx = 0, cz = 0;
  const n = ring.length / 2;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const x0 = ring[j * 2], z0 = ring[j * 2 + 1];
    const x1 = ring[i * 2], z1 = ring[i * 2 + 1];
    const f = x0 * z1 - x1 * z0;
    a += f; cx += (x0 + x1) * f; cz += (z0 + z1) * f;
  }
  if (Math.abs(a) < 1e-9) {
    let sx = 0, sz = 0;
    for (let i = 0; i < n; i++) { sx += ring[i * 2]; sz += ring[i * 2 + 1]; }
    return [sx / n, sz / n];
  }
  a *= 3;
  return [cx / a, cz / a];
}

export function bbox(ring) {
  let minX = Infinity, minZ = Infinity, maxX = -Infinity, maxZ = -Infinity;
  for (let i = 0; i < ring.length; i += 2) {
    if (ring[i] < minX) minX = ring[i];
    if (ring[i] > maxX) maxX = ring[i];
    if (ring[i + 1] < minZ) minZ = ring[i + 1];
    if (ring[i + 1] > maxZ) maxZ = ring[i + 1];
  }
  return [minX, minZ, maxX, maxZ];
}

/** Crossing-number point-in-polygon on a flat open ring. */
export function pointInRing(ring, x, z) {
  let inside = false;
  const n = ring.length / 2;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = ring[i * 2], zi = ring[i * 2 + 1];
    const xj = ring[j * 2], zj = ring[j * 2 + 1];
    if ((zi > z) !== (zj > z) && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
  }
  return inside;
}

export function pointInPolygon(poly, x, z) {
  if (!pointInRing(poly.outline, x, z)) return false;
  if (poly.holes) for (const h of poly.holes) if (pointInRing(h, x, z)) return false;
  return true;
}

/** Ramer-Douglas-Peucker on a flat polyline. */
export function simplify(pts, tol = 0.5) {
  const n = pts.length / 2;
  if (n < 3) return pts.slice();
  const keep = new Uint8Array(n);
  keep[0] = keep[n - 1] = 1;
  const stack = [[0, n - 1]];
  const t2 = tol * tol;
  while (stack.length) {
    const [a, b] = stack.pop();
    if (b - a < 2) continue;
    const ax = pts[a * 2], az = pts[a * 2 + 1];
    const bx = pts[b * 2], bz = pts[b * 2 + 1];
    const dx = bx - ax, dz = bz - az;
    const len2 = dx * dx + dz * dz;
    let best = -1, bestD = -1;
    for (let i = a + 1; i < b; i++) {
      const px = pts[i * 2] - ax, pz = pts[i * 2 + 1] - az;
      let d2;
      if (len2 < 1e-12) d2 = px * px + pz * pz;
      else {
        let t = (px * dx + pz * dz) / len2;
        t = t < 0 ? 0 : t > 1 ? 1 : t;
        const ex = px - dx * t, ez = pz - dz * t;
        d2 = ex * ex + ez * ez;
      }
      if (d2 > bestD) { bestD = d2; best = i; }
    }
    if (bestD > t2) { keep[best] = 1; stack.push([a, best], [best, b]); }
  }
  const out = [];
  for (let i = 0; i < n; i++) if (keep[i]) out.push(pts[i * 2], pts[i * 2 + 1]);
  return out;
}

/** Length of a flat polyline, metres. */
export function pathLength(pts) {
  let L = 0;
  for (let i = 2; i < pts.length; i += 2) {
    const dx = pts[i] - pts[i - 2], dz = pts[i + 1] - pts[i - 1];
    L += Math.hypot(dx, dz);
  }
  return L;
}

// ---------------------------------------------------------------------------
// OSM multipolygon assembly
// ---------------------------------------------------------------------------

const K = (p) => `${p.lat.toFixed(7)},${p.lon.toFixed(7)}`;

/**
 * Stitch a bag of OSM way geometries (arbitrary order and direction) into closed
 * rings. Input: array of `[{lat,lon}, ...]`. Output: array of closed rings as
 * `[{lat,lon}, ...]` with first == last removed.
 *
 * This is the fiddly half of relation handling: OSM guarantees only that the
 * member ways of one role form closed loops *collectively*.
 */
export function assembleRings(wayGeoms) {
  const rings = [];
  const open = wayGeoms.filter((g) => g && g.length >= 2).map((g) => g.slice());

  // Fast path: ways that are already closed.
  const remaining = [];
  for (const g of open) {
    if (K(g[0]) === K(g[g.length - 1]) && g.length >= 4) rings.push(g.slice(0, -1));
    else remaining.push(g);
  }

  // Index open fragments by endpoint.
  const byEnd = new Map();
  const add = (k, frag) => {
    let a = byEnd.get(k);
    if (!a) byEnd.set(k, (a = []));
    a.push(frag);
  };
  const frags = remaining.map((g, i) => ({ g, used: false, i }));
  for (const f of frags) { add(K(f.g[0]), f); add(K(f.g[f.g.length - 1]), f); }

  for (const seed of frags) {
    if (seed.used) continue;
    seed.used = true;
    let chain = seed.g.slice();
    let guard = 0;
    for (;;) {
      if (++guard > 5000) break;
      const endK = K(chain[chain.length - 1]);
      if (endK === K(chain[0])) break; // closed
      const cands = byEnd.get(endK);
      const next = cands && cands.find((f) => !f.used);
      if (!next) break;
      next.used = true;
      const g = next.g;
      if (K(g[0]) === endK) chain = chain.concat(g.slice(1));
      else chain = chain.concat(g.slice(0, -1).reverse());
    }
    if (chain.length >= 4 && K(chain[0]) === K(chain[chain.length - 1])) {
      rings.push(chain.slice(0, -1));
    }
    // Unclosed chains are dropped: a broken multipolygon would render as a
    // self-intersecting blob, which looks far worse than a missing footprint.
  }
  return rings;
}

/**
 * Group assembled outer/inner rings into polygons, assigning each inner ring to
 * the smallest outer ring that contains it.
 * @param {{outline:number[]}[]} outers  flat world-metre rings
 * @param {number[][]} inners
 */
export function assignHoles(outers, inners) {
  const polys = outers.map((outline) => ({ outline, holes: [], _a: area(outline), _bb: bbox(outline) }));
  polys.sort((a, b) => b._a - a._a);
  for (const inner of inners) {
    if (inner.length < 6) continue;
    const [cx, cz] = centroid(inner);
    let best = null;
    for (const p of polys) {
      if (cx < p._bb[0] || cx > p._bb[2] || cz < p._bb[1] || cz > p._bb[3]) continue;
      if (!pointInRing(p.outline, cx, cz)) continue;
      if (!best || p._a < best._a) best = p;
    }
    if (best) best.holes.push(inner);
  }
  return polys.map((p) => ({ outline: p.outline, holes: p.holes.length ? p.holes : undefined }));
}

// ---------------------------------------------------------------------------
// Uniform grid index over axis-aligned boxes
// ---------------------------------------------------------------------------

export class GridIndex {
  constructor(cell = 60) {
    this.cell = cell;
    this.map = new Map();
  }
  _key(i, j) { return i * 100003 + j; }
  insert(item, bb) {
    const c = this.cell;
    const i0 = Math.floor(bb[0] / c), i1 = Math.floor(bb[2] / c);
    const j0 = Math.floor(bb[1] / c), j1 = Math.floor(bb[3] / c);
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        const k = this._key(i, j);
        let a = this.map.get(k);
        if (!a) this.map.set(k, (a = []));
        a.push(item);
      }
    }
  }
  at(x, z) {
    const c = this.cell;
    return this.map.get(this._key(Math.floor(x / c), Math.floor(z / c))) || EMPTY;
  }
  near(x, z, r) {
    const c = this.cell;
    const i0 = Math.floor((x - r) / c), i1 = Math.floor((x + r) / c);
    const j0 = Math.floor((z - r) / c), j1 = Math.floor((z + r) / c);
    const out = new Set();
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        const a = this.map.get(this._key(i, j));
        if (a) for (const it of a) out.add(it);
      }
    }
    return out;
  }
}
const EMPTY = [];

// ---------------------------------------------------------------------------
// Deterministic hashing / RNG (stable across rebuilds, seeded from OSM ids)
// ---------------------------------------------------------------------------

export function hash32(str) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  h ^= h >>> 15; h = Math.imul(h, 2246822507) >>> 0;
  h ^= h >>> 13; h = Math.imul(h, 3266489909) >>> 0;
  return (h ^ (h >>> 16)) >>> 0;
}

/** mulberry32 — small, fast, deterministic. */
export function rng(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Stable pseudo-random unit float for (id, salt). */
export const rand1 = (id, salt) => hash32(`${id}|${salt}`) / 4294967296;
