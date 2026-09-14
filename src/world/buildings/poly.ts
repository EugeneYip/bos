/**
 * Polygon toolkit for building footprints.
 *
 * Rings are flat arrays of world metres, `[x0,z0, x1,z1, ...]`, open (the last
 * point is not a repeat of the first).
 *
 * ## Winding convention
 *
 * The world is Y-up with +X east and +Z south, so the XZ plane seen from above
 * is *left*-handed. Working that through once, so nothing downstream has to:
 *
 * - Canonical outer ring = **positive** shoelace area in (x,z).
 * - For an edge d = (dx,dz) of such a ring the **outward** horizontal normal is
 *   `(dz, 0, -dx)`.
 * - An **up**-facing triangle has **negative** (x,z) shoelace area.
 * - Holes are stored with negative area (opposite of the outer ring).
 *
 * Real OSM geometry is dirty: duplicate points, needle spikes, reversed
 * winding, rings that touch themselves, holes outside their outer ring. Every
 * function here is total — it returns `null` rather than throwing, and callers
 * skip the building instead of killing the whole load.
 *
 * Nothing here imports three.js, so the entire meshing pipeline can be hosted
 * in a Web Worker without duplicating the renderer into the worker bundle.
 */
import { earcut } from './earcut';

export type Ring = number[];

/** Signed shoelace area of a flat ring. Positive = canonical outer winding. */
export function ringArea(r: Ring): number {
  const n = r.length >> 1;
  if (n < 3) return 0;
  let a = 0;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    a += r[j * 2] * r[i * 2 + 1] - r[i * 2] * r[j * 2 + 1];
  }
  return a * 0.5;
}

export function ringPerimeter(r: Ring): number {
  const n = r.length >> 1;
  let p = 0;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    p += Math.hypot(r[i * 2] - r[j * 2], r[i * 2 + 1] - r[j * 2 + 1]);
  }
  return p;
}

export function reverseRing(r: Ring): Ring {
  const out: Ring = new Array(r.length);
  const n = r.length >> 1;
  for (let i = 0; i < n; i++) {
    out[i * 2] = r[(n - 1 - i) * 2];
    out[i * 2 + 1] = r[(n - 1 - i) * 2 + 1];
  }
  return out;
}

/** Area-weighted centroid; falls back to the vertex average for degenerate rings. */
export function ringCentroid(r: Ring): [number, number] {
  const n = r.length >> 1;
  if (n === 0) return [0, 0];
  let a = 0;
  let cx = 0;
  let cz = 0;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const cross = r[j * 2] * r[i * 2 + 1] - r[i * 2] * r[j * 2 + 1];
    a += cross;
    cx += (r[j * 2] + r[i * 2]) * cross;
    cz += (r[j * 2 + 1] + r[i * 2 + 1]) * cross;
  }
  if (Math.abs(a) < 1e-7) {
    let sx = 0;
    let sz = 0;
    for (let i = 0; i < n; i++) {
      sx += r[i * 2];
      sz += r[i * 2 + 1];
    }
    return [sx / n, sz / n];
  }
  return [cx / (3 * a), cz / (3 * a)];
}

export interface Bounds2 {
  minX: number;
  minZ: number;
  maxX: number;
  maxZ: number;
}

export function ringBounds(r: Ring): Bounds2 {
  let minX = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxZ = -Infinity;
  for (let i = 0; i < r.length; i += 2) {
    if (r[i] < minX) minX = r[i];
    if (r[i] > maxX) maxX = r[i];
    if (r[i + 1] < minZ) minZ = r[i + 1];
    if (r[i + 1] > maxZ) maxZ = r[i + 1];
  }
  return { minX, minZ, maxX, maxZ };
}

/** Standard crossing-number test. Points exactly on an edge are undefined-ish. */
export function pointInRing(r: Ring, x: number, z: number): boolean {
  const n = r.length >> 1;
  let inside = false;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = r[i * 2];
    const zi = r[i * 2 + 1];
    const xj = r[j * 2];
    const zj = r[j * 2 + 1];
    if (zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi || 1e-12) + xi) inside = !inside;
  }
  return inside;
}

