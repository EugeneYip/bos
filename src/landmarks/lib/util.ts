/**
 * Small shared helpers for the hand-authored landmark meshes.
 *
 * World convention (see ARCHITECTURE.md): metres, Y-up, +X = east, +Z = south,
 * so north is -Z and a compass bearing B (degrees clockwise from north) points
 * along the world vector (sin B, -cos B).
 */

export const DEG = Math.PI / 180;

/**
 * Rotation about +Y (radians) that aims a landmark's **local +X axis** along the
 * compass bearing `deg`.
 *
 * Derivation: rotY(t) maps local +X = (1,0,0) to world (cos t, 0, -sin t), whose
 * bearing is atan2(cos t, sin t) = 90deg - t. So t = 90deg - bearing.
 *
 * Every landmark in this module is therefore authored with its principal axis
 * (long facade, bridge centreline, nave, ...) running along local +X, and the
 * registry only has to state the real-world bearing of that axis.
 */
export function bearingX(deg: number): number {
  return (90 - deg) * DEG;
}

/** Deterministic 32-bit hash -> [0,1). Keeps every landmark reproducible. */
export function hash01(n: number): number {
  let h = Math.imul(n ^ 0x9e3779b9, 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

/** Tiny deterministic PRNG (mulberry32) so geometry is identical every boot. */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const clamp = (v: number, a: number, b: number): number => (v < a ? a : v > b ? b : v);
export const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;
export const smoothstep = (t: number): number => t * t * (3 - 2 * t);

/** Metres from feet — most of the cited North-American dimensions are imperial. */
export const ft = (n: number): number => n * 0.3048;
/** Metres from inches. */
export const inch = (n: number): number => n * 0.0254;

/** 2D point as a bare tuple; footprints are arrays of these. */
export type P2 = [number, number];

/** Offset a closed convex-ish polygon inward (positive) by `d` metres. */
export function insetPolygon(pts: P2[], d: number): P2[] {
  const n = pts.length;
  const out: P2[] = [];
  for (let i = 0; i < n; i++) {
    const p = pts[i];
    const a = pts[(i - 1 + n) % n];
    const b = pts[(i + 1) % n];
    // Inward normals of the two adjacent edges (CCW polygon -> left normal).
    const n1 = edgeNormal(a, p);
    const n2 = edgeNormal(p, b);
    let nx = n1[0] + n2[0];
    let nz = n1[1] + n2[1];
    const len = Math.hypot(nx, nz) || 1;
    nx /= len;
    nz /= len;
    // Miter length: 1/cos(half-angle between the two edge normals).
    const cosHalf = Math.max(0.2, (n1[0] * nx + n1[1] * nz));
    out.push([p[0] + (nx * d) / cosHalf, p[1] + (nz * d) / cosHalf]);
  }
  return out;
}

function edgeNormal(a: P2, b: P2): P2 {
  const dx = b[0] - a[0];
  const dz = b[1] - a[1];
  const l = Math.hypot(dx, dz) || 1;
  // Inward normal for a counter-clockwise ring in the X/Z plane. (The outward
  // normal used by prism() is the negation of this.)
  return [-dz / l, dx / l];
}

/** Signed area (>0 == counter-clockwise in X/Z with +Z "down" on screen). */
export function polygonArea(pts: P2[]): number {
  let a = 0;
  for (let i = 0, n = pts.length; i < n; i++) {
    const p = pts[i];
    const q = pts[(i + 1) % n];
    a += p[0] * q[1] - q[0] * p[1];
  }
  return a / 2;
}

/** Ensure counter-clockwise winding so extrusions and insets behave. */
export function ccw(pts: P2[]): P2[] {
  return polygonArea(pts) < 0 ? pts.slice().reverse() : pts;
}

/** Uniformly scale a polygon about the origin. */
export function scalePolygon(pts: P2[], s: number): P2[] {
  return pts.map(([x, z]) => [x * s, z * s] as P2);
}

/** A rectangle centred on the origin, CCW. */
export function rect(w: number, d: number): P2[] {
  return [
    [-w / 2, -d / 2],
    [w / 2, -d / 2],
    [w / 2, d / 2],
    [-w / 2, d / 2],
  ];
}

/** A rectangle with all four corners cut at 45 degrees by `c` metres. */
export function chamferedRect(w: number, d: number, c: number): P2[] {
  const x = w / 2;
  const z = d / 2;
  return [
    [-x + c, -z],
    [x - c, -z],
    [x, -z + c],
    [x, z - c],
    [x - c, z],
    [-x + c, z],
    [-x, z - c],
    [-x, -z + c],
  ];
}

/** A rectangle with rounded corners, `seg` segments per corner. */
export function roundedRect(w: number, d: number, r: number, seg = 6): P2[] {
  const x = w / 2 - r;
  const z = d / 2 - r;
  const out: P2[] = [];
  const corners: P2[] = [
    [x, -z],
    [x, z],
    [-x, z],
    [-x, -z],
  ];
  const start = [-Math.PI / 2, 0, Math.PI / 2, Math.PI];
  for (let c = 0; c < 4; c++) {
    for (let i = 0; i <= seg; i++) {
      const a = start[c] + (i / seg) * (Math.PI / 2);
      out.push([corners[c][0] + Math.cos(a) * r, corners[c][1] + Math.sin(a) * r]);
    }
  }
  return out;
}

/** Regular polygon with `n` sides and circumradius `r`, first vertex at angle `a0`. */
export function regularPolygon(n: number, r: number, a0 = 0): P2[] {
  const out: P2[] = [];
  for (let i = 0; i < n; i++) {
    const a = a0 + (i / n) * Math.PI * 2;
    out.push([Math.cos(a) * r, Math.sin(a) * r]);
  }
  return out;
}

/** Equilateral triangle with rounded corners — One Dalton's plan. */
export function roundedTriangle(side: number, radius: number, seg = 8, a0 = 0): P2[] {
  // Circumradius of an equilateral triangle: R = side / sqrt(3).
  const R = side / Math.sqrt(3);
  // Centre of each corner arc sits `radius / sin(30deg)` = 2*radius inside the vertex.
  const inset = radius * 2;
  const out: P2[] = [];
  for (let c = 0; c < 3; c++) {
    const va = a0 + (c / 3) * Math.PI * 2;
    const cx = Math.cos(va) * (R - inset);
    const cz = Math.sin(va) * (R - inset);
    // The arc sweeps 120 degrees centred on the vertex direction.
    for (let i = 0; i <= seg; i++) {
      const a = va - Math.PI / 3 + (i / seg) * ((2 * Math.PI) / 3);
      out.push([cx + Math.cos(a) * radius, cz + Math.sin(a) * radius]);
    }
  }
  return out;
}

/** Perimeter length of a closed polygon. */
export function perimeter(pts: P2[]): number {
  let p = 0;
  for (let i = 0, n = pts.length; i < n; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % n];
    p += Math.hypot(b[0] - a[0], b[1] - a[1]);
  }
  return p;
}
