/**
 * Polygon plumbing for the water surfaces: triangulation with holes, scanline
 * rasterisation into the signed-distance field, and the grid clipper that turns
 * long earcut slivers into evenly-sized quads we can displace with Gerstner
 * waves.
 *
 * Everything here works on flat `[x0,z0, x1,z1, ...]` rings in world metres —
 * the same encoding `AreaRecord.outline` uses — so no per-vertex objects are
 * allocated on the hot paths.
 */
import * as THREE from 'three';

/** Closed ring, flat `[x,z,...]`, first point NOT repeated at the end. */
export type Ring = Float64Array;

export interface TriMesh {
  /** Flat `[x,z,...]`. */
  verts: Float64Array;
  /** Triangle indices into `verts`. */
  tris: Uint32Array;
}

/** Twice the signed area; sign tells winding, magnitude is used for culling. */
export function ringArea2(r: Ring): number {
  let s = 0;
  const n = r.length;
  for (let i = 0; i < n; i += 2) {
    const j = (i + 2) % n;
    s += r[i] * r[j + 1] - r[j] * r[i + 1];
  }
  return s;
}

export function ringBounds(r: Ring, out: number[]): void {
  let minX = Infinity, minZ = Infinity, maxX = -Infinity, maxZ = -Infinity;
  for (let i = 0; i < r.length; i += 2) {
    const x = r[i], z = r[i + 1];
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (z < minZ) minZ = z;
    if (z > maxZ) maxZ = z;
  }
  out[0] = minX; out[1] = minZ; out[2] = maxX; out[3] = maxZ;
}

/** Drops a repeated final point and any near-duplicate consecutive vertices. */
export function cleanRing(src: ArrayLike<number>): Ring {
  const out: number[] = [];
  const n = src.length;
  for (let i = 0; i < n; i += 2) {
    const x = src[i], z = src[i + 1];
    const m = out.length;
    if (m >= 2 && Math.abs(out[m - 2] - x) < 1e-6 && Math.abs(out[m - 1] - z) < 1e-6) continue;
    out.push(x, z);
  }
  // close-off duplicate
  if (out.length >= 4) {
    const m = out.length;
    if (Math.abs(out[0] - out[m - 2]) < 1e-6 && Math.abs(out[1] - out[m - 1]) < 1e-6) out.length = m - 2;
  }
  return Float64Array.from(out);
}

/**
 * Ear-clipping triangulation with holes, delegated to three's bundled Earcut.
 * `ShapeUtils.triangulateShape` needs real `Vector2`s (it calls `.equals`) and
 * mutates the arrays it is given, so the combined vertex list is rebuilt from
 * the (possibly shortened) inputs afterwards.
 */
export function triangulateRings(outer: Ring, holes: Ring[]): TriMesh {
  const toV2 = (r: Ring): THREE.Vector2[] => {
    const out: THREE.Vector2[] = new Array(r.length / 2);
    for (let i = 0, k = 0; i < r.length; i += 2, k++) out[k] = new THREE.Vector2(r[i], r[i + 1]);
    return out;
  };

  const contour = toV2(outer);
  const holeArrs = holes.map(toV2);
  if (contour.length < 3) return { verts: new Float64Array(0), tris: new Uint32Array(0) };

  let faces: number[][];
  try {
    faces = THREE.ShapeUtils.triangulateShape(contour, holeArrs);
  } catch {
    faces = [];
  }

  const all = contour.concat(...holeArrs);
  const verts = new Float64Array(all.length * 2);
  for (let i = 0; i < all.length; i++) {
    verts[i * 2] = all[i].x;
    verts[i * 2 + 1] = all[i].y;
  }

  const tris = new Uint32Array(faces.length * 3);
  let w = 0;
  for (const f of faces) {
    if (f[0] === f[1] || f[1] === f[2] || f[0] === f[2]) continue;
    tris[w++] = f[0]; tris[w++] = f[1]; tris[w++] = f[2];
  }
  return { verts, tris: tris.subarray(0, w) };
}

// ------------------------------------------------------------- clipping ----

/**
 * Sutherland–Hodgman half-plane clip of a convex polygon against an
 * axis-aligned line. `axis` 0 = x, 1 = z. Keeps the `keepGreater` side.
 *
 * Because every clip line is shared between neighbouring grid cells, the
 * vertices produced on a cell boundary are bit-identical from both sides, so
 * the tiled output stays watertight — no T-junctions, no hairline cracks.
 */
