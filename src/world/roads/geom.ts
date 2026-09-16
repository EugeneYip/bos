/**
 * Shared emission helpers: one `MeshBuilder` per material per tile (so a tile
 * costs one draw call per surface family), plus the small primitives that the
 * carriageway, paint, junction and structure builders all reuse.
 */
import * as THREE from 'three';
import { MeshBuilder, type RGBA } from './builder';
import type { MatKey, RoadMaterials } from './materials';
import { type V2, dist, lerp2, norm, perp, sub, triangulate } from './math2';

/** A set of per-material accumulators that collapse into one mesh each. */
export class Buckets {
  private map = new Map<MatKey, MeshBuilder>();

  get(key: MatKey): MeshBuilder {
    let b = this.map.get(key);
    if (!b) {
      b = new MeshBuilder();
      this.map.set(key, b);
    }
    return b;
  }

  get empty(): boolean {
    for (const b of this.map.values()) if (!b.empty) return false;
    return true;
  }

  /** Builds one `Mesh` per non-empty material. */
  /**
   * @param castShadow `true`, `false`, or a per-material-key predicate.
   *
   * Writes `userData.noShadow` as well as `castShadow`, because that flag is
   * the only channel the scene-shading sweep can hear. `castShadow` defaults
   * to false on a fresh mesh, so a module setting it false says exactly as
   * much as a module that never considered the question, and the sweep --
   * which has to turn casting *on* for everything that arrives without an
   * opinion -- handed it straight back. Every road surface in the city was
   * casting a shadow onto the terrain one centimetre beneath it as a result:
   * 494 of 1108 casters, times three cascades.
   */
  flush(
    mats: RoadMaterials,
    namePrefix: string,
    castShadow: boolean | ((key: string) => boolean) = false,
  ): THREE.Mesh[] {
    const out: THREE.Mesh[] = [];
    for (const [key, b] of this.map) {
      const g = b.build();
      if (!g) continue;
      const mesh = new THREE.Mesh(g, mats.get(key));
      mesh.name = `${namePrefix}:${key}`;
      const casts = typeof castShadow === 'function' ? castShadow(key) : castShadow;
      mesh.castShadow = casts;
      if (!casts) mesh.userData.noShadow = true;
      mesh.receiveShadow = true;
      mesh.matrixAutoUpdate = false;
      mesh.updateMatrix();
      out.push(mesh);
    }
    this.map.clear();
    return out;
  }

  stats(): { verts: number; tris: number } {
    let verts = 0;
    let tris = 0;
    for (const b of this.map.values()) {
      verts += b.vertexCount;
      tris += b.triCount;
    }
    return { verts, tris };
  }
}

/* -------------------------------------------------------------- polygons */

/**
 * Fills a closed XZ ring at per-vertex elevations with world-space UVs.
 * Used for junction aprons, portal headwalls and crosswalk islands.
 */
export function emitPolygon(
  out: MeshBuilder, ring: V2[], ys: number[], tile: number, c: RGBA, lift = 0,
): void {
  if (ring.length < 3) return;
  const tris = triangulate(ring);
  if (!tris.length) return;
  const inv = 1 / Math.max(tile, 0.001);
  const base: number[] = new Array(ring.length);
  for (let i = 0; i < ring.length; i++) {
    const p = ring[i];
    base[i] = out.vertN(p.x, (ys[i] ?? 0) + lift, p.z, 0, 1, 0, p.x * inv, p.z * inv, c);
  }
  for (let i = 0; i < tris.length; i += 3) {
    out.tri(base[tris[i]], base[tris[i + 1]], base[tris[i + 2]]);
  }
}

/**
 * An oriented flat rectangle: `c` is the centre, `dir` the long axis.
 * `along` is its length along `dir`, `across` its width. Elevation is
 * supplied per corner so a mark can sit on a crowned or graded surface.
 */
