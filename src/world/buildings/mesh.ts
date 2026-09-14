/**
 * Vertex sink for the merged per-tile building shells.
 *
 * Sixty-three thousand buildings is enough that the vertex *format* is a design
 * decision, not an afterthought: at a naive 3xfloat position + 3xfloat normal +
 * 2xfloat uv + 3xfloat colour + 8 floats of parameters the city would need
 * ~400 MB of buffers. The packed layout below is 40 bytes per vertex and keeps
 * the whole shell under ~120 MB while staying lossless where it matters.
 *
 * | attribute  | type              | meaning                                    |
 * |------------|-------------------|--------------------------------------------|
 * | `position` | float32 x3        | tile-local metres                          |
 * | `normal`   | int8 x4 (norm)    | unit normal                                |
 * | `uv`       | float32 x2        | **metres**, not 0..1 — see `kind`          |
 * | `aTint`    | uint8 x4 (norm)   | rgb building colour, a = weathering        |
 * | `aSurf`    | uint8 x4 (raw)    | layer, flags, seed lo, seed hi             |
 * | `aPar`     | uint16 x4 (norm)  | floor h, ground h, wall top, bay width     |
 *
 * `aSurf.y` packs `kind` in bits 0-1 and `orient` in bit 2:
 *  - kind 0 — facade: `uv` is (metres along the wall, metres above the base)
 *    and the shader picks the ground / field / crown atlas layer per fragment.
 *  - kind 1 — tiled: `uv` is metres, divided by `aPar.w` (tile size) in the shader.
 *  - kind 2 — direct: `uv` is already normalised 0..1 inside one atlas tile.
 *  - orient 0 — vertical surface (tangent runs horizontally, bitangent up).
 *  - orient 1 — roof-like surface (tangent along +X, bitangent along -Z).
 *
 * Indices are split into two sections — `core` (silhouette: walls, roof planes,
 * parapets) and `trim` (cornices, fascias, dormers) — so a single geometry can
 * serve three LODs through `setDrawRange` with no extra memory and no seams.
 */

export const KIND_FACADE = 0;
export const KIND_TILED = 1;
export const KIND_DIRECT = 2;
export const ORIENT_WALL = 0;
export const ORIENT_ROOF = 4;

/** Scales for the normalised uint16 parameter attribute. */
export const PAR_SCALE = [32, 32, 512, 32] as const;

export interface PackedChunk {
  position: Float32Array;
  normal: Int8Array;
  uv: Float32Array;
  tint: Uint8Array;
  surf: Uint8Array;
  par: Uint16Array;
  /** Silhouette indices (LOD2 and up). */
  core: Uint32Array;
  /** Decorative indices, drawn at LOD1 and LOD0. */
  trim: Uint32Array;
  vertexCount: number;
}

const GROW = 1.7;

/**
 * Growable interleaved-by-attribute vertex store. Callers set the per-building
 * state once (`begin`) and then emit primitives; every emitted vertex inherits
 * the current tint / layer / parameters, which keeps the primitive helpers to a
 * handful of arguments.
 */
export class MeshSink {
  position: Float32Array;
  normal: Int8Array;
  uv: Float32Array;
  tint: Uint8Array;
  surf: Uint8Array;
  par: Uint16Array;
  n = 0;

  core: number[] = [];
  trim: number[] = [];
  /** Index list currently being appended to. */
  private out: number[] = this.core;

  // ---- per-building state ------------------------------------------------
  private tr = 200;
  private tg = 200;
  private tb = 200;
  private tw = 0;
  private layer = 0;
  private flags = 0;
  private seedLo = 0;
  private seedHi = 0;
  private p0 = 0;
  private p1 = 0;
  private p2 = 0;
  private p3 = 0;

  constructor(capacity = 4096) {
    this.position = new Float32Array(capacity * 3);
    this.normal = new Int8Array(capacity * 4);
    this.uv = new Float32Array(capacity * 2);
    this.tint = new Uint8Array(capacity * 4);
    this.surf = new Uint8Array(capacity * 4);
    this.par = new Uint16Array(capacity * 4);
  }

