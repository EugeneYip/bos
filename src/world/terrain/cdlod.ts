/**
 * Continuous distance-dependent LOD (CDLOD) quadtree.
 *
 * The whole terrain is one instanced draw of a single 32x32 unit grid; each
 * visible quadtree node contributes one instance carrying its origin, size and
 * neighbour-coarseness mask. The vertex shader morphs each vertex toward its
 * parent grid as it approaches the switch distance, so a node is *already*
 * identical to its parent by the time the parent replaces it — no popping — and
 * the edge mask hard-snaps boundary vertices onto the coarse neighbour's edge,
 * which makes T-junction cracks impossible rather than merely unlikely.
 *
 * The split threshold K=3.0 is not arbitrary: with a distance-to-AABB metric,
 * adjacent equal-size nodes differ in distance by at most `size*sqrt(2)`
 * (diagonal neighbours), so K >= 2*sqrt(2) guarantees the tree is 2:1 balanced
 * and the one-level edge mask is always sufficient.
 */
import * as THREE from 'three';
import type { Heightfield } from './Heightfield';

export const LEAF_SIZE = 64;
export const LEVELS = 7;
export const GRID_N = 32;
/** Split factor; see the note above before lowering it. */
export const SPLIT_K = 3.0;

const ROOT_SIZE = LEAF_SIZE * 2 ** (LEVELS - 1);
const ROOTS_ACROSS = 7;

export interface SelectionStats {
  nodes: number;
  visited: number;
  tris: number;
}

export class Quadtree {
  readonly gridOriginX: number;
  readonly gridOriginZ: number;
  readonly nodeCount: number;

  private x: Float32Array;
  private z: Float32Array;
  private size: Float32Array;
  private minY: Float32Array;
  private maxY: Float32Array;
  private level: Uint8Array;
  /** Index of the first of four children, or -1. */
  private child: Int32Array;
  private roots: number[] = [];

  constructor(hf: Heightfield) {
    const cx = (hf.originX + hf.maxX) * 0.5;
    const cz = (hf.originZ + hf.maxZ) * 0.5;
    const span = ROOT_SIZE * ROOTS_ACROSS;
    this.gridOriginX = Math.floor((cx - span * 0.5) / ROOT_SIZE) * ROOT_SIZE;
    this.gridOriginZ = Math.floor((cz - span * 0.5) / ROOT_SIZE) * ROOT_SIZE;

    const pad = LEAF_SIZE * 3;
    // Sum the per-level cell counts over the padded data extent, then leave
    // headroom; growing mid-build would be correct but pointlessly slow.
    let cap = ROOTS_ACROSS * ROOTS_ACROSS;
    for (let s = ROOT_SIZE / 2; s >= LEAF_SIZE; s /= 2) {
      cap += (Math.ceil((hf.sizeX + 2 * pad) / s) + 2) * (Math.ceil((hf.sizeZ + 2 * pad) / s) + 2);
    }
    cap = Math.ceil(cap * 1.2) + 256;
    this.x = new Float32Array(cap);
    this.z = new Float32Array(cap);
    this.size = new Float32Array(cap);
    this.minY = new Float32Array(cap);
    this.maxY = new Float32Array(cap);
    this.level = new Uint8Array(cap);
    this.child = new Int32Array(cap).fill(-1);

    const bx0 = hf.originX - pad;
    const bx1 = hf.maxX + pad;
    const bz0 = hf.originZ - pad;
    const bz1 = hf.maxZ + pad;
    const mm: [number, number] = [0, 0];

    let n = 0;
    const build = (nx: number, nz: number, s: number, lvl: number): number => {
      const idx = n++;
      if (idx >= cap) throw new Error('terrain: quadtree capacity exceeded');
      this.x[idx] = nx;
      this.z[idx] = nz;
      this.size[idx] = s;
      this.level[idx] = lvl;

      const inside = nx < bx1 && nx + s > bx0 && nz < bz1 && nz + s > bz0;
      if (lvl > 0 && inside) {
        const hs = s * 0.5;
        const c0 = build(nx, nz, hs, lvl - 1);
        build(nx + hs, nz, hs, lvl - 1);
        build(nx, nz + hs, hs, lvl - 1);
        build(nx + hs, nz + hs, hs, lvl - 1);
        this.child[idx] = c0;
        let lo = Infinity;
        let hi = -Infinity;
        for (let c = c0; c < c0 + 4; c++) {
          if (this.minY[c] < lo) lo = this.minY[c];
          if (this.maxY[c] > hi) hi = this.maxY[c];
        }
        this.minY[idx] = lo;
        this.maxY[idx] = hi;
      } else {
        hf.minMaxRect(nx, nz, nx + s, nz + s, mm);
        this.minY[idx] = mm[0];
        this.maxY[idx] = mm[1];
      }
      return idx;
    };

    for (let j = 0; j < ROOTS_ACROSS; j++) {
      for (let i = 0; i < ROOTS_ACROSS; i++) {
        this.roots.push(build(
          this.gridOriginX + i * ROOT_SIZE,
          this.gridOriginZ + j * ROOT_SIZE,
          ROOT_SIZE,
          LEVELS - 1,
        ));
      }
    }
    this.nodeCount = n;
  }

