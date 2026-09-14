/**
 * 2D geometry helpers for the road network. Everything works on flat
 * `[x0,z0, x1,z1, ...]`-style arrays or on `{x,z}` pairs in the world XZ plane
 * (+X east, +Z south). Y is handled separately as a parallel elevation array.
 */

export interface V2 {
  x: number;
  z: number;
}

export const v2 = (x: number, z: number): V2 => ({ x, z });

export function sub(a: V2, b: V2): V2 {
  return { x: a.x - b.x, z: a.z - b.z };
}

export function add(a: V2, b: V2): V2 {
  return { x: a.x + b.x, z: a.z + b.z };
}

export function scale(a: V2, s: number): V2 {
  return { x: a.x * s, z: a.z * s };
}

export function dot(a: V2, b: V2): number {
  return a.x * b.x + a.z * b.z;
}

/** 2D cross product (z-component of the 3D cross of the XZ vectors). */
export function cross(a: V2, b: V2): number {
  return a.x * b.z - a.z * b.x;
}

export function len(a: V2): number {
  return Math.hypot(a.x, a.z);
}

export function dist(a: V2, b: V2): number {
  return Math.hypot(a.x - b.x, a.z - b.z);
}

export function norm(a: V2): V2 {
  const l = Math.hypot(a.x, a.z);
  return l > 1e-9 ? { x: a.x / l, z: a.z / l } : { x: 1, z: 0 };
}

/**
 * Left-hand normal in the world XZ plane (+X east, +Z south, Y up).
 * Facing east, left is north, so `perp((1,0)) = (0,-1)`.
 */
export function perp(a: V2): V2 {
  return { x: a.z, z: -a.x };
}

/** Inverse of {@link perp}: recovers the tangent from a left normal. */
export function unperp(n: V2): V2 {
  return { x: -n.z, z: n.x };
}

export function lerp2(a: V2, b: V2, t: number): V2 {
  return { x: a.x + (b.x - a.x) * t, z: a.z + (b.z - a.z) * t };
}

export function angleOf(a: V2): number {
  return Math.atan2(a.z, a.x);
}

/**
 * Intersects the rays `a + s*da` and `b + t*db`. Returns null when they are
 * close to parallel — callers fall back to a bevel in that case.
 */
export function rayIntersect(
  a: V2, da: V2, b: V2, db: V2,
): { p: V2; s: number; t: number } | null {
  const d = cross(da, db);
  if (Math.abs(d) < 1e-6) return null;
  const ab = sub(b, a);
  const s = cross(ab, db) / d;
  const t = cross(ab, da) / d;
  return { p: { x: a.x + da.x * s, z: a.z + da.z * s }, s, t };
}

/** Shoelace area; positive when the ring winds counter-clockwise in XZ. */
export function signedArea(ring: V2[]): number {
  let s = 0;
  for (let i = 0, n = ring.length; i < n; i++) {
    const a = ring[i];
    const b = ring[(i + 1) % n];
    s += a.x * b.z - b.x * a.z;
  }
  return s * 0.5;
}

export function polylineLength(pts: V2[]): number {
  let s = 0;
  for (let i = 1; i < pts.length; i++) s += dist(pts[i - 1], pts[i]);
  return s;
}

/** Cumulative arc length at each vertex. */
export function cumulative(pts: V2[]): number[] {
  const out = new Array<number>(pts.length);
  out[0] = 0;
  for (let i = 1; i < pts.length; i++) out[i] = out[i - 1] + dist(pts[i - 1], pts[i]);
  return out;
}

/** Removes consecutive duplicates below `eps` metres. */
export function dedupe(pts: V2[], ys: number[], eps = 0.05): { pts: V2[]; ys: number[] } {
  const p: V2[] = [];
  const y: number[] = [];
  for (let i = 0; i < pts.length; i++) {
    if (p.length === 0 || dist(p[p.length - 1], pts[i]) > eps) {
      p.push(pts[i]);
      y.push(ys[i] ?? 0);
    }
  }
  if (p.length === 1 && pts.length > 1) {
    p.push(pts[pts.length - 1]);
    y.push(ys[ys.length - 1] ?? 0);
  }
  return { pts: p, ys: y };
}

