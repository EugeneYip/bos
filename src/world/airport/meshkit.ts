/**
 * Self-contained geometry + mesh-accumulation helpers for the airport module.
 *
 * Deliberately independent of `src/world/roads/**` and `src/world/buildings/**`
 * — both show the right *pattern* (bucket-per-material accumulators, ear-clip
 * triangulation) but are owned by other modules, and the architecture rule is
 * no cross-module imports. Everything here is small enough to justify a
 * second, local copy rather than reaching into another module's internals.
 */
import * as THREE from 'three';

/** Flat [x,z] ring, matching `AreaRecord.outline`'s encoding. */
export type Ring = readonly number[];

/** Signed area (shoelace, x/z plane); positive for CCW winding. */
export function signedArea(ring: Ring): number {
  let s = 0;
  const n = ring.length;
  for (let i = 0; i < n; i += 2) {
    const j = (i + 2) % n;
    s += ring[i] * ring[j + 1] - ring[j] * ring[i + 1];
  }
  return s * 0.5;
}

export function polygonArea(ring: Ring): number {
  return Math.abs(signedArea(ring));
}

export function centroidOf(ring: Ring): [number, number] {
  let cx = 0, cz = 0;
  const n = ring.length / 2;
  for (let i = 0; i < ring.length; i += 2) { cx += ring[i]; cz += ring[i + 1]; }
  return [cx / n, cz / n];
}

/** Standard ray-casting point-in-polygon test (outer ring only, no holes). */
export function pointInRing(ring: Ring, x: number, z: number): boolean {
  let inside = false;
  const n = ring.length / 2;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = ring[i * 2], zi = ring[i * 2 + 1];
    const xj = ring[j * 2], zj = ring[j * 2 + 1];
    const hit = (zi > z) !== (zj > z) && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi;
    if (hit) inside = !inside;
  }
  return inside;
}

/**
 * Ear-clipping triangulation for a simple polygon, no holes.
 *
 * Airport pavement polygons (runways, taxiways, aprons) are OSM `aeroway`
 * outlines: a few dozen vertices at most, no interior rings in practice. A
 * plain O(n^2)-per-ear scan is comfortably fast at that size and has nothing
 * clever to go wrong on imperfect real-world geometry.
 *
 * @returns flat triangle index triples into `ring`'s vertex list (i.e. divide
 * by 2 for the ring's x/z pair index).
 */
export function triangulate(ring: Ring): number[] {
  const n = ring.length / 2;
  if (n < 3) return [];
  const order: number[] = [];
  for (let i = 0; i < n; i++) order.push(i);
  if (signedArea(ring) < 0) order.reverse();

  const cross = (ax: number, az: number, bx: number, bz: number, cx: number, cz: number): number =>
    (bx - ax) * (cz - az) - (bz - az) * (cx - ax);

  const inTri = (
    px: number, pz: number,
    ax: number, az: number, bx: number, bz: number, cx: number, cz: number,
  ): boolean => {
    const d1 = cross(ax, az, bx, bz, px, pz);
    const d2 = cross(bx, bz, cx, cz, px, pz);
    const d3 = cross(cx, cz, ax, az, px, pz);
    const neg = d1 < 0 || d2 < 0 || d3 < 0;
    const pos = d1 > 0 || d2 > 0 || d3 > 0;
    return !(neg && pos);
  };

  const live = order.slice();
  const out: number[] = [];
  let guard = 0;
  while (live.length > 3 && guard++ < 20000) {
    let clipped = false;
    for (let i = 0; i < live.length; i++) {
      const iPrev = (i - 1 + live.length) % live.length;
      const iNext = (i + 1) % live.length;
      const a = live[iPrev], b = live[i], c = live[iNext];
      const ax = ring[a * 2], az = ring[a * 2 + 1];
      const bx = ring[b * 2], bz = ring[b * 2 + 1];
      const cx = ring[c * 2], cz = ring[c * 2 + 1];
      // Reflex or degenerate vertices cannot be ears on a CCW ring.
      if (cross(ax, az, bx, bz, cx, cz) <= 1e-7) continue;
      let isEar = true;
      for (let k = 0; k < live.length; k++) {
        if (k === iPrev || k === i || k === iNext) continue;
        const p = live[k];
        if (inTri(ring[p * 2], ring[p * 2 + 1], ax, az, bx, bz, cx, cz)) { isEar = false; break; }
      }
      if (!isEar) continue;
      out.push(a, b, c);
      live.splice(i, 1);
      clipped = true;
      break;
    }
    // Degenerate/self-intersecting input: stop rather than spin or throw. One
    // bad polygon must never take the rest of the airfield down with it.
    if (!clipped) break;
  }
  if (live.length === 3) out.push(live[0], live[1], live[2]);
  return out;
}

