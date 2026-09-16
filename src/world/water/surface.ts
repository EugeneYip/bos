/**
 * Surface geometry.
 *
 * Earcut alone gives correct water but useless topology — 300 m slivers that
 * cannot carry a Gerstner displacement. So the polygons are re-meshed onto a
 * single global lattice:
 *
 *   - cells wholly inside a body become a shared-vertex quad (2 triangles,
 *     ~1 vertex per cell),
 *   - cells the shoreline crosses are filled by clipping the earcut triangles
 *     to the cell.
 *
 * Both sides of every cell boundary are produced by the same half-plane clip,
 * so the vertices agree bit-for-bit and the sheet stays watertight. The only
 * T-junctions possible are where a clipped cell meets a lattice quad, and
 * those cells are by definition on the shoreline, where the wave amplitude is
 * already shoaled to zero — the surfaces there are coplanar to within a
 * millimetre.
 *
 * Chunks exist purely so three can frustum-cull the harbour when the camera is
 * looking at Back Bay.
 */
import * as THREE from 'three';
import type { WaterBody } from './bodies';
import type { WaterField } from './field';
import { clipHalfPlane, dedupe, markEdgeCells, scanFill, triangulateRings } from './poly';

export interface SurfaceBuild {
  chunks: THREE.BufferGeometry[];
  triangles: number;
  vertices: number;
}

/** Extra vertical slack in every bounding box so displaced crests never pop. */
const WAVE_SLACK = 2.5;

class ChunkAcc {
  pos: number[] = [];
  wav: number[] = [];
  idx: number[] = [];
  shared = new Map<number, number>();
  minX = Infinity; minZ = Infinity; maxX = -Infinity; maxZ = -Infinity;
  minY = Infinity; maxY = -Infinity;

  push(x: number, y: number, z: number, shore: number, fetch: number): number {
    const i = this.pos.length / 3;
    this.pos.push(x, y, z);
    this.wav.push(shore, fetch);
    if (x < this.minX) this.minX = x;
    if (x > this.maxX) this.maxX = x;
    if (z < this.minZ) this.minZ = z;
    if (z > this.maxZ) this.maxZ = z;
    if (y < this.minY) this.minY = y;
    if (y > this.maxY) this.maxY = y;
    return i;
  }

  tri(a: number, b: number, c: number): void {
    this.idx.push(a, b, c);
  }

  toGeometry(): THREE.BufferGeometry | null {
    if (this.idx.length === 0) return null;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('aWave', new THREE.Float32BufferAttribute(this.wav, 2));
    g.setIndex(this.pos.length / 3 > 65535
      ? new THREE.Uint32BufferAttribute(this.idx, 1)
      : new THREE.Uint16BufferAttribute(this.idx, 1));
    g.boundingBox = new THREE.Box3(
      new THREE.Vector3(this.minX, this.minY - WAVE_SLACK, this.minZ),
      new THREE.Vector3(this.maxX, this.maxY + WAVE_SLACK, this.maxZ),
    );
    g.boundingSphere = new THREE.Sphere();
    g.boundingBox.getBoundingSphere(g.boundingSphere);
    return g;
  }
}