/** Shortest distance from a point to the ring boundary (not the interior). */
export function distanceToRing(r: Ring, x: number, z: number): number {
  const n = r.length >> 1;
  let best = Infinity;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const ax = r[j * 2];
    const az = r[j * 2 + 1];
    const bx = r[i * 2];
    const bz = r[i * 2 + 1];
    const dx = bx - ax;
    const dz = bz - az;
    const len2 = dx * dx + dz * dz;
    let t = len2 > 1e-12 ? ((x - ax) * dx + (z - az) * dz) / len2 : 0;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const d = Math.hypot(x - (ax + dx * t), z - (az + dz * t));
    if (d < best) best = d;
  }
  return best;
}

/**
 * Clean a raw ring: drop non-finite points, collapse duplicates and needle
 * spikes, drop near-collinear vertices, force canonical winding.
 * Returns `null` if what is left is not a usable polygon.
 */
export function sanitizeRing(src: readonly number[], minArea: number, outer = true): Ring | null {
  if (!src || src.length < 6) return null;

  // 1. finite points only, and drop a repeated closing point
  const pts: number[] = [];
  for (let i = 0; i + 1 < src.length; i += 2) {
    const x = src[i];
    const z = src[i + 1];
    if (!Number.isFinite(x) || !Number.isFinite(z)) continue;
    if (Math.abs(x) > 2e5 || Math.abs(z) > 2e5) continue;
    const n = pts.length;
    if (n >= 2 && Math.abs(pts[n - 2] - x) < 1e-4 && Math.abs(pts[n - 1] - z) < 1e-4) continue;
    pts.push(x, z);
  }
  let n = pts.length >> 1;
  if (n >= 3 && Math.abs(pts[0] - pts[(n - 1) * 2]) < 1e-4 && Math.abs(pts[1] - pts[(n - 1) * 2 + 1]) < 1e-4) {
    pts.length -= 2;
    n--;
  }
  if (n < 3) return null;

  // 2. remove spikes and near-collinear vertices (one sweep is enough in practice)
  const kept: number[] = [];
  for (let i = 0; i < n; i++) {
    const px = pts[((i - 1 + n) % n) * 2];
    const pz = pts[((i - 1 + n) % n) * 2 + 1];
    const cx = pts[i * 2];
    const cz = pts[i * 2 + 1];
    const nx = pts[((i + 1) % n) * 2];
    const nz = pts[((i + 1) % n) * 2 + 1];
    const ax = cx - px;
    const az = cz - pz;
    const bx = nx - cx;
    const bz = nz - cz;
    const la = Math.hypot(ax, az);
    const lb = Math.hypot(bx, bz);
    if (la < 1e-3 || lb < 1e-3) continue;
    const cross = (ax * bz - az * bx) / (la * lb);
    const dot = (ax * bx + az * bz) / (la * lb);
    // collinear continuation (dot ~ 1) or a perfect spike back (dot ~ -1)
    if (Math.abs(cross) < 2.5e-3 && dot > 0) continue;
    if (dot < -0.9998) continue;
    kept.push(cx, cz);
  }
  const use = kept.length >= 6 ? kept : pts;
  if (use.length < 6) return null;

  const area = ringArea(use);
  if (!Number.isFinite(area) || Math.abs(area) < minArea) return null;

  const wantPositive = outer;
  const isPositive = area > 0;
  return isPositive === wantPositive ? use : reverseRing(use);
}

