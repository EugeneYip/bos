/**
 * Ribbon tessellation.
 *
 * A polyline is converted into a sequence of *rungs* — cross-sections that
 * carry a mitre frame. Every surface that follows the street (carriageway,
 * gutter, kerb face, sidewalk, lane markings, bridge parapets) is then emitted
 * by sampling the same rungs at different across-offsets, so they all share
 * identical joint behaviour and can never drift apart.
 *
 * Joints:
 *  - shallow bends get a true mitre (one rung, both edges meet at a point);
 *  - bends past the mitre limit get a fan of rungs on the *outer* side, giving
 *    a round join, while the inner side collapses to a single clamped point.
 *    That is what stops Boston's endless sharp bends from notching or folding
 *    the ribbon back over itself.
 */
import {
  type V2, add, cross, dist, dot, norm, perp, scale, sub, unperp,
} from './math2';
import { TUNE } from './spec';

export interface Rung {
  /** Centreline position. */
  p: V2;
  /** Ground elevation at the centreline. */
  y: number;
  /** Arc length along the centreline from the ribbon start. */
  s: number;
  /** Unit tangent. */
  t: V2;
  /** Unit left normal for this rung (used on the outer side of round joins). */
  n: V2;
  /** Unit mitre bisector, pointing left. */
  m: V2;
  /** Mitre scale (1 / cos(half turn)), already clamped. */
  sc: number;
  /** 0 = plain mitre, +1 = left side is the outer side, -1 = right side is. */
  outer: -1 | 0 | 1;
  /** True on the first/last rung of the ribbon. */
  cap: boolean;
}

/**
 * Builds the rung frame. `maxOffset` is the largest across-distance any caller
 * will sample (usually half-width + sidewalk), and bounds the mitre clamp so a
 * short segment can never be overrun.
 */
export function buildFrame(pts: V2[], ys: number[], maxOffset: number): Rung[] {
  const n = pts.length;
  if (n < 2) return [];

  const segDir: V2[] = new Array(n - 1);
  const segLen: number[] = new Array(n - 1);
  for (let i = 0; i < n - 1; i++) {
    const d = sub(pts[i + 1], pts[i]);
    segLen[i] = Math.hypot(d.x, d.z);
    segDir[i] = segLen[i] > 1e-7 ? { x: d.x / segLen[i], z: d.z / segLen[i] } : { x: 1, z: 0 };
  }

  const rungs: Rung[] = [];
  let s = 0;

  // Head cap.
  rungs.push({
    p: pts[0], y: ys[0] ?? 0, s: 0, t: segDir[0], n: perp(segDir[0]),
    m: perp(segDir[0]), sc: 1, outer: 0, cap: true,
  });

  for (let i = 1; i < n - 1; i++) {
    s += segLen[i - 1];
    const a = segDir[i - 1];
    const b = segDir[i];
    const na = perp(a);
    const nb = perp(b);
    const mRaw = add(na, nb);
    const mLen = Math.hypot(mRaw.x, mRaw.z);
    const y = ys[i] ?? 0;

    if (mLen < 1e-5) {
      // Perfect 180 degree reversal: cap and restart rather than explode.
      rungs.push({ p: pts[i], y, s, t: a, n: na, m: na, sc: 1, outer: 0, cap: false });
      continue;
    }
    const m = { x: mRaw.x / mLen, z: mRaw.z / mLen };
    const cosHalf = Math.max(dot(m, na), 0.08);
    let sc = 1 / cosHalf;

    // Never let the mitre overrun the shorter neighbouring segment.
    const shortest = Math.min(segLen[i - 1], segLen[i]);
    const byLen = 1 + (0.85 * shortest) / Math.max(maxOffset, 0.25);
    const limit = Math.min(TUNE.miterLimit, byLen);

    const turn = Math.acos(Math.max(-1, Math.min(1, dot(a, b))));
    if (sc <= limit || turn < 0.18) {
      sc = Math.min(sc, Math.max(limit, 1));
      rungs.push({ p: pts[i], y, s, t: norm(add(a, b)), n: m, m, sc, outer: 0, cap: false });
      continue;
    }

    // Sharp: round the outer side. cross < 0 is a left turn (left is inside).
    sc = Math.max(limit, 1);
    const leftIsOuter = cross(a, b) > 0;
    const outer: -1 | 0 | 1 = leftIsOuter ? 1 : -1;
    const steps = Math.max(2, Math.min(10, Math.ceil(turn / 0.42) + 1));
    const a0 = Math.atan2(na.z, na.x);
    let delta = Math.atan2(nb.z, nb.x) - a0;
    while (delta > Math.PI) delta -= Math.PI * 2;
    while (delta < -Math.PI) delta += Math.PI * 2;

    for (let k = 0; k < steps; k++) {
      const f = k / (steps - 1);
      const ang = a0 + delta * f;
      const nk = { x: Math.cos(ang), z: Math.sin(ang) };
      rungs.push({ p: pts[i], y, s, t: unperp(nk), n: nk, m, sc, outer, cap: false });
    }
  }

  s += segLen[n - 2];
  const tl = segDir[n - 2];
  rungs.push({
    p: pts[n - 1], y: ys[n - 1] ?? 0, s, t: tl, n: perp(tl), m: perp(tl), sc: 1, outer: 0, cap: true,
  });

  return rungs;
}