/**
 * Ramer-Douglas-Peucker on the XZ polyline, carrying the elevation array along.
 * Collapses the long dead-straight runs that dominate arterial geometry.
 */
export function simplify(pts: V2[], ys: number[], eps: number): { pts: V2[]; ys: number[] } {
  const n = pts.length;
  if (n <= 2) return { pts, ys };
  const keep = new Uint8Array(n);
  keep[0] = 1;
  keep[n - 1] = 1;
  const stack: Array<[number, number]> = [[0, n - 1]];

  while (stack.length) {
    const [i0, i1] = stack.pop()!;
    if (i1 - i0 < 2) continue;
    const a = pts[i0];
    const b = pts[i1];
    const d = sub(b, a);
    const l = len(d);
    let best = -1;
    let bestD = eps;
    for (let i = i0 + 1; i < i1; i++) {
      const p = pts[i];
      let dev: number;
      if (l < 1e-6) {
        dev = dist(p, a);
      } else {
        dev = Math.abs(cross(d, sub(p, a))) / l;
      }
      // Never simplify away a significant grade break either.
      const yLerp = ys[i0] + ((ys[i1] - ys[i0]) * (i - i0)) / (i1 - i0);
      dev = Math.max(dev, Math.abs((ys[i] ?? 0) - yLerp) * 1.5);
      if (dev > bestD) {
        bestD = dev;
        best = i;
      }
    }
    if (best >= 0) {
      keep[best] = 1;
      stack.push([i0, best], [best, i1]);
    }
  }

  const op: V2[] = [];
  const oy: number[] = [];
  for (let i = 0; i < n; i++) {
    if (keep[i]) {
      op.push(pts[i]);
      oy.push(ys[i] ?? 0);
    }
  }
  return { pts: op, ys: oy };
}

/**
 * Adaptive resampling: splits any segment longer than `maxSeg` so the ribbon
 * drapes onto terrain, and subdivides more finely where the polyline turns
 * sharply so curves stay smooth. Straight runs keep their sparse vertices.
 */
export function resample(
  pts: V2[], ys: number[], maxSeg: number, curveSeg: number,
): { pts: V2[]; ys: number[] } {
  const n = pts.length;
  if (n < 2) return { pts, ys };
  const op: V2[] = [pts[0]];
  const oy: number[] = [ys[0] ?? 0];

  for (let i = 1; i < n; i++) {
    const a = pts[i - 1];
    const b = pts[i];
    const l = dist(a, b);
    // Turn magnitude at either end of this segment decides the target density.
    let turn = 0;
    if (i - 2 >= 0) turn = Math.max(turn, turnAngle(pts[i - 2], a, b));
    if (i + 1 < n) turn = Math.max(turn, turnAngle(a, b, pts[i + 1]));
    const target = turn > 0.25 ? curveSeg : maxSeg;
    const steps = Math.max(1, Math.min(64, Math.ceil(l / target)));
    for (let s = 1; s <= steps; s++) {
      const t = s / steps;
      op.push(lerp2(a, b, t));
      oy.push((ys[i - 1] ?? 0) + ((ys[i] ?? 0) - (ys[i - 1] ?? 0)) * t);
    }
  }
  return { pts: op, ys: oy };
}

export function turnAngle(a: V2, b: V2, c: V2): number {
  const u = norm(sub(b, a));
  const v = norm(sub(c, b));
  return Math.acos(Math.max(-1, Math.min(1, dot(u, v))));
}

/**
 * Gentle low-pass on the elevation profile. Real roads are graded: they cut
 * through knolls and fill hollows instead of following every terrain wiggle.
 */
export function smoothProfile(ys: number[], passes = 2, strength = 0.5): number[] {
  let cur = ys.slice();
  for (let p = 0; p < passes; p++) {
    const next = cur.slice();
    for (let i = 1; i < cur.length - 1; i++) {
      next[i] = cur[i] + ((cur[i - 1] + cur[i + 1]) * 0.5 - cur[i]) * strength;
    }
    cur = next;
  }
  return cur;
}