export function emitMark(
  out: MeshBuilder,
  cx: number, cz: number, dir: V2,
  along: number, across: number,
  yAt: (x: number, z: number) => number,
  colour: RGBA, tile: number,
): void {
  const d = norm(dir);
  const n = perp(d);
  const hl = along * 0.5;
  const ha = across * 0.5;
  const inv = 1 / Math.max(tile, 0.001);
  const idx: number[] = [];
  // Corner order gives an upward-facing winding under our XZ conventions.
  const corners: Array<[number, number]> = [
    [-hl, ha], [hl, ha], [hl, -ha], [-hl, -ha],
  ];
  for (const [l, a] of corners) {
    const x = cx + d.x * l + n.x * a;
    const z = cz + d.z * l + n.z * a;
    idx.push(out.vertN(x, yAt(x, z), z, 0, 1, 0, x * inv, z * inv, colour));
  }
  out.tri(idx[0], idx[1], idx[2]);
  out.tri(idx[0], idx[2], idx[3]);
}

/** An arbitrary flat quad given four XZ corners and their elevations. */
export function emitQuad(
  out: MeshBuilder,
  a: V2, b: V2, c: V2, d: V2,
  ya: number, yb: number, yc: number, yd: number,
  colour: RGBA, tile: number,
): void {
  const inv = 1 / Math.max(tile, 0.001);
  const i0 = out.vertN(a.x, ya, a.z, 0, 1, 0, a.x * inv, a.z * inv, colour);
  const i1 = out.vertN(b.x, yb, b.z, 0, 1, 0, b.x * inv, b.z * inv, colour);
  const i2 = out.vertN(c.x, yc, c.z, 0, 1, 0, c.x * inv, c.z * inv, colour);
  const i3 = out.vertN(d.x, yd, d.z, 0, 1, 0, d.x * inv, d.z * inv, colour);
  out.tri(i0, i1, i2);
  out.tri(i0, i2, i3);
}

/**
 * A vertical quad (a wall panel) between two XZ points, from `y0` to `y1`.
 * The normal faces the side the winding implies, i.e. to the left of a->b.
 */
export function emitWall(
  out: MeshBuilder, a: V2, b: V2,
  yBotA: number, yTopA: number, yBotB: number, yTopB: number,
  colour: RGBA, tile: number, flip = false,
): void {
  const d = norm(sub(b, a));
  let nx = d.z;
  let nz = -d.x;
  if (flip) { nx = -nx; nz = -nz; }
  const inv = 1 / Math.max(tile, 0.001);
  const su = 0;
  const eu = dist(a, b) * inv;
  const i0 = out.vertN(a.x, yBotA, a.z, nx, 0, nz, su, yBotA * inv, colour);
  const i1 = out.vertN(b.x, yBotB, b.z, nx, 0, nz, eu, yBotB * inv, colour);
  const i2 = out.vertN(b.x, yTopB, b.z, nx, 0, nz, eu, yTopB * inv, colour);
  const i3 = out.vertN(a.x, yTopA, a.z, nx, 0, nz, su, yTopA * inv, colour);
  if (flip) {
    out.tri(i0, i3, i2);
    out.tri(i0, i2, i1);
  } else {
    out.tri(i0, i1, i2);
    out.tri(i0, i2, i3);
  }
}

/** An axis-aligned-in-plan box (pier, plinth, sleeper) with explicit normals. */
export function emitBox(
  out: MeshBuilder,
  cx: number, cz: number, dir: V2,
  along: number, across: number, yBottom: number, yTop: number,
  colour: RGBA, tile: number, capOnly = false,
): void {
  const d = norm(dir);
  const n = perp(d);
  const hl = along * 0.5;
  const ha = across * 0.5;
  const corner = (l: number, a: number): V2 => ({
    x: cx + d.x * l + n.x * a,
    z: cz + d.z * l + n.z * a,
  });
  const p0 = corner(-hl, ha);
  const p1 = corner(hl, ha);
  const p2 = corner(hl, -ha);
  const p3 = corner(-hl, -ha);
  emitQuad(out, p0, p1, p2, p3, yTop, yTop, yTop, yTop, colour, tile);
  if (capOnly) return;
  emitWall(out, p1, p0, yBottom, yTop, yBottom, yTop, colour, tile);
  emitWall(out, p2, p1, yBottom, yTop, yBottom, yTop, colour, tile);
  emitWall(out, p3, p2, yBottom, yTop, yBottom, yTop, colour, tile);
  emitWall(out, p0, p3, yBottom, yTop, yBottom, yTop, colour, tile);
}