/** Douglas–Peucker on a closed ring; keeps the two extreme points as anchors. */
export function simplifyRing(r: Ring, tol: number): Ring {
  const n = r.length >> 1;
  if (n <= 4 || tol <= 0) return r;

  // anchor on the two mutually most-distant-ish vertices
  let a = 0;
  let best = -1;
  const [cx, cz] = ringCentroid(r);
  for (let i = 0; i < n; i++) {
    const d = (r[i * 2] - cx) ** 2 + (r[i * 2 + 1] - cz) ** 2;
    if (d > best) {
      best = d;
      a = i;
    }
  }
  let b = a;
  best = -1;
  for (let i = 0; i < n; i++) {
    const d = (r[i * 2] - r[a * 2]) ** 2 + (r[i * 2 + 1] - r[a * 2 + 1]) ** 2;
    if (d > best) {
      best = d;
      b = i;
    }
  }
  if (a === b) return r;

  const idx: number[] = [];
  const chain = (i0: number, i1: number): void => {
    // walk forward from i0 to i1 (cyclic)
    const count = (i1 - i0 + n) % n;
    if (count < 2) return;
    let far = -1;
    let farD = -1;
    const x0 = r[i0 * 2];
    const z0 = r[i0 * 2 + 1];
    const x1 = r[i1 * 2];
    const z1 = r[i1 * 2 + 1];
    const dx = x1 - x0;
    const dz = z1 - z0;
    const len = Math.hypot(dx, dz) || 1e-6;
    for (let k = 1; k < count; k++) {
      const i = (i0 + k) % n;
      const d = Math.abs((r[i * 2] - x0) * dz - (r[i * 2 + 1] - z0) * dx) / len;
      if (d > farD) {
        farD = d;
        far = i;
      }
    }
    if (farD > tol && far >= 0) {
      chain(i0, far);
      idx.push(far);
      chain(far, i1);
    }
  };

  idx.push(a);
  chain(a, b);
  idx.push(b);
  chain(b, a);

  if (idx.length < 3) return r;
  const out: Ring = [];
  for (const i of idx) out.push(r[i * 2], r[i * 2 + 1]);
  const sane = sanitizeRing(out, 0.5, ringArea(r) > 0);
  return sane ?? r;
}

// ---------------------------------------------------------------------------
// Oriented bounding box (rotating calipers over the convex hull)
// ---------------------------------------------------------------------------

export interface Obb {
  cx: number;
  cz: number;
  /** Unit vector of the long axis. */
  ux: number;
  uz: number;
  /** Half-extent along the long axis. */
  eu: number;
  /** Half-extent along the short (perpendicular) axis. */
  ev: number;
  angle: number;
}

export function convexHull(r: Ring): Ring {
  const n = r.length >> 1;
  if (n < 3) return r.slice();
  const pts: Array<[number, number]> = [];
  for (let i = 0; i < n; i++) pts.push([r[i * 2], r[i * 2 + 1]]);
  pts.sort((p, q) => (p[0] === q[0] ? p[1] - q[1] : p[0] - q[0]));

  const cross = (o: [number, number], a: [number, number], b: [number, number]): number =>
    (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);

  const lower: Array<[number, number]> = [];
  for (const p of pts) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop();
    lower.push(p);
  }
  const upper: Array<[number, number]> = [];
  for (let i = pts.length - 1; i >= 0; i--) {
    const p = pts[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop();
    upper.push(p);
  }
  lower.pop();
  upper.pop();
  const hull = lower.concat(upper);
  if (hull.length < 3) return r.slice();
  const out: Ring = [];
  for (const p of hull) out.push(p[0], p[1]);
  return out;
}

/** Minimum-area enclosing rectangle. `u` always points along the longer side. */
export function computeObb(r: Ring): Obb {
  const hull = convexHull(r);
  const hn = hull.length >> 1;
  const [cx0, cz0] = ringCentroid(r);
  if (hn < 3) {
    const b = ringBounds(r);
    return {
      cx: (b.minX + b.maxX) / 2,
      cz: (b.minZ + b.maxZ) / 2,
      ux: 1,
      uz: 0,
      eu: Math.max(0.5, (b.maxX - b.minX) / 2),
      ev: Math.max(0.5, (b.maxZ - b.minZ) / 2),
      angle: 0,
    };
  }

  let bestArea = Infinity;
  let bestAx = 1;
  let bestAz = 0;
  let bestMin = [0, 0];
  let bestMax = [0, 0];

  for (let i = 0, j = hn - 1; i < hn; j = i++) {
    let ax = hull[i * 2] - hull[j * 2];
    let az = hull[i * 2 + 1] - hull[j * 2 + 1];
    const len = Math.hypot(ax, az);
    if (len < 1e-6) continue;
    ax /= len;
    az /= len;
    let minU = Infinity;
    let maxU = -Infinity;
    let minV = Infinity;
    let maxV = -Infinity;
    for (let k = 0; k < hn; k++) {
      const px = hull[k * 2] - cx0;
      const pz = hull[k * 2 + 1] - cz0;
      const u = px * ax + pz * az;
      const v = -px * az + pz * ax;
      if (u < minU) minU = u;
      if (u > maxU) maxU = u;
      if (v < minV) minV = v;
      if (v > maxV) maxV = v;
    }
    const area = (maxU - minU) * (maxV - minV);
    if (area < bestArea) {
      bestArea = area;
      bestAx = ax;
      bestAz = az;
      bestMin = [minU, minV];
      bestMax = [maxU, maxV];
    }
  }

  let eu = (bestMax[0] - bestMin[0]) / 2;
  let ev = (bestMax[1] - bestMin[1]) / 2;
  const mu = (bestMax[0] + bestMin[0]) / 2;
  const mv = (bestMax[1] + bestMin[1]) / 2;
  let ux = bestAx;
  let uz = bestAz;
  const cx = cx0 + ux * mu - uz * mv;
  const cz = cz0 + uz * mu + ux * mv;

  if (ev > eu) {
    // swap so u is the long axis: perpendicular of (ux,uz) is (-uz,ux)
    const t = eu;
    eu = ev;
    ev = t;
    const nx = -uz;
    const nz = ux;
    ux = nx;
    uz = nz;
  }
  return { cx, cz, ux, uz, eu: Math.max(eu, 0.25), ev: Math.max(ev, 0.25), angle: Math.atan2(uz, ux) };
}

