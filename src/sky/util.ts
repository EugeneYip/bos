import * as THREE from 'three';

/**
 * Small helpers shared by the sky module: a state-preserving full-screen pass,
 * a GPU timer, and colour-science conversions.
 */

/** Clip-space triangle that covers the viewport with no wasted fragments. */
function fullScreenTriangle(): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array([-1, -1, 0, 3, -1, 0, -1, 3, 0]), 3));
  g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array([0, 0, 2, 0, 0, 2]), 2));
  g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 4);
  return g;
}

const TRIANGLE = fullScreenTriangle();

/** The vertex shader every offscreen pass in this module uses. */
export const PASS_VERT = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4( position.xy, 1.0, 1.0 );
}
`;

/**
 * Renders one shader over a render target. Reuses a single scene/camera/mesh so
 * the cost is one draw call; restores the renderer's target and autoClear so
 * callers never have to think about it.
 */
export class FullScreenPass {
  readonly mesh: THREE.Mesh;
  private static scene: THREE.Scene | null = null;
  private static camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

  constructor(readonly material: THREE.RawShaderMaterial | THREE.ShaderMaterial) {
    material.depthTest = false;
    material.depthWrite = false;
    this.mesh = new THREE.Mesh(TRIANGLE, material);
    this.mesh.frustumCulled = false;
  }

  /**
   * @param layer for 3D / array render targets, the slice to write. Ignored
   *   for ordinary 2D targets.
   */
  render(renderer: THREE.WebGLRenderer, target: THREE.WebGLRenderTarget | null, layer = 0): void {
    if (!FullScreenPass.scene) FullScreenPass.scene = new THREE.Scene();
    const scene = FullScreenPass.scene;
    scene.children.length = 0;
    scene.add(this.mesh);

    const prevTarget = renderer.getRenderTarget();
    const prevAuto = renderer.autoClear;
    const prevXr = renderer.xr.enabled;
    renderer.xr.enabled = false;
    renderer.autoClear = false;
    renderer.setRenderTarget(target, layer);
    renderer.render(scene, FullScreenPass.camera);
    renderer.setRenderTarget(prevTarget);
    renderer.autoClear = prevAuto;
    renderer.xr.enabled = prevXr;
  }

  dispose(): void {
    this.material.dispose();
  }
}

/**
 * Wraps `EXT_disjoint_timer_query_webgl2` so the module can report honest
 * GPU costs instead of guessing from frame time. Degrades to NaN when the
 * extension is absent (Safari, and Chrome without the flag).
 */
export class GpuTimer {
  private ext: {
    TIME_ELAPSED_EXT: number;
    GPU_DISJOINT_EXT: number;
  } | null = null;
  private gl: WebGL2RenderingContext;
  private pending: Array<{ query: WebGLQuery; slot: string }> = [];
  private active = false;
  /** Exponential moving average of each measured slot, milliseconds. */
  readonly ms: Record<string, number> = {};

  constructor(renderer: THREE.WebGLRenderer) {
    this.gl = renderer.getContext() as WebGL2RenderingContext;
    this.ext = this.gl.getExtension('EXT_disjoint_timer_query_webgl2');
  }

  get available(): boolean {
    return this.ext !== null;
  }

  begin(slot: string): void {
    if (!this.ext || this.active) return;
    const query = this.gl.createQuery();
    if (!query) return;
    this.gl.beginQuery(this.ext.TIME_ELAPSED_EXT, query);
    this.pending.push({ query, slot });
    this.active = true;
  }

  end(): void {
    if (!this.ext || !this.active) return;
    this.gl.endQuery(this.ext.TIME_ELAPSED_EXT);
    this.active = false;
  }

  /** Drains finished queries. Call once per frame. */
  poll(): void {
    if (!this.ext) return;
    const gl = this.gl;
    const disjoint = gl.getParameter(this.ext.GPU_DISJOINT_EXT);
    for (let i = this.pending.length - 1; i >= 0; i--) {
      const { query, slot } = this.pending[i];
      if (!gl.getQueryParameter(query, gl.QUERY_RESULT_AVAILABLE)) continue;
      if (!disjoint) {
        const ns = gl.getQueryParameter(query, gl.QUERY_RESULT) as number;
        const ms = ns / 1e6;
        this.ms[slot] = this.ms[slot] === undefined ? ms : this.ms[slot] * 0.9 + ms * 0.1;
      }
      gl.deleteQuery(query);
      this.pending.splice(i, 1);
    }
    if (this.pending.length > 32) {
      for (const p of this.pending) gl.deleteQuery(p.query);
      this.pending.length = 0;
    }
  }
}

/**
 * Planckian locus to linear sRGB, normalised so the result has luminance 1.
 * Used for star colours (from B-V) and for the warm/cool ends of the key light.
 *
 * Uses the standard CIE D-illuminant-style cubic fits for chromaticity, then
 * xyY -> XYZ -> linear Rec.709.
 */
export function blackbodyToLinearRGB(kelvin: number, out = new THREE.Color()): THREE.Color {
  const t = Math.max(1000, Math.min(25000, kelvin));
  // k = 1000/T, so k^3 == 1e9/T^3, k^2 == 1e6/T^2, k == 1e3/T.
  const k = 1000 / t;
  const x =
    t <= 4000
      ? -0.2661239 * k * k * k - 0.2343589 * k * k + 0.8776956 * k + 0.17991
      : -3.0258469 * k * k * k + 2.1070379 * k * k + 0.2226347 * k + 0.24039;
  let y: number;
  if (t <= 2222) y = -1.1063814 * x * x * x - 1.34811020 * x * x + 2.18555832 * x - 0.20219683;
  else if (t <= 4000) y = -0.9549476 * x * x * x - 1.37418593 * x * x + 2.09137015 * x - 0.16748867;
  else y = 3.0817580 * x * x * x - 5.87338670 * x * x + 3.75112997 * x - 0.37001483;

  const yy = 1.0;
  const xx = (x / y) * yy;
  const zz = ((1 - x - y) / y) * yy;
  let r = 3.2404542 * xx - 1.5371385 * yy - 0.4985314 * zz;
  let g = -0.969266 * xx + 1.8760108 * yy + 0.041556 * zz;
  let b = 0.0556434 * xx - 0.2040259 * yy + 1.0572252 * zz;
  r = Math.max(0, r);
  g = Math.max(0, g);
  b = Math.max(0, b);
  const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  const s = lum > 1e-5 ? 1 / lum : 1;
  return out.setRGB(r * s, g * s, b * s, THREE.LinearSRGBColorSpace);
}

/** Ballesteros' B-V to effective temperature relation. */
export function bvToKelvin(bv: number): number {
  const b = Math.max(-0.4, Math.min(2.2, bv));
  return 4600 * (1 / (0.92 * b + 1.7) + 1 / (0.92 * b + 0.62));
}

/** Smooth Hermite interpolation matching GLSL's `smoothstep`. */
export function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = Math.max(0, Math.min(1, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

export function clamp(x: number, lo: number, hi: number): number {
  return x < lo ? lo : x > hi ? hi : x;
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/**
 * Frame-rate independent exponential approach: moves `current` toward `target`
 * so that a fixed fraction of the remaining gap is closed per second.
 */
export function damp(current: number, target: number, lambda: number, dt: number): number {
  return lerp(current, target, 1 - Math.exp(-lambda * dt));
}