  private grow(need: number): void {
    let cap = this.position.length / 3;
    if (this.n + need <= cap) return;
    while (cap < this.n + need) cap = Math.ceil(cap * GROW) + 64;
    const p = new Float32Array(cap * 3);
    p.set(this.position);
    this.position = p;
    const nr = new Int8Array(cap * 4);
    nr.set(this.normal);
    this.normal = nr;
    const u = new Float32Array(cap * 2);
    u.set(this.uv);
    this.uv = u;
    const t = new Uint8Array(cap * 4);
    t.set(this.tint);
    this.tint = t;
    const s = new Uint8Array(cap * 4);
    s.set(this.surf);
    this.surf = s;
    const q = new Uint16Array(cap * 4);
    q.set(this.par);
    this.par = q;
  }

  /** Colour + identity for everything emitted until the next `begin`. */
  begin(r: number, g: number, b: number, weather: number, seed: number): void {
    this.tr = r;
    this.tg = g;
    this.tb = b;
    this.tw = weather < 0 ? 0 : weather > 255 ? 255 : weather | 0;
    this.seedLo = seed & 255;
    this.seedHi = (seed >>> 8) & 255;
  }

  /** Atlas layer + uv interpretation for subsequent primitives. */
  surface(layer: number, kind: number, orient: number): void {
    this.layer = layer & 255;
    this.flags = (kind & 3) | orient;
  }

  /** Facade parameters (metres). For tiled surfaces pass the tile size in `bayW`. */
  params(floorH: number, groundH: number, wallTop: number, bayW: number): void {
    this.p0 = q16(floorH, PAR_SCALE[0]);
    this.p1 = q16(groundH, PAR_SCALE[1]);
    this.p2 = q16(wallTop, PAR_SCALE[2]);
    this.p3 = q16(bayW, PAR_SCALE[3]);
  }

  section(which: 0 | 1): void {
    this.out = which === 0 ? this.core : this.trim;
  }

  /** Append one vertex; returns its index. */
  vertex(
    x: number, y: number, z: number,
    nx: number, ny: number, nz: number,
    u: number, v: number,
  ): number {
    this.grow(1);
    const i = this.n++;
    const p3i = i * 3;
    this.position[p3i] = x;
    this.position[p3i + 1] = y;
    this.position[p3i + 2] = z;
    const i4 = i * 4;
    this.normal[i4] = clampI8(nx * 127);
    this.normal[i4 + 1] = clampI8(ny * 127);
    this.normal[i4 + 2] = clampI8(nz * 127);
    this.normal[i4 + 3] = 0;
    const i2 = i * 2;
    this.uv[i2] = u;
    this.uv[i2 + 1] = v;
    this.tint[i4] = this.tr;
    this.tint[i4 + 1] = this.tg;
    this.tint[i4 + 2] = this.tb;
    this.tint[i4 + 3] = this.tw;
    this.surf[i4] = this.layer;
    this.surf[i4 + 1] = this.flags;
    this.surf[i4 + 2] = this.seedLo;
    this.surf[i4 + 3] = this.seedHi;
    this.par[i4] = this.p0;
    this.par[i4 + 1] = this.p1;
    this.par[i4 + 2] = this.p2;
    this.par[i4 + 3] = this.p3;
    return i;
  }

  tri(a: number, b: number, c: number): void {
    this.out.push(a, b, c);
  }

  /** Quad a-b-c-d, wound so the supplied normal faces outward. */
  quadIdx(a: number, b: number, c: number, d: number): void {
    this.out.push(a, b, c, a, c, d);
  }

