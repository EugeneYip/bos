import * as THREE from 'three';

export interface RTOptions {
  type?: THREE.TextureDataType;
  format?: THREE.PixelFormat;
  filter?: THREE.MagnificationTextureFilter;
  depth?: boolean;
  depthType?: THREE.TextureDataType;
  wrap?: THREE.Wrapping;
  name?: string;
}

/**
 * Creates an off-screen target with sane post-processing defaults: no mipmaps,
 * clamped, linear-filtered, and colour-space `NoColorSpace` so nothing is
 * silently sRGB-encoded on the way in or out. Everything upstream of the final
 * grade pass stays in linear HDR.
 */
export function makeRT(w: number, h: number, o: RTOptions = {}): THREE.WebGLRenderTarget {
  const rt = new THREE.WebGLRenderTarget(Math.max(1, w), Math.max(1, h), {
    type: o.type ?? THREE.HalfFloatType,
    format: o.format ?? THREE.RGBAFormat,
    minFilter: (o.filter ?? THREE.LinearFilter) as THREE.MinificationTextureFilter,
    magFilter: o.filter ?? THREE.LinearFilter,
    wrapS: o.wrap ?? THREE.ClampToEdgeWrapping,
    wrapT: o.wrap ?? THREE.ClampToEdgeWrapping,
    depthBuffer: o.depth ?? false,
    stencilBuffer: false,
    generateMipmaps: false,
    colorSpace: THREE.NoColorSpace,
  });
  rt.texture.name = o.name ?? 'post.rt';
  if (o.depth) {
    // 32-bit float depth: the city spans 26 km with a 0.35 m near plane, and
    // AO/SSR/TAA all reconstruct view positions from this buffer.
    const dt = new THREE.DepthTexture(Math.max(1, w), Math.max(1, h), o.depthType ?? THREE.FloatType);
    dt.format = THREE.DepthFormat;
    dt.minFilter = THREE.NearestFilter;
    dt.magFilter = THREE.NearestFilter;
    dt.generateMipmaps = false;
    rt.depthTexture = dt;
  }
  return rt;
}

export function disposeRT(rt: THREE.WebGLRenderTarget | null | undefined): void {
  if (!rt) return;
  rt.depthTexture?.dispose();
  rt.dispose();
}

/** Two targets swapped every frame (TAA history, exposure adaptation, ...). */
export class PingPong {
  private a: THREE.WebGLRenderTarget;
  private b: THREE.WebGLRenderTarget;
  private flipped = false;

  constructor(w: number, h: number, opts: RTOptions = {}) {
    this.a = makeRT(w, h, { ...opts, name: `${opts.name ?? 'pp'}.a` });
    this.b = makeRT(w, h, { ...opts, name: `${opts.name ?? 'pp'}.b` });
  }

  get read(): THREE.WebGLRenderTarget { return this.flipped ? this.b : this.a; }
  get write(): THREE.WebGLRenderTarget { return this.flipped ? this.a : this.b; }
  swap(): void { this.flipped = !this.flipped; }

  setSize(w: number, h: number): void {
    this.a.setSize(Math.max(1, w), Math.max(1, h));
    this.b.setSize(Math.max(1, w), Math.max(1, h));
  }

  /** Clear both halves; used after a resize so the history is not garbage. */
  clear(renderer: THREE.WebGLRenderer, color = new THREE.Color(0, 0, 0)): void {
    const prev = renderer.getRenderTarget();
    const pc = new THREE.Color();
    renderer.getClearColor(pc);
    const pa = renderer.getClearAlpha();
    renderer.setClearColor(color, 1);
    for (const rt of [this.a, this.b]) {
      renderer.setRenderTarget(rt);
      renderer.clear(true, false, false);
    }
    renderer.setClearColor(pc, pa);
    renderer.setRenderTarget(prev);
  }

  dispose(): void { disposeRT(this.a); disposeRT(this.b); }
}

/**
 * Small keyed pool of scratch targets so the chain does not allocate a fresh
 * full-res RGBA16F buffer for every intermediate step. Targets are handed out
 * for the duration of a frame and recycled on the next one.
 */
export class RTPool {
  private free = new Map<string, THREE.WebGLRenderTarget[]>();
  private live: Array<{ key: string; rt: THREE.WebGLRenderTarget }> = [];

  private static key(w: number, h: number, o: RTOptions): string {
    return `${w}x${h}:${o.type ?? THREE.HalfFloatType}:${o.format ?? THREE.RGBAFormat}:${o.filter ?? THREE.LinearFilter}`;
  }

  acquire(w: number, h: number, o: RTOptions = {}): THREE.WebGLRenderTarget {
    w = Math.max(1, Math.round(w));
    h = Math.max(1, Math.round(h));
    const key = RTPool.key(w, h, o);
    const bucket = this.free.get(key);
    let rt = bucket?.pop();
    if (!rt) rt = makeRT(w, h, { ...o, name: `pool.${key}` });
    this.live.push({ key, rt });
    return rt;
  }

  /** Call once per frame after presenting. */
  recycle(): void {
    for (const { key, rt } of this.live) {
      const bucket = this.free.get(key);
      if (bucket) bucket.push(rt);
      else this.free.set(key, [rt]);
    }
    this.live.length = 0;
  }

  dispose(): void {
    for (const bucket of this.free.values()) for (const rt of bucket) disposeRT(rt);
    for (const { rt } of this.live) disposeRT(rt);
    this.free.clear();
    this.live.length = 0;
  }

  get bytes(): number {
    let n = 0;
    const size = (rt: THREE.WebGLRenderTarget): number => {
      const bpp = rt.texture.type === THREE.HalfFloatType ? 8 : rt.texture.type === THREE.FloatType ? 16 : 4;
      return rt.width * rt.height * bpp;
    };
    for (const bucket of this.free.values()) for (const rt of bucket) n += size(rt);
    for (const { rt } of this.live) n += size(rt);
    return n;
  }
}
