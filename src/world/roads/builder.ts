/**
 * Growable interleaved-ish geometry accumulator. Every piece of road geometry
 * funnels through one of these so a whole tile collapses into a single
 * BufferGeometry (and therefore a single draw call) per material.
 */
import * as THREE from 'three';

class F32 {
  data: Float32Array;
  n = 0;
  constructor(cap = 4096) {
    this.data = new Float32Array(cap);
  }
  push(...v: number[]): void {
    if (this.n + v.length > this.data.length) this.grow(this.n + v.length);
    for (let i = 0; i < v.length; i++) this.data[this.n++] = v[i];
  }
  private grow(min: number): void {
    let cap = this.data.length * 2;
    while (cap < min) cap *= 2;
    const next = new Float32Array(cap);
    next.set(this.data.subarray(0, this.n));
    this.data = next;
  }
  view(): Float32Array {
    return this.data.subarray(0, this.n);
  }
}

class U8 {
  data: Uint8Array;
  n = 0;
  constructor(cap = 4096) {
    this.data = new Uint8Array(cap);
  }
  push(...v: number[]): void {
    if (this.n + v.length > this.data.length) this.grow(this.n + v.length);
    for (let i = 0; i < v.length; i++) this.data[this.n++] = v[i];
  }
  private grow(min: number): void {
    let cap = this.data.length * 2;
    while (cap < min) cap *= 2;
    const next = new Uint8Array(cap);
    next.set(this.data.subarray(0, this.n));
    this.data = next;
  }
  view(): Uint8Array {
    return this.data.subarray(0, this.n);
  }
}

class U32 {
  data: Uint32Array;
  n = 0;
  constructor(cap = 8192) {
    this.data = new Uint32Array(cap);
  }
  push3(a: number, b: number, c: number): void {
    if (this.n + 3 > this.data.length) this.grow(this.n + 3);
    this.data[this.n++] = a;
    this.data[this.n++] = b;
    this.data[this.n++] = c;
  }
  private grow(min: number): void {
    let cap = this.data.length * 2;
    while (cap < min) cap *= 2;
    const next = new Uint32Array(cap);
    next.set(this.data.subarray(0, this.n));
    this.data = next;
  }
  view(): Uint32Array {
    return this.data.subarray(0, this.n);
  }
}

/** Linear-space RGBA quantised to bytes; three treats vertex colour as linear. */
export type RGBA = [number, number, number, number];

const _c = new THREE.Color();
const linCache = new Map<number, [number, number, number]>();

/** sRGB hex -> linear RGB floats, cached. */
export function srgbLinear(hex: number): [number, number, number] {
  let v = linCache.get(hex);
  if (!v) {
    _c.setHex(hex, THREE.SRGBColorSpace);
    v = [_c.r, _c.g, _c.b];
    linCache.set(hex, v);
  }
  return v;
}

export function rgba(hex: number, mul = 1, alpha = 1): RGBA {
  const l = srgbLinear(hex);
  return [l[0] * mul, l[1] * mul, l[2] * mul, alpha];
}

export const WHITE: RGBA = [1, 1, 1, 1];

export class MeshBuilder {
  private pos = new F32(1 << 14);
  private uv = new F32(1 << 13);
  private col = new U8(1 << 14);
  private idx = new U32(1 << 14);
  /** Optional explicit normals; when empty the geometry derives them. */
  private nrm = new F32(64);
  private useNormals = false;

  vertexCount = 0;
  triCount = 0;
  /** Bounding box accumulated as we go, used for culling spheres. */
  minX = Infinity; minY = Infinity; minZ = Infinity;
  maxX = -Infinity; maxY = -Infinity; maxZ = -Infinity;

  vert(x: number, y: number, z: number, u: number, v: number, c: RGBA): number {
    this.pos.push(x, y, z);
    this.uv.push(u, v);
    this.col.push(
      clamp255(c[0] * 255), clamp255(c[1] * 255), clamp255(c[2] * 255), clamp255(c[3] * 255),
    );
    if (x < this.minX) this.minX = x;
    if (y < this.minY) this.minY = y;
    if (z < this.minZ) this.minZ = z;
    if (x > this.maxX) this.maxX = x;
    if (y > this.maxY) this.maxY = y;
    if (z > this.maxZ) this.maxZ = z;
    return this.vertexCount++;
  }

  /** Variant that stores an explicit normal (used for kerb faces and parapets). */
  vertN(
    x: number, y: number, z: number,
    nx: number, ny: number, nz: number,
    u: number, v: number, c: RGBA,
  ): number {
    if (!this.useNormals) {
      this.useNormals = true;
      // Back-fill any vertices emitted before the first explicit normal.
      for (let i = 0; i < this.vertexCount; i++) this.nrm.push(0, 1, 0);
    }
    this.nrm.push(nx, ny, nz);
    return this.vert(x, y, z, u, v, c);
  }

  tri(a: number, b: number, c: number): void {
    this.idx.push3(a, b, c);
    this.triCount++;
  }

  quad(a: number, b: number, c: number, d: number): void {
    this.tri(a, b, c);
    this.tri(a, c, d);
  }

  get empty(): boolean {
    return this.triCount === 0;
  }

  build(): THREE.BufferGeometry | null {
    if (this.triCount === 0) return null;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(this.pos.view()), 3));
    g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(this.uv.view()), 2));
    g.setAttribute('color', new THREE.BufferAttribute(new Uint8Array(this.col.view()), 4, true));
    g.setIndex(new THREE.BufferAttribute(new Uint32Array(this.idx.view()), 1));
    if (this.useNormals && this.nrm.n / 3 === this.vertexCount) {
      g.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(this.nrm.view()), 3));
    } else {
      g.computeVertexNormals();
    }
    g.boundingBox = new THREE.Box3(
      new THREE.Vector3(this.minX, this.minY, this.minZ),
      new THREE.Vector3(this.maxX, this.maxY, this.maxZ),
    );
    g.boundingSphere = new THREE.Sphere();
    g.boundingBox.getBoundingSphere(g.boundingSphere);
    return g;
  }
}

function clamp255(v: number): number {
  return v < 0 ? 0 : v > 255 ? 255 : v | 0;
}