  /**
   * Planar quad from four corners with one shared normal. Corners must be
   * given counter-clockwise as seen from the front (normal) side.
   */
  quad(
    ax: number, ay: number, az: number, au: number, av: number,
    bx: number, by: number, bz: number, bu: number, bv: number,
    cx: number, cy: number, cz: number, cu: number, cv: number,
    dx: number, dy: number, dz: number, du: number, dv: number,
    nx: number, ny: number, nz: number,
  ): void {
    const a = this.vertex(ax, ay, az, nx, ny, nz, au, av);
    const b = this.vertex(bx, by, bz, nx, ny, nz, bu, bv);
    const c = this.vertex(cx, cy, cz, nx, ny, nz, cu, cv);
    const d = this.vertex(dx, dy, dz, nx, ny, nz, du, dv);
    this.quadIdx(a, b, c, d);
  }

  /**
   * Vertical wall quad from (x0,z0) to (x1,z1) between two heights, with the
   * outward normal derived from the edge direction. `u0` is the horizontal UV
   * origin in metres; `vBase` shifts the vertical UV (metres above the base).
   */
  wallQuad(
    x0: number, z0: number, x1: number, z1: number,
    yBot: number, yTop: number,
    u0: number, vBot: number, vTop: number,
    flip = false,
  ): void {
    const dx = x1 - x0;
    const dz = z1 - z0;
    const len = Math.hypot(dx, dz);
    if (len < 1e-4 || yTop - yBot < 1e-4) return;
    // outward normal of a canonically wound ring edge is (dz, 0, -dx)
    let nx = dz / len;
    let nz = -dx / len;
    if (flip) {
      nx = -nx;
      nz = -nz;
    }
    const u1 = u0 + len;
    const a = this.vertex(x0, yBot, z0, nx, 0, nz, u0, vBot);
    const b = this.vertex(x1, yBot, z1, nx, 0, nz, u1, vBot);
    const c = this.vertex(x1, yTop, z1, nx, 0, nz, u1, vTop);
    const d = this.vertex(x0, yTop, z0, nx, 0, nz, u0, vTop);
    // Seen from above, a canonically wound ring runs *clockwise* in a Y-up
    // right-handed world, so a-b-c-d would face inward. Reverse for outward.
    if (flip) this.quadIdx(a, b, c, d);
    else this.quadIdx(a, d, c, b);
  }