  /** Selected instance data, refilled every frame. */
  readonly instances = new Float32Array(6144 * 5);
  private selX: Float32Array = new Float32Array(6144);
  private selZ: Float32Array = new Float32Array(6144);
  private selS: Float32Array = new Float32Array(6144);
  private selL: Uint8Array = new Uint8Array(6144);
  private keys = new Set<number>();
  private planes = new Float32Array(24);
  private camX = 0;
  private camY = 0;
  private camZ = 0;
  private count = 0;
  private visited = 0;
  private _m = new THREE.Matrix4();
  private _f = new THREE.Frustum();

  /**
   * Walks the tree once, culling against the frustum and emitting the nodes
   * whose size matches their distance. Returns the instance count.
   */
  select(camera: THREE.PerspectiveCamera, lodBias: number): SelectionStats {
    this._m.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    this._f.setFromProjectionMatrix(this._m);
    for (let i = 0; i < 6; i++) {
      const p = this._f.planes[i];
      this.planes[i * 4] = p.normal.x;
      this.planes[i * 4 + 1] = p.normal.y;
      this.planes[i * 4 + 2] = p.normal.z;
      this.planes[i * 4 + 3] = p.constant;
    }
    this.camX = camera.position.x;
    this.camY = camera.position.y;
    this.camZ = camera.position.z;
    this.count = 0;
    this.visited = 0;
    this.keys.clear();

    const k = SPLIT_K * lodBias;
    for (const r of this.roots) this.descend(r, k);
    this.buildInstances(k);

    return { nodes: this.count, visited: this.visited, tris: this.count * GRID_N * GRID_N * 2 };
  }

  private descend(idx: number, k: number): void {
    this.visited++;
    const s = this.size[idx];
    const x0 = this.x[idx];
    const z0 = this.z[idx];
    const y0 = this.minY[idx] - 1;
    const y1 = this.maxY[idx] + 1;
    if (!this.aabbVisible(x0, y0, z0, x0 + s, y1, z0 + s)) return;

    if (this.child[idx] >= 0 && this.distToAabb(x0, y0, z0, x0 + s, y1, z0 + s) < k * s) {
      const c = this.child[idx];
      this.descend(c, k);
      this.descend(c + 1, k);
      this.descend(c + 2, k);
      this.descend(c + 3, k);
      return;
    }

    const i = this.count;
    if (i >= this.selS.length) return;
    this.selX[i] = x0;
    this.selZ[i] = z0;
    this.selS[i] = s;
    this.selL[i] = this.level[idx];
    this.count = i + 1;
    this.keys.add(cellKey(this.level[idx], (x0 - this.gridOriginX) / s, (z0 - this.gridOriginZ) / s));
  }