export function buildSurfaces(
  bodies: WaterBody[], field: WaterField, cell: number, chunkSize: number,
): SurfaceBuild {
  const GX0 = field.x0;
  const GZ0 = field.z0;
  const chunks = new Map<number, ChunkAcc>();

  const chunkOf = (x: number, z: number): ChunkAcc => {
    const ci = Math.floor((x - GX0) / chunkSize);
    const cj = Math.floor((z - GZ0) / chunkSize);
    const key = cj * 4096 + ci;
    let a = chunks.get(key);
    if (!a) { a = new ChunkAcc(); chunks.set(key, a); }
    return a;
  };

  // Scratch buffers for the grid clipper; sized for the worst convex result.
  const bufA: number[] = new Array(64).fill(0);
  const bufB: number[] = new Array(64).fill(0);
  const bufC: number[] = new Array(64).fill(0);

  for (const body of bodies) {
    if (body.skipGeometry) continue;

    const i0 = Math.floor((body.bounds[0] - GX0) / cell);
    const i1 = Math.floor((body.bounds[2] - GX0) / cell);
    const j0 = Math.floor((body.bounds[1] - GZ0) / cell);
    const j1 = Math.floor((body.bounds[3] - GZ0) / cell);
    const nx = i1 - i0 + 1;
    const nz = j1 - j0 + 1;
    if (nx <= 0 || nz <= 0) continue;

    const lx0 = GX0 + i0 * cell;
    const lz0 = GZ0 + j0 * cell;

    // Lattice-corner coverage: scanFill's "cell centres" are placed exactly on
    // the lattice points by shifting its origin back half a cell.
    const pw = nx + 1, ph = nz + 1;
    const ins = new Uint8Array(pw * ph);
    scanFill(body.rings, lx0 - cell * 0.5, lz0 - cell * 0.5, cell, cell, pw, ph, (k) => { ins[k] = 1; });

    // Conservative shoreline marking, so no cell is called FULL by accident.
    const edge = new Uint8Array(nx * nz);
    markEdgeCells(body.rings, lx0, lz0, cell, nx, nz, edge, 1);

    const y = body.elevation;
    const partial = new Uint8Array(nx * nz);

    for (let j = 0; j < nz; j++) {
      for (let i = 0; i < nx; i++) {
        const c = j * nx + i;
        if (edge[c]) { partial[c] = 1; continue; }
        const inAll = ins[j * pw + i] && ins[j * pw + i + 1] && ins[(j + 1) * pw + i] && ins[(j + 1) * pw + i + 1];
        if (!inAll) continue;

        const x = lx0 + i * cell;
        const z = lz0 + j * cell;

        const acc = chunkOf(x + cell * 0.5, z + cell * 0.5);
        const share = (li: number, lj: number): number => {
          const key = lj * pw + li;
          let v = acc.shared.get(key);
          if (v === undefined) {
            const vx = lx0 + li * cell, vz = lz0 + lj * cell;
            v = acc.push(vx, y, vz, field.sampleDist(vx, vz), field.sampleFetch(vx, vz));
            acc.shared.set(key, v);
          }
          return v;
        };
        const a = share(i, j), b = share(i + 1, j), d = share(i + 1, j + 1), e = share(i, j + 1);
        acc.tri(a, b, d);
        acc.tri(a, d, e);
      }
    }

    // Shoreline cells: clip the earcut triangles into them.
    const mesh = triangulateRings(body.outer, body.holes);
    const V = mesh.verts;
    for (let t = 0; t < mesh.tris.length; t += 3) {
      const a = mesh.tris[t] * 2, b = mesh.tris[t + 1] * 2, c = mesh.tris[t + 2] * 2;
      const ax = V[a], az = V[a + 1], bx = V[b], bz = V[b + 1], cx = V[c], cz = V[c + 1];

      let tminZ = az < bz ? az : bz; if (cz < tminZ) tminZ = cz;
      let tmaxZ = az > bz ? az : bz; if (cz > tmaxZ) tmaxZ = cz;
      let jj0 = Math.floor((tminZ - lz0) / cell);
      let jj1 = Math.floor((tmaxZ - lz0) / cell);
      if (jj0 < 0) jj0 = 0;
      if (jj1 > nz - 1) jj1 = nz - 1;

      for (let j = jj0; j <= jj1; j++) {
        // Band clip: z in [zLo, zHi].
        const zLo = lz0 + j * cell, zHi = zLo + cell;
        bufA[0] = ax; bufA[1] = az; bufA[2] = bx; bufA[3] = bz; bufA[4] = cx; bufA[5] = cz;
        let n = clipHalfPlane(bufA, 6, bufB, 1, zLo, true);
        if (n < 6) continue;
        n = clipHalfPlane(bufB, n, bufA, 1, zHi, false);
        if (n < 6) continue;

        let bminX = Infinity, bmaxX = -Infinity;
        for (let k = 0; k < n; k += 2) {
          if (bufA[k] < bminX) bminX = bufA[k];
          if (bufA[k] > bmaxX) bmaxX = bufA[k];
        }
        let ii0 = Math.floor((bminX - lx0) / cell);
        let ii1 = Math.floor((bmaxX - lx0) / cell);
        if (ii0 < 0) ii0 = 0;
        if (ii1 > nx - 1) ii1 = nx - 1;

        for (let i = ii0; i <= ii1; i++) {
          if (!partial[j * nx + i]) continue;
          const xLo = lx0 + i * cell, xHi = xLo + cell;
          let m = clipHalfPlane(bufA, n, bufB, 0, xLo, true);
          if (m < 6) continue;
          m = clipHalfPlane(bufB, m, bufC, 0, xHi, false);
          m = dedupe(bufC, m);
          if (m < 6) continue;

          const acc = chunkOf(xLo + cell * 0.5, zLo + cell * 0.5);
          const base = acc.pos.length / 3;
          for (let k = 0; k < m; k += 2) {
            const vx = bufC[k], vz = bufC[k + 1];
            acc.push(vx, y, vz, field.sampleDist(vx, vz), field.sampleFetch(vx, vz));
          }
          const count = m / 2;
          for (let k = 1; k + 1 < count; k++) acc.tri(base, base + k, base + k + 1);
        }
      }
    }

    for (const acc of chunks.values()) acc.shared.clear();
  }

  const out: THREE.BufferGeometry[] = [];
  let triangles = 0, vertices = 0;
  for (const acc of chunks.values()) {
    const g = acc.toGeometry();
    if (!g) continue;
    triangles += acc.idx.length / 3;
    vertices += acc.pos.length / 3;
    out.push(g);
  }
  return { chunks: out, triangles, vertices };
}