  /** Outward-facing vertical quad strip around a whole ring. */
  vertBand(ring: number[], yBot: number, yTop: number, u0 = 0, flip = false): void {
    const n = ring.length >> 1;
    let u = u0;
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      const x0 = ring[i * 2];
      const z0 = ring[i * 2 + 1];
      const x1 = ring[j * 2];
      const z1 = ring[j * 2 + 1];
      this.wallQuad(x0, z0, x1, z1, yBot, yTop, u, 0, yTop - yBot, flip);
      u += Math.hypot(x1 - x0, z1 - z0);
    }
  }

  /**
   * A quad strip band between two 2D rings at (possibly different) heights —
   * the workhorse for parapet copings, cornices and eave fascias. Both rings
   * must have the same vertex count and matching winding.
   */
  band(
    outer: number[], outerY: number | number[],
    inner: number[], innerY: number | number[],
    nyBias: number, upFacing: boolean,
  ): void {
    const n = outer.length >> 1;
    if (n < 3 || inner.length >> 1 !== n) return;
    const oy = (i: number): number => (typeof outerY === 'number' ? outerY : outerY[i]);
    const iy = (i: number): number => (typeof innerY === 'number' ? innerY : innerY[i]);

    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      const ax = outer[i * 2];
      const az = outer[i * 2 + 1];
      const bx = outer[j * 2];
      const bz = outer[j * 2 + 1];
      const cx = inner[j * 2];
      const cz = inner[j * 2 + 1];
      const dx = inner[i * 2];
      const dz = inner[i * 2 + 1];
      const ay = oy(i);
      const by = oy(j);
      const cy = iy(j);
      const dy = iy(i);

      // face normal from the diagonal cross product, nudged by nyBias
      let px = bx - ax;
      let py = by - ay;
      let pz = bz - az;
      let qx = dx - ax;
      let qy = dy - ay;
      let qz = dz - az;
      let nx = py * qz - pz * qy;
      let ny = pz * qx - px * qz;
      let nz = px * qy - py * qx;
      const l = Math.hypot(nx, ny, nz);
      if (l < 1e-9) continue;
      nx /= l;
      ny /= l;
      nz /= l;
      if (upFacing !== ny > 0) {
        nx = -nx;
        ny = -ny;
        nz = -nz;
      }
      ny += nyBias;
      const l2 = Math.hypot(nx, ny, nz) || 1;
      nx /= l2;
      ny /= l2;
      nz /= l2;

      const va = this.vertex(ax, ay, az, nx, ny, nz, ax, -az);
      const vb = this.vertex(bx, by, bz, nx, ny, nz, bx, -bz);
      const vc = this.vertex(cx, cy, cz, nx, ny, nz, cx, -cz);
      const vd = this.vertex(dx, dy, dz, nx, ny, nz, dx, -dz);
      // Wind so the emitted normal matches the geometric one.
      px = bx - ax;
      pz = bz - az;
      qx = dx - ax;
      qz = dz - az;
      const up = px * qz - pz * qx < 0;
      if (up === (ny > 0)) this.quadIdx(va, vb, vc, vd);
      else this.quadIdx(va, vd, vc, vb);
    }
  }

  /** Freeze into transferable typed arrays. */
  pack(): PackedChunk {
    const n = this.n;
    return {
      position: this.position.slice(0, n * 3),
      normal: this.normal.slice(0, n * 4),
      uv: this.uv.slice(0, n * 2),
      tint: this.tint.slice(0, n * 4),
      surf: this.surf.slice(0, n * 4),
      par: this.par.slice(0, n * 4),
      core: Uint32Array.from(this.core),
      trim: Uint32Array.from(this.trim),
      vertexCount: n,
    };
  }

  get empty(): boolean {
    return this.core.length === 0 && this.trim.length === 0;
  }
}

const clampI8 = (v: number): number => (v < -127 ? -127 : v > 127 ? 127 : Math.round(v));
const q16 = (v: number, scale: number): number => {
  const t = (v / scale) * 65535;
  return t < 0 ? 0 : t > 65535 ? 65535 : Math.round(t);
};

/** Concatenate several chunks covering the same tile into one. */
export function mergeChunks(parts: PackedChunk[]): PackedChunk | null {
  const live = parts.filter((p) => p.vertexCount > 0);
  if (live.length === 0) return null;
  if (live.length === 1) return live[0];

  let vn = 0;
  let cn = 0;
  let tn = 0;
  for (const p of live) {
    vn += p.vertexCount;
    cn += p.core.length;
    tn += p.trim.length;
  }
  const out: PackedChunk = {
    position: new Float32Array(vn * 3),
    normal: new Int8Array(vn * 4),
    uv: new Float32Array(vn * 2),
    tint: new Uint8Array(vn * 4),
    surf: new Uint8Array(vn * 4),
    par: new Uint16Array(vn * 4),
    core: new Uint32Array(cn),
    trim: new Uint32Array(tn),
    vertexCount: vn,
  };
  let v = 0;
  let c = 0;
  let t = 0;
  for (const p of live) {
    out.position.set(p.position, v * 3);
    out.normal.set(p.normal, v * 4);
    out.uv.set(p.uv, v * 2);
    out.tint.set(p.tint, v * 4);
    out.surf.set(p.surf, v * 4);
    out.par.set(p.par, v * 4);
    for (let i = 0; i < p.core.length; i++) out.core[c + i] = p.core[i] + v;
    for (let i = 0; i < p.trim.length; i++) out.trim[t + i] = p.trim[i] + v;
    c += p.core.length;
    t += p.trim.length;
    v += p.vertexCount;
  }
  return out;
}