/** World position of a point `a` metres to the left of the centreline. */
export function offsetAt(r: Rung, a: number): V2 {
  if (a === 0) return r.p;
  if (r.outer === 0) return add(r.p, scale(r.m, a * r.sc));
  const leftSide = a > 0;
  const outerLeft = r.outer === 1;
  if (leftSide === outerLeft) return add(r.p, scale(r.n, a));
  return add(r.p, scale(r.m, a * r.sc));
}

export interface Row {
  /** Across-offset in metres, positive to the left of travel direction. */
  a: number;
  /** Vertical offset from the centreline elevation, metres. */
  dy: number;
  /** Linear RGBA multiplier for this row. */
  c: [number, number, number, number];
}

export type UvMode = 'world' | 'local';

export interface StripOpts {
  uv: UvMode;
  /** Metres per UV tile. */
  tile: number;
  /** Extra lift applied to every vertex. */
  lift: number;
  /** Explicit normal for every vertex (kerb faces, parapets). */
  normal?: [number, number, number];
  /** Offset added to the local-UV `v` so adjacent pieces do not repeat. */
  vBias?: number;
  /** Skip rungs whose arc-length falls outside [sFrom, sTo]. */
  sFrom?: number;
  sTo?: number;
}

interface Emitter {
  vert(x: number, y: number, z: number, u: number, v: number, c: [number, number, number, number]): number;
  vertN(
    x: number, y: number, z: number, nx: number, ny: number, nz: number,
    u: number, v: number, c: [number, number, number, number],
  ): number;
  tri(a: number, b: number, c: number): void;
}

/**
 * Emits a quad grid spanning the given across-rows over the given rungs.
 * Rows must be ordered left-to-right (descending `a`) so the winding comes out
 * facing up; the caller flips `dy` for undersides.
 */
export function emitStrip(
  out: Emitter, rungs: Rung[], rows: Row[], opts: StripOpts, flip = false,
): void {
  if (rungs.length < 2 || rows.length < 2) return;
  const lift = opts.lift;
  const invTile = 1 / Math.max(opts.tile, 0.001);
  const vBias = opts.vBias ?? 0;
  const nrm = opts.normal;

  const ring: number[] = [];
  let prevRing: number[] | null = null;

  for (let i = 0; i < rungs.length; i++) {
    const r = rungs[i];
    if (opts.sFrom !== undefined && r.s < opts.sFrom - 1e-4) continue;
    if (opts.sTo !== undefined && r.s > opts.sTo + 1e-4) continue;
    ring.length = 0;
    for (let j = 0; j < rows.length; j++) {
      const row = rows[j];
      const p = offsetAt(r, row.a);
      const y = r.y + row.dy + lift;
      let u: number;
      let v: number;
      if (opts.uv === 'world') {
        u = p.x * invTile;
        v = p.z * invTile;
      } else {
        u = row.a * invTile;
        v = (r.s + vBias) * invTile;
      }
      ring.push(
        nrm
          ? out.vertN(p.x, y, p.z, nrm[0], nrm[1], nrm[2], u, v, row.c)
          : out.vert(p.x, y, p.z, u, v, row.c),
      );
    }
    if (prevRing) {
      for (let j = 0; j < rows.length - 1; j++) {
        const a = prevRing[j];
        const b = prevRing[j + 1];
        const c = ring[j + 1];
        const d = ring[j];
        if (flip) {
          out.tri(a, c, b);
          out.tri(a, d, c);
        } else {
          out.tri(a, b, c);
          out.tri(a, c, d);
        }
      }
      prevRing = ring.slice();
    } else {
      prevRing = ring.slice();
    }
  }
}

/** Arc-length window of a ribbon, used to place stop bars and lane arrows. */
export function rungAt(rungs: Rung[], s: number): Rung {
  let lo = 0;
  let hi = rungs.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (rungs[mid].s < s) lo = mid + 1;
    else hi = mid;
  }
  return rungs[Math.max(0, Math.min(rungs.length - 1, lo))];
}

/** Interpolated centreline sample (position, elevation, tangent) at arc length. */
export function sampleAt(rungs: Rung[], s: number): { p: V2; y: number; t: V2 } {
  if (rungs.length === 0) return { p: { x: 0, z: 0 }, y: 0, t: { x: 1, z: 0 } };
  if (s <= rungs[0].s) return { p: rungs[0].p, y: rungs[0].y, t: rungs[0].t };
  const last = rungs[rungs.length - 1];
  if (s >= last.s) return { p: last.p, y: last.y, t: last.t };
  let i = 1;
  while (i < rungs.length && rungs[i].s < s) i++;
  const a = rungs[i - 1];
  const b = rungs[i];
  const span = Math.max(b.s - a.s, 1e-6);
  const f = (s - a.s) / span;
  return {
    p: { x: a.p.x + (b.p.x - a.p.x) * f, z: a.p.z + (b.p.z - a.p.z) * f },
    y: a.y + (b.y - a.y) * f,
    t: norm({ x: a.t.x + (b.t.x - a.t.x) * f, z: a.t.z + (b.t.z - a.t.z) * f }),
  };
}

export function frameLength(rungs: Rung[]): number {
  return rungs.length ? rungs[rungs.length - 1].s : 0;
}

/** Straight-line distance covered by the frame, for degenerate-input guards. */
export function frameSpan(rungs: Rung[]): number {
  return rungs.length > 1 ? dist(rungs[0].p, rungs[rungs.length - 1].p) : 0;
}