/** Trims `d` metres off the head of a polyline, keeping the tangent direction. */
export function trimHead(pts: V2[], ys: number[], d: number): { pts: V2[]; ys: number[] } {
  if (d <= 1e-4) return { pts, ys };
  let remaining = d;
  for (let i = 1; i < pts.length; i++) {
    const l = dist(pts[i - 1], pts[i]);
    if (remaining < l - 1e-4) {
      const t = remaining / l;
      const p0 = lerp2(pts[i - 1], pts[i], t);
      const y0 = (ys[i - 1] ?? 0) + ((ys[i] ?? 0) - (ys[i - 1] ?? 0)) * t;
      return { pts: [p0, ...pts.slice(i)], ys: [y0, ...ys.slice(i)] };
    }
    remaining -= l;
  }
  return { pts: [], ys: [] };
}

export function reverse(pts: V2[], ys: number[]): { pts: V2[]; ys: number[] } {
  return { pts: pts.slice().reverse(), ys: ys.slice().reverse() };
}

/** Deterministic hash-based PRNG so every build of the city is identical. */
export function hash01(n: number): number {
  let x = Math.imul(n ^ 0x9e3779b9, 0x85ebca6b);
  x = Math.imul(x ^ (x >>> 13), 0xc2b2ae35);
  x ^= x >>> 16;
  return (x >>> 0) / 4294967296;
}

export function hashStr(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Ear-clipping triangulation for a simple polygon in the world XZ plane.
 * Winding-agnostic; always returns triples whose triangles face +Y. Falls back
 * to a fan if the polygon turns out to be degenerate.
 *
 * Internally the ring is mirrored (z -> -z) so the usual counter-clockwise
 * plane conventions apply; mirroring back flips the orientation to face up.
 */
export function triangulate(src: V2[]): number[] {
  const n = src.length;
  if (n < 3) return [];
  const ring: V2[] = new Array(n);
  for (let i = 0; i < n; i++) ring[i] = { x: src[i].x, z: -src[i].z };
  if (n === 3) return signedArea(ring) > 0 ? [0, 1, 2] : [0, 2, 1];

  const ccw = signedArea(ring) > 0;
  const idx: number[] = [];
  for (let i = 0; i < n; i++) idx.push(ccw ? i : n - 1 - i);

  const out: number[] = [];
  let guard = n * n + 16;
  while (idx.length > 3 && guard-- > 0) {
    let clipped = false;
    for (let i = 0; i < idx.length; i++) {
      const i0 = idx[(i + idx.length - 1) % idx.length];
      const i1 = idx[i];
      const i2 = idx[(i + 1) % idx.length];
      const a = ring[i0];
      const b = ring[i1];
      const c = ring[i2];
      if (cross(sub(b, a), sub(c, b)) <= 1e-7) continue; // reflex or collinear
      let contains = false;
      for (let j = 0; j < idx.length; j++) {
        const k = idx[j];
        if (k === i0 || k === i1 || k === i2) continue;
        if (pointInTri(ring[k], a, b, c)) {
          contains = true;
          break;
        }
      }
      if (contains) continue;
      out.push(i0, i1, i2);
      idx.splice(i, 1);
      clipped = true;
      break;
    }
    if (!clipped) break;
  }
  if (idx.length === 3) out.push(idx[0], idx[1], idx[2]);
  if (out.length === 0) {
    for (let i = 1; i < n - 1; i++) {
      if (ccw) out.push(0, i, i + 1);
      else out.push(0, i + 1, i);
    }
  }
  return out;
}

function pointInTri(p: V2, a: V2, b: V2, c: V2): boolean {
  const d1 = cross(sub(b, a), sub(p, a));
  const d2 = cross(sub(c, b), sub(p, b));
  const d3 = cross(sub(a, c), sub(p, c));
  return d1 >= -1e-9 && d2 >= -1e-9 && d3 >= -1e-9;
}