// ---------------------------------------------------------------------------
// Inset / offset
// ---------------------------------------------------------------------------

/**
 * Offset every edge inward by `d` and intersect neighbouring offset lines.
 * Keeps a 1:1 vertex correspondence with the source ring, which is what the
 * roof skirt builders rely on. Returns `null` when the result self-destructs.
 */
export function insetRing(r: Ring, d: number): Ring | null {
  const n = r.length >> 1;
  if (n < 3 || d <= 0) return null;

  const out: Ring = new Array(n * 2);
  for (let i = 0; i < n; i++) {
    const pi = (i - 1 + n) % n;
    const px = r[pi * 2];
    const pz = r[pi * 2 + 1];
    const cx = r[i * 2];
    const cz = r[i * 2 + 1];
    const ni = (i + 1) % n;
    const nx = r[ni * 2];
    const nz = r[ni * 2 + 1];

    // inward normals of the two adjacent edges (outward is (dz,-dx))
    let e1x = cx - px;
    let e1z = cz - pz;
    let l1 = Math.hypot(e1x, e1z);
    let e2x = nx - cx;
    let e2z = nz - cz;
    let l2 = Math.hypot(e2x, e2z);
    if (l1 < 1e-6 || l2 < 1e-6) return null;
    e1x /= l1;
    e1z /= l1;
    e2x /= l2;
    e2z /= l2;
    const n1x = -e1z;
    const n1z = e1x;
    const n2x = -e2z;
    const n2z = e2x;

    // bisector; clamp the miter so sharp corners do not shoot off to infinity
    let bx = n1x + n2x;
    let bz = n1z + n2z;
    const bl = Math.hypot(bx, bz);
    if (bl < 1e-4) {
      bx = n1x;
      bz = n1z;
    } else {
      bx /= bl;
      bz /= bl;
    }
    const cosHalf = bx * n1x + bz * n1z;
    const scale = Math.min(1 / Math.max(cosHalf, 0.2), 5);
    out[i * 2] = cx + bx * d * scale;
    out[i * 2 + 1] = cz + bz * d * scale;
  }

  const a0 = ringArea(r);
  const a1 = ringArea(out);
  if (!Number.isFinite(a1)) return null;
  if (Math.sign(a1) !== Math.sign(a0)) return null;
  if (Math.abs(a1) >= Math.abs(a0) * 0.995) return null;
  if (Math.abs(a1) < 0.35) return null;

  // spot-check containment so badly folded results are rejected
  for (let i = 0; i < n; i++) {
    if (!pointInRing(r, out[i * 2], out[i * 2 + 1])) return null;
  }
  return out;
}