/**
 * The open water beyond the dataset.
 *
 * Concentric rectangles expanding from the modelled rect out to 45 km, with
 * exponentially growing spacing. The innermost ring starts *inside* the rect so
 * it underlaps the harbour polygons, where the depth buffer hides it; from
 * there out it is masked by the clamped shoreline field, which continues
 * Boston's coast past the edge of the data instead of stopping at it.
 */
export function buildOceanSkirt(
  field: WaterField,
  rect: { minX: number; minZ: number; maxX: number; maxZ: number },
  seaLevel: number,
): THREE.BufferGeometry {
  const offsets = [-500, -140, 0, 90, 230, 520, 1150, 2500, 5400, 11000, 22000, 45000];
  const nxSide = 110;
  const nzSide = 92;
  const perRing = 2 * (nxSide + nzSide);

  const pos: number[] = [];
  const wav: number[] = [];
  const idx: number[] = [];

  for (const o of offsets) {
    const x0 = rect.minX - o, x1 = rect.maxX + o;
    const z0 = rect.minZ - o, z1 = rect.maxZ + o;
    const pts: number[] = [];
    for (let i = 0; i < nxSide; i++) pts.push(x0 + ((x1 - x0) * i) / nxSide, z0);
    for (let i = 0; i < nzSide; i++) pts.push(x1, z0 + ((z1 - z0) * i) / nzSide);
    for (let i = 0; i < nxSide; i++) pts.push(x1 - ((x1 - x0) * i) / nxSide, z1);
    for (let i = 0; i < nzSide; i++) pts.push(x0, z1 - ((z1 - z0) * i) / nzSide);
    for (let k = 0; k < perRing; k++) {
      const x = pts[k * 2], z = pts[k * 2 + 1];
      pos.push(x, seaLevel, z);
      wav.push(field.sampleDist(x, z), Math.max(0.9, field.sampleFetch(x, z)));
    }
  }

  for (let r = 0; r + 1 < offsets.length; r++) {
    const a0 = r * perRing, b0 = (r + 1) * perRing;
    for (let k = 0; k < perRing; k++) {
      const k1 = (k + 1) % perRing;
      idx.push(a0 + k, b0 + k, b0 + k1);
      idx.push(a0 + k, b0 + k1, a0 + k1);
    }
  }

  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('aWave', new THREE.Float32BufferAttribute(wav, 2));
  g.setIndex(new THREE.Uint32BufferAttribute(idx, 1));
  const far = 45000 + Math.max(rect.maxX - rect.minX, rect.maxZ - rect.minZ);
  g.boundingSphere = new THREE.Sphere(
    new THREE.Vector3((rect.minX + rect.maxX) * 0.5, seaLevel, (rect.minZ + rect.maxZ) * 0.5),
    far,
  );
  return g;
}