export function clipHalfPlane(
  src: number[], srcLen: number, dst: number[], axis: 0 | 1, value: number, keepGreater: boolean,
): number {
  let w = 0;
  if (srcLen < 6) return 0;
  let px = src[srcLen - 2], pz = src[srcLen - 1];
  let pv = axis === 0 ? px : pz;
  let pin = keepGreater ? pv >= value : pv <= value;
  for (let i = 0; i < srcLen; i += 2) {
    const cx = src[i], cz = src[i + 1];
    const cv = axis === 0 ? cx : cz;
    const cin = keepGreater ? cv >= value : cv <= value;
    if (cin !== pin) {
      const t = (value - pv) / (cv - pv);
      dst[w++] = px + (cx - px) * t;
      dst[w++] = pz + (cz - pz) * t;
    }
    if (cin) { dst[w++] = cx; dst[w++] = cz; }
    px = cx; pz = cz; pv = cv; pin = cin;
  }
  return w;
}

/** Removes consecutive duplicates; a clipped polygon with <3 unique points is empty. */
export function dedupe(p: number[], len: number): number {
  if (len < 6) return 0;
  let w = 0;
  for (let i = 0; i < len; i += 2) {
    const j = (i + len - 2) % len;
    if (Math.abs(p[i] - p[j]) < 1e-7 && Math.abs(p[i + 1] - p[j + 1]) < 1e-7) continue;
    p[w++] = p[i]; p[w++] = p[i + 1];
  }
  return w < 6 ? 0 : w;
}

// -------------------------------------------------------- rasterisation ----

/**
 * Even-odd scanline fill of a polygon-with-holes onto a row-major grid.
 * `visit(index, row, col)` is called for every covered cell. Holes come for
 * free: with the even-odd rule a hole ring simply toggles the parity back.
 */
export function scanFill(
  rings: Ring[],
  gx0: number, gz0: number, tsx: number, tsz: number, gw: number, gh: number,
  visit: (idx: number) => void,
): void {
  let minZ = Infinity, maxZ = -Infinity;
  for (const r of rings) {
    for (let i = 1; i < r.length; i += 2) {
      if (r[i] < minZ) minZ = r[i];
      if (r[i] > maxZ) maxZ = r[i];
    }
  }
  if (!isFinite(minZ)) return;

  const j0 = Math.max(0, Math.floor((minZ - gz0) / tsz));
  const j1 = Math.min(gh - 1, Math.ceil((maxZ - gz0) / tsz));
  const xs: number[] = [];

  for (let j = j0; j <= j1; j++) {
    const zc = gz0 + (j + 0.5) * tsz;
    xs.length = 0;
    for (const r of rings) {
      const n = r.length;
      for (let i = 0; i < n; i += 2) {
        const k = (i + 2) % n;
        const z0 = r[i + 1], z1 = r[k + 1];
        if ((z0 <= zc && z1 > zc) || (z1 <= zc && z0 > zc)) {
          const t = (zc - z0) / (z1 - z0);
          xs.push(r[i] + (r[k] - r[i]) * t);
        }
      }
    }
    if (xs.length < 2) continue;
    xs.sort((a, b) => a - b);
    const row = j * gw;
    for (let s = 0; s + 1 < xs.length; s += 2) {
      let i0 = Math.ceil((xs[s] - gx0) / tsx - 0.5);
      let i1 = Math.floor((xs[s + 1] - gx0) / tsx - 0.5);
      if (i0 < 0) i0 = 0;
      if (i1 > gw - 1) i1 = gw - 1;
      for (let i = i0; i <= i1; i++) visit(row + i);
    }
  }
}

/** Marks every grid cell a ring's edges pass through (a conservative DDA). */
export function markEdgeCells(
  rings: Ring[],
  gx0: number, gz0: number, ts: number, gw: number, gh: number,
  mark: Uint8Array, flag: number,
): void {
  for (const r of rings) {
    const n = r.length;
    for (let i = 0; i < n; i += 2) {
      const k = (i + 2) % n;
      const ax = r[i], az = r[i + 1], bx = r[k], bz = r[k + 1];
      const steps = Math.max(1, Math.ceil(Math.hypot(bx - ax, bz - az) / (ts * 0.5)));
      for (let s = 0; s <= steps; s++) {
        const t = s / steps;
        const ci = Math.floor((ax + (bx - ax) * t - gx0) / ts);
        const cj = Math.floor((az + (bz - az) * t - gz0) / ts);
        for (let dj = -1; dj <= 0; dj++) {
          for (let di = -1; di <= 0; di++) {
            const ii = ci + di, jj = cj + dj;
            if (ii >= 0 && jj >= 0 && ii < gw && jj < gh) mark[jj * gw + ii] |= flag;
          }
        }
      }
    }
  }
}

/** Winding-number point-in-polygon over a ring set (holes included). */
export function pointInRings(rings: Ring[], x: number, z: number): boolean {
  let inside = false;
  for (const r of rings) {
    const n = r.length;
    for (let i = 0; i < n; i += 2) {
      const k = (i + 2) % n;
      const zi = r[i + 1], zk = r[k + 1];
      if ((zi > z) !== (zk > z)) {
        const xi = r[i] + ((z - zi) / (zk - zi)) * (r[k] - r[i]);
        if (xi > x) inside = !inside;
      }
    }
  }
  return inside;
}