/** `insetRing` with a shrinking retry, for footprints that resist the full offset. */
export function insetRingSafe(r: Ring, d: number): { ring: Ring; d: number } | null {
  let dd = d;
  for (let k = 0; k < 5; k++) {
    const out = insetRing(r, dd);
    if (out) return { ring: out, d: dd };
    dd *= 0.55;
    if (dd < 0.12) break;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Half-plane clipping (used to split a footprint along a roof ridge)
// ---------------------------------------------------------------------------

/** Sutherland–Hodgman: keep the part of `r` where `nx*x + nz*z <= c`. */
export function clipHalfPlane(r: Ring, nx: number, nz: number, c: number): Ring {
  const n = r.length >> 1;
  const out: Ring = [];
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xj = r[j * 2];
    const zj = r[j * 2 + 1];
    const xi = r[i * 2];
    const zi = r[i * 2 + 1];
    const dj = nx * xj + nz * zj - c;
    const di = nx * xi + nz * zi - c;
    const inJ = dj <= 0;
    const inI = di <= 0;
    if (inJ !== inI) {
      const t = dj / (dj - di || 1e-12);
      out.push(xj + (xi - xj) * t, zj + (zi - zj) * t);
    }
    if (inI) out.push(xi, zi);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Triangulation
// ---------------------------------------------------------------------------

export interface Tri2 {
  /** Flat [x,z,...] of the merged outer+hole vertex list. */
  verts: number[];
  /** Triangle indices into `verts` (3 per face). */
  indices: number[];
  /** Number of vertices belonging to the outer ring. */
  outerCount: number;
}

/**
 * Triangulate an outer ring with optional holes.
 *
 * Ear clipping never throws and degrades to "something plausible" on
 * self-intersecting input, which is exactly what OSM footprints need.
 *
 * Triangles are emitted so their (x,z) shoelace area is negative, i.e. they
 * face **up** (+Y). Pass `up = false` for downward-facing caps.
 */
export function triangulateRing(outer: Ring, holes: Ring[] | undefined, up: boolean): Tri2 | null {
  const on = outer.length >> 1;
  if (on < 3) return null;

  const verts: number[] = outer.slice();
  const holeStarts: number[] = [];
  if (holes) {
    for (const h of holes) {
      const hn = h.length >> 1;
      if (hn < 3) continue;
      holeStarts.push(verts.length >> 1);
      for (let i = 0; i < hn; i++) verts.push(h[i * 2], h[i * 2 + 1]);
    }
  }

  let faces: number[];
  try {
    faces = earcut(verts, holeStarts.length ? holeStarts : null);
  } catch {
    return null;
  }
  if (faces.length < 3) return null;

  const indices: number[] = [];
  for (let i = 0; i + 2 < faces.length; i += 3) {
    const a = faces[i];
    const b = faces[i + 1];
    const c = faces[i + 2];
    if (a === b || b === c || a === c) continue;
    const ax = verts[a * 2];
    const az = verts[a * 2 + 1];
    const bx = verts[b * 2];
    const bz = verts[b * 2 + 1];
    const cx = verts[c * 2];
    const cz = verts[c * 2 + 1];
    const area2 = (bx - ax) * (cz - az) - (bz - az) * (cx - ax);
    if (Math.abs(area2) < 1e-9) continue;
    // negative (x,z) area == up-facing
    const faceUp = area2 < 0;
    if (faceUp === up) indices.push(a, b, c);
    else indices.push(a, c, b);
  }
  if (indices.length < 3) return null;
  return { verts, indices, outerCount: on };
}

/** Longest-edge index of a ring, used to orient roof ridges and dormer rows. */
export function longestEdge(r: Ring): number {
  const n = r.length >> 1;
  let best = 0;
  let bestLen = -1;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const d = Math.hypot(r[j * 2] - r[i * 2], r[j * 2 + 1] - r[i * 2 + 1]);
    if (d > bestLen) {
      bestLen = d;
      best = i;
    }
  }
  return best;
}

/**
 * An interior point that is comfortably away from the boundary — the "pole of
 * inaccessibility", approximated with a coarse grid search. Used for pyramid
 * apexes and for anchoring bulkheads on funny-shaped roofs.
 */
export function interiorPoint(r: Ring): [number, number] {
  const [cx, cz] = ringCentroid(r);
  if (pointInRing(r, cx, cz)) return [cx, cz];
  const b = ringBounds(r);
  let best: [number, number] = [cx, cz];
  let bestD = -1;
  const steps = 9;
  for (let i = 1; i < steps; i++) {
    for (let j = 1; j < steps; j++) {
      const x = b.minX + ((b.maxX - b.minX) * i) / steps;
      const z = b.minZ + ((b.maxZ - b.minZ) * j) / steps;
      if (!pointInRing(r, x, z)) continue;
      const d = distanceToRing(r, x, z);
      if (d > bestD) {
        bestD = d;
        best = [x, z];
      }
    }
  }
  return best;
}
