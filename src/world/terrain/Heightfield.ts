/**
 * CPU-side heightfield.
 *
 * Owns the single source of truth for ground elevation: the USGS/3DEP posts
 * from `public/data/terrain.bin`, cubically upsampled and then carved by the
 * water polygons so the harbour and the river channels actually have a bed.
 *
 * Everything else in the engine — buildings, roads, props, trees, physics, the
 * walk camera — reads this through `ctx.sampleHeight`, so `sample()` is written
 * to be allocation-free and branch-light; it is called tens of thousands of
 * times during load and every frame after that.
 */
import type { TerrainData } from '../../core/types';

export class Heightfield {
  /** Posts across (X) and down (Z). */
  readonly width: number;
  readonly height: number;
  /** World position of post (0,0) — the north-west corner. */
  readonly originX: number;
  readonly originZ: number;
  readonly spacingX: number;
  readonly spacingZ: number;
  readonly invSpacingX: number;
  readonly invSpacingZ: number;
  /** Row-major elevations, metres above sea level. */
  readonly data: Float32Array;

  minElevation = 0;
  maxElevation = 0;

  constructor(
    width: number,
    height: number,
    originX: number,
    originZ: number,
    spacingX: number,
    spacingZ: number,
    data: Float32Array,
  ) {
    this.width = width;
    this.height = height;
    this.originX = originX;
    this.originZ = originZ;
    this.spacingX = spacingX;
    this.spacingZ = spacingZ;
    this.invSpacingX = 1 / spacingX;
    this.invSpacingZ = 1 / spacingZ;
    this.data = data;
    this.refreshRange();
  }

  get sizeX(): number { return (this.width - 1) * this.spacingX; }
  get sizeZ(): number { return (this.height - 1) * this.spacingZ; }
  get maxX(): number { return this.originX + this.sizeX; }
  get maxZ(): number { return this.originZ + this.sizeZ; }

  refreshRange(): void {
    const d = this.data;
    let mn = Infinity;
    let mx = -Infinity;
    for (let i = 0; i < d.length; i++) {
      const v = d[i];
      if (v < mn) mn = v;
      if (v > mx) mx = v;
    }
    this.minElevation = mn;
    this.maxElevation = mx;
  }

  /**
   * Builds the runtime heightfield from the shipped posts, optionally refining
   * by an integer factor with a separable Catmull-Rom filter. The source posts
   * sit ~9 m apart; refining to ~4.5 m costs 18 MB and buys a shoreline that is
   * twice as crisp, which is the most scrutinised silhouette in the model.
   */
  static fromData(td: TerrainData, upsample: number): Heightfield {
    const sx = td.sizeX / (td.width - 1);
    const sz = td.sizeZ / (td.height - 1);
    if (upsample <= 1) {
      return new Heightfield(
        td.width, td.height, td.originX, td.originZ, sx, sz,
        Float32Array.from(td.elevations),
      );
    }

    const u = Math.round(upsample);
    const w0 = td.width;
    const h0 = td.height;
    const w1 = (w0 - 1) * u + 1;
    const h1 = (h0 - 1) * u + 1;
    const src = td.elevations;

    // Pass 1: refine along X into a w1 x h0 scratch buffer.
    const tmp = new Float32Array(w1 * h0);
    for (let j = 0; j < h0; j++) {
      const row = j * w0;
      const out = j * w1;
      for (let i = 0; i < w0 - 1; i++) {
        const p0 = src[row + (i > 0 ? i - 1 : 0)];
        const p1 = src[row + i];
        const p2 = src[row + i + 1];
        const p3 = src[row + Math.min(i + 2, w0 - 1)];
        for (let k = 0; k < u; k++) tmp[out + i * u + k] = catmull(p0, p1, p2, p3, k / u);
      }
      tmp[out + w1 - 1] = src[row + w0 - 1];
    }

    // Pass 2: refine along Z.
    const dst = new Float32Array(w1 * h1);
    for (let i = 0; i < w1; i++) {
      for (let j = 0; j < h0 - 1; j++) {
        const p0 = tmp[(j > 0 ? j - 1 : 0) * w1 + i];
        const p1 = tmp[j * w1 + i];
        const p2 = tmp[(j + 1) * w1 + i];
        const p3 = tmp[Math.min(j + 2, h0 - 1) * w1 + i];
        for (let k = 0; k < u; k++) dst[(j * u + k) * w1 + i] = catmull(p0, p1, p2, p3, k / u);
      }
      dst[(h1 - 1) * w1 + i] = tmp[(h0 - 1) * w1 + i];
    }

    return new Heightfield(w1, h1, td.originX, td.originZ, sx / u, sz / u, dst);
  }