/** Convex hull (monotone chain), points as [x,z] pairs. */
export function convexHull(points: readonly [number, number][]): [number, number][] {
  const pts = points.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const cross = (o: [number, number], a: [number, number], b: [number, number]): number =>
    (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower: [number, number][] = [];
  for (const p of pts) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop();
    lower.push(p);
  }
  const upper: [number, number][] = [];
  for (let i = pts.length - 1; i >= 0; i--) {
    const p = pts[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop();
    upper.push(p);
  }
  lower.pop();
  upper.pop();
  return lower.concat(upper);
}

/** Oriented bounding box: centre, unit long axis, length along it, width across. */
export interface OBB {
  cx: number; cz: number;
  /** Unit vector along the long axis. */
  ax: number; az: number;
  length: number;
  width: number;
}

/** Minimum-area OBB via rotating calipers over the convex hull. */
export function minAreaOBB(ring: Ring): OBB | null {
  const pts: [number, number][] = [];
  for (let i = 0; i < ring.length; i += 2) pts.push([ring[i], ring[i + 1]]);
  const hull = convexHull(pts);
  if (hull.length < 3) return null;

  interface Best { area: number; w: number; h: number; ux: number; uz: number; nx: number; nz: number; minU: number; maxU: number; minV: number; maxV: number }
  let best: Best | null = null;
  for (let i = 0; i < hull.length; i++) {
    const a = hull[i], b = hull[(i + 1) % hull.length];
    const dx = b[0] - a[0], dz = b[1] - a[1];
    const len = Math.hypot(dx, dz);
    if (len < 1e-9) continue;
    const ux = dx / len, uz = dz / len, nx = -uz, nz = ux;
    let minU = Infinity, maxU = -Infinity, minV = Infinity, maxV = -Infinity;
    for (const p of hull) {
      const u = p[0] * ux + p[1] * uz;
      const v = p[0] * nx + p[1] * nz;
      if (u < minU) minU = u;
      if (u > maxU) maxU = u;
      if (v < minV) minV = v;
      if (v > maxV) maxV = v;
    }
    const w = maxU - minU, h = maxV - minV, area = w * h;
    if (!best || area < best.area) best = { area, w, h, ux, uz, nx, nz, minU, maxU, minV, maxV };
  }
  if (!best) return null;

  let length = best.w, width = best.h, ax = best.ux, az = best.uz;
  const cu = (best.minU + best.maxU) / 2;
  const cv = (best.minV + best.maxV) / 2;
  const cx = cu * best.ux + cv * best.nx;
  const cz = cu * best.uz + cv * best.nz;
  if (length < width) { [length, width] = [width, length]; ax = best.nx; az = best.nz; }
  return { cx, cz, ax, az, length, width };
}

/** Compass bearing (degrees clockwise from north, 0-180) of a unit direction. */
export function compassBearingDeg(ax: number, az: number): number {
  let b = (Math.atan2(ax, -az) * 180) / Math.PI;
  b = ((b % 180) + 180) % 180;
  return b;
}

/** Smallest angular distance between two mod-180 bearings, degrees. */
export function bearingDist(a: number, b: number): number {
  const d = Math.abs(a - b) % 180;
  return Math.min(d, 180 - d);
}

/** A rectangle's corner ring (CCW), given centre, unit axis and extents. */
export function rectRing(cx: number, cz: number, ax: number, az: number, length: number, width: number): number[] {
  const nx = -az, nz = ax;
  const hl = length / 2, hw = width / 2;
  const c = (l: number, w: number): [number, number] => [cx + ax * l + nx * w, cz + az * l + nz * w];
  const p0 = c(-hl, -hw), p1 = c(hl, -hw), p2 = c(hl, hw), p3 = c(-hl, hw);
  return [...p0, ...p1, ...p2, ...p3];
}

/* ------------------------------------------------------------ mesh building */

/** RGB triple, 0-1 linear (matches `new THREE.Color(hex)` under ColorManagement). */
export type RGB = readonly [number, number, number];

/**
 * One material's worth of triangles. `build()` yields a single `BufferGeometry`
 * so a whole airfield's pavement (or paint, or lights) collapses into one draw
 * call per material, per `Buckets`/`MeshBuilder` in `roads/geom.ts` — mirrored
 * here rather than imported, since Roads owns that file.
 */
export class MeshBuilder {
  private pos: number[] = [];
  private nrm: number[] = [];
  private uv: number[] = [];
  private col: number[] = [];
  private idx: number[] = [];

  get empty(): boolean { return this.idx.length === 0; }
  get vertexCount(): number { return this.pos.length / 3; }

  vert(x: number, y: number, z: number, nx: number, ny: number, nz: number, u: number, v: number, c: RGB): number {
    const i = this.pos.length / 3;
    this.pos.push(x, y, z);
    this.nrm.push(nx, ny, nz);
    this.uv.push(u, v);
    this.col.push(c[0], c[1], c[2]);
    return i;
  }

  tri(a: number, b: number, c: number): void { this.idx.push(a, b, c); }

  /** A flat, per-vertex-elevated ring, ear-clipped and UV'd in world metres. */
  polygon(ring: Ring, yAt: (x: number, z: number) => number, tile: number, c: RGB): void {
    const tris = triangulate(ring);
    if (!tris.length) return;
    const n = ring.length / 2;
    const base = new Array<number>(n);
    const inv = 1 / Math.max(tile, 1e-3);
    for (let i = 0; i < n; i++) {
      const x = ring[i * 2], z = ring[i * 2 + 1];
      base[i] = this.vert(x, yAt(x, z), z, 0, 1, 0, x * inv, z * inv, c);
    }
    for (let i = 0; i < tris.length; i += 3) this.tri(base[tris[i]], base[tris[i + 1]], base[tris[i + 2]]);
  }

  /** An oriented flat rectangle: `cx,cz` centre, `(ax,az)` unit long axis. */
  orientedRect(
    cx: number, cz: number, ax: number, az: number, length: number, width: number,
    yAt: (x: number, z: number) => number, tile: number, c: RGB,
  ): void {
    const ring = rectRing(cx, cz, ax, az, length, width);
    this.polygon(ring, yAt, tile, c);
  }

  build(): THREE.BufferGeometry | null {
    if (!this.idx.length) return null;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nrm, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.uv, 2));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3));
    g.setIndex(this.idx.length > 65535
      ? new THREE.Uint32BufferAttribute(this.idx, 1)
      : new THREE.Uint16BufferAttribute(this.idx, 1));
    g.computeBoundingSphere();
    return g;
  }
}

/** `new THREE.Color(hex)` already linearises under r169's `ColorManagement`. */
export function hexRGB(hex: number): RGB {
  const c = new THREE.Color(hex);
  return [c.r, c.g, c.b];
}