/** A flat regular polygon — manhole covers, gully pots, tree-pit surrounds. */
export function emitDisc(
  out: MeshBuilder, cx: number, y: number, cz: number, r: number,
  sides: number, colour: RGBA, tile: number, rot = 0,
): void {
  const inv = 1 / Math.max(tile, 0.001);
  const centre = out.vertN(cx, y, cz, 0, 1, 0, cx * inv, cz * inv, colour);
  let prev = -1;
  let first = -1;
  for (let i = 0; i <= sides; i++) {
    const a = rot + (i / sides) * Math.PI * 2;
    const x = cx + Math.cos(a) * r;
    const z = cz + Math.sin(a) * r;
    const v = out.vertN(x, y, z, 0, 1, 0, x * inv, z * inv, colour);
    if (i === 0) first = v;
    else out.tri(centre, prev, v);
    prev = v;
  }
  void first;
}

/* -------------------------------------------------------------- polyline */

export interface Chunk {
  pts: V2[];
  ys: number[];
  /** Arc length of this chunk. */
  length: number;
  /** Chunk midpoint, used for tile assignment. */
  mx: number;
  mz: number;
}

/**
 * Splits a polyline into chunks no longer than `maxLen` so that a single road
 * never straddles several culling tiles.
 *
 * Cuts land strictly *inside* a segment, never on a bend: both sides of the
 * cut then share the same tangent, so the two ribbons meet edge-to-edge with
 * no crack and no double-drawn sliver.
 */
export function chunkPolyline(pts: V2[], ys: number[], maxLen: number): Chunk[] {
  const finish = (p: V2[], y: number[]): Chunk | null => {
    if (p.length < 2) return null;
    let len = 0;
    for (let i = 1; i < p.length; i++) len += dist(p[i - 1], p[i]);
    if (len < 0.25) return null;
    // Midpoint by arc length, not by index, so long tails do not skew it.
    let want = len * 0.5;
    let mx = p[0].x;
    let mz = p[0].z;
    for (let i = 1; i < p.length; i++) {
      const d = dist(p[i - 1], p[i]);
      if (want <= d || i === p.length - 1) {
        const t = d > 1e-6 ? Math.min(1, want / d) : 0;
        mx = p[i - 1].x + (p[i].x - p[i - 1].x) * t;
        mz = p[i - 1].z + (p[i].z - p[i - 1].z) * t;
        break;
      }
      want -= d;
    }
    return { pts: p, ys: y, length: len, mx, mz };
  };

  const out: Chunk[] = [];
  let curP: V2[] = [pts[0]];
  let curY: number[] = [ys[0] ?? 0];
  let acc = 0;

  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1];
    const b = pts[i];
    const ya = ys[i - 1] ?? 0;
    const yb = ys[i] ?? 0;
    const segLen = dist(a, b);
    if (segLen < 1e-6) continue;

    // `t0` tracks how much of this segment has already been emitted; a single
    // very long segment may need several cuts.
    let t0 = 0;
    for (;;) {
      const room = maxLen - acc;
      const remain = (1 - t0) * segLen;
      if (remain <= room || remain < 2) {
        curP.push(b);
        curY.push(yb);
        acc += remain;
        break;
      }
      // Cut strictly inside the segment so both sides share a tangent.
      const t = Math.min(0.98, Math.max(t0 + 0.02, t0 + room / segLen));
      const cut = lerp2(a, b, t);
      const cutY = ya + (yb - ya) * t;
      curP.push(cut);
      curY.push(cutY);
      const done = finish(curP, curY);
      if (done) out.push(done);
      curP = [cut];
      curY = [cutY];
      acc = 0;
      t0 = t;
    }
  }

  const tail = finish(curP, curY);
  if (tail) out.push(tail);
  return out;
}