  /**
   * Bilinear elevation lookup, clamped outside the grid. Hot path: no
   * allocation, no method calls, no `Math.min` chains on the inner terms.
   */
  sample(x: number, z: number): number {
    const w = this.width;
    let fx = (x - this.originX) * this.invSpacingX;
    let fz = (z - this.originZ) * this.invSpacingZ;
    if (fx < 0) fx = 0; else if (fx > w - 1.0001) fx = w - 1.0001;
    if (fz < 0) fz = 0; else if (fz > this.height - 1.0001) fz = this.height - 1.0001;
    const i = fx | 0;
    const j = fz | 0;
    const tx = fx - i;
    const tz = fz - j;
    const d = this.data;
    const r0 = j * w + i;
    const r1 = r0 + w;
    const a = d[r0];
    const b = d[r0 + 1];
    const c = d[r1];
    const e = d[r1 + 1];
    return (a + (b - a) * tx) + ((c + (e - c) * tx) - (a + (b - a) * tx)) * tz;
  }

  /** Central-difference surface normal, written into `out` (x,y,z). */
  normalInto(x: number, z: number, out: Float32Array | number[]): void {
    const ex = this.spacingX;
    const ez = this.spacingZ;
    const dx = (this.sample(x - ex, z) - this.sample(x + ex, z)) / (2 * ex);
    const dz = (this.sample(x, z - ez) - this.sample(x, z + ez)) / (2 * ez);
    const inv = 1 / Math.sqrt(dx * dx + 1 + dz * dz);
    out[0] = dx * inv;
    out[1] = inv;
    out[2] = dz * inv;
  }

  /** Exact min/max over a world-space rectangle; used to build chunk AABBs. */
  minMaxRect(x0: number, z0: number, x1: number, z1: number, out: [number, number]): void {
    const w = this.width;
    const h = this.height;
    let i0 = Math.floor((x0 - this.originX) * this.invSpacingX);
    let i1 = Math.ceil((x1 - this.originX) * this.invSpacingX);
    let j0 = Math.floor((z0 - this.originZ) * this.invSpacingZ);
    let j1 = Math.ceil((z1 - this.originZ) * this.invSpacingZ);
    if (i0 < 0) i0 = 0; if (i1 > w - 1) i1 = w - 1;
    if (j0 < 0) j0 = 0; if (j1 > h - 1) j1 = h - 1;
    if (i0 > i1 || j0 > j1) {
      // Entirely outside the grid: clamped sampling gives the nearest edge post.
      const v = this.sample((x0 + x1) * 0.5, (z0 + z1) * 0.5);
      out[0] = v;
      out[1] = v;
      return;
    }
    const d = this.data;
    let mn = Infinity;
    let mx = -Infinity;
    for (let j = j0; j <= j1; j++) {
      const row = j * w;
      for (let i = i0; i <= i1; i++) {
        const v = d[row + i];
        if (v < mn) mn = v;
        if (v > mx) mx = v;
      }
    }
    out[0] = mn;
    out[1] = mx;
  }
}

function catmull(p0: number, p1: number, p2: number, p3: number, t: number): number {
  const t2 = t * t;
  const t3 = t2 * t;
  return 0.5 * (
    2 * p1
    + (p2 - p0) * t
    + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2
    + (3 * p1 - p0 - 3 * p2 + p3) * t3
  );
}