  private buildInstances(k: number): void {
    const out = this.instances;
    const gx = this.gridOriginX;
    const gz = this.gridOriginZ;
    for (let i = 0; i < this.count; i++) {
      const s = this.selS[i];
      const lvl = this.selL[i];
      const cx = (this.selX[i] - gx) / s;
      const cz = (this.selZ[i] - gz) / s;
      let mask = 0;
      if (this.coarser(lvl, cx, cz - 1)) mask |= 1; // north (-Z)
      if (this.coarser(lvl, cx + 1, cz)) mask |= 2; // east  (+X)
      if (this.coarser(lvl, cx, cz + 1)) mask |= 4; // south (+Z)
      if (this.coarser(lvl, cx - 1, cz)) mask |= 8; // west  (-X)
      const o = i * 5;
      out[o] = this.selX[i];
      out[o + 1] = this.selZ[i];
      out[o + 2] = s;
      out[o + 3] = 2 * k * s; // distance at which the parent takes over
      out[o + 4] = mask + 16 * lvl;
    }
  }

  private coarser(level: number, cx: number, cz: number): boolean {
    if (this.keys.has(cellKey(level, cx, cz))) return false;
    return this.keys.has(cellKey(level + 1, cx >> 1, cz >> 1));
  }

  private distToAabb(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number): number {
    const dx = this.camX < x0 ? x0 - this.camX : (this.camX > x1 ? this.camX - x1 : 0);
    const dy = this.camY < y0 ? y0 - this.camY : (this.camY > y1 ? this.camY - y1 : 0);
    const dz = this.camZ < z0 ? z0 - this.camZ : (this.camZ > z1 ? this.camZ - z1 : 0);
    return Math.sqrt(dx * dx + dy * dy + dz * dz);
  }

  private aabbVisible(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number): boolean {
    const p = this.planes;
    for (let i = 0; i < 6; i++) {
      const a = p[i * 4];
      const b = p[i * 4 + 1];
      const c = p[i * 4 + 2];
      // Positive vertex: the AABB corner furthest along the plane normal.
      const px = a > 0 ? x1 : x0;
      const py = b > 0 ? y1 : y0;
      const pz = c > 0 ? z1 : z0;
      if (a * px + b * py + c * pz + p[i * 4 + 3] < 0) return false;
    }
    return true;
  }
}

/** Levels fit in 3 bits and cells in 9 — the finest grid is 448 cells across. */
function cellKey(level: number, cx: number, cz: number): number {
  return ((level & 7) * 512 + (cz & 511)) * 512 + (cx & 511);
}

/**
 * The shared unit grid every chunk instances. Vertices carry only their integer
 * grid coordinate; world position and elevation are derived in the shader, so a
 * chunk changing LOD costs nothing but five floats.
 */
export function buildGridGeometry(n: number): THREE.InstancedBufferGeometry {
  const side = n + 1;
  const verts = side * side;
  const grid = new Float32Array(verts * 2);
  for (let j = 0; j <= n; j++) {
    for (let i = 0; i <= n; i++) {
      const k = (j * side + i) * 2;
      grid[k] = i;
      grid[k + 1] = j;
    }
  }
  const idx = new Uint16Array(n * n * 6);
  let o = 0;
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const a = j * side + i;
      const b = a + 1;
      const c = a + side;
      const d = c + 1;
      idx[o++] = a; idx[o++] = c; idx[o++] = b;
      idx[o++] = b; idx[o++] = c; idx[o++] = d;
    }
  }

  const g = new THREE.InstancedBufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(verts * 3), 3));
  g.setAttribute('aGrid', new THREE.BufferAttribute(grid, 2));
  g.setIndex(new THREE.BufferAttribute(idx, 1));
  g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);
  g.boundingBox = new THREE.Box3(
    new THREE.Vector3(-1e5, -1e4, -1e5),
    new THREE.Vector3(1e5, 1e4, 1e5),
  );
  return g;
}
