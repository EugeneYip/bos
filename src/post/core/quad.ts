import * as THREE from 'three';

/**
 * A single full-screen triangle (not a quad): one primitive, no diagonal seam,
 * perfect quad utilisation on the raster. Shared by every post pass.
 *
 * The vertex shader bypasses the matrix stack entirely, so passes only ever pay
 * for their fragment work.
 */
const TRI_VERT = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

let sharedGeometry: THREE.BufferGeometry | null = null;

function geometry(): THREE.BufferGeometry {
  if (sharedGeometry) return sharedGeometry;
  const g = new THREE.BufferGeometry();
  // Clip-space triangle covering [-1,1]^2 with UVs in [0,2].
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array([-1, -1, 0, 3, -1, 0, -1, 3, 0]), 3));
  g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array([0, 0, 2, 0, 0, 2]), 2));
  g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 4);
  sharedGeometry = g;
  return g;
}

export type Uniforms = Record<string, THREE.IUniform>;

/** A compiled full-screen fragment program plus its uniform block. */
export class Pass<U extends Uniforms = Uniforms> {
  readonly material: THREE.RawShaderMaterial | THREE.ShaderMaterial;
  readonly uniforms: U;
  private readonly mesh: THREE.Mesh;
  private readonly scene = new THREE.Scene();
  private static camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

  constructor(name: string, fragmentShader: string, uniforms: U, defines: Record<string, string | number> = {}) {
    this.uniforms = uniforms;
    this.material = new THREE.ShaderMaterial({
      name,
      vertexShader: TRI_VERT,
      fragmentShader,
      uniforms: uniforms as Uniforms,
      defines: { ...defines },
      depthTest: false,
      depthWrite: false,
      // We own the tonemap and the colour-space write ourselves.
      toneMapped: false,
      transparent: false,
      blending: THREE.NoBlending,
    });
    this.mesh = new THREE.Mesh(geometry(), this.material);
    this.mesh.frustumCulled = false;
    this.mesh.matrixAutoUpdate = false;
    this.scene.add(this.mesh);
  }

  /** Recompile with a changed define (e.g. sample count). */
  setDefine(key: string, value: string | number | undefined): void {
    const d = this.material.defines as Record<string, string | number> | undefined;
    if (!d) return;
    const cur = d[key];
    if (value === undefined) {
      if (cur === undefined) return;
      delete d[key];
    } else {
      if (cur === value) return;
      d[key] = value;
    }
    this.material.needsUpdate = true;
  }

  setBlending(mode: THREE.Blending, src?: THREE.BlendingSrcFactor, dst?: THREE.BlendingDstFactor): void {
    this.material.blending = mode;
    if (src !== undefined) {
      this.material.blendSrc = src;
      this.material.blendEquation = THREE.AddEquation;
    }
    if (dst !== undefined) this.material.blendDst = dst;
    this.material.transparent = mode !== THREE.NoBlending;
  }

  render(renderer: THREE.WebGLRenderer, target: THREE.WebGLRenderTarget | null): void {
    renderer.setRenderTarget(target);
    renderer.render(this.scene, Pass.camera);
  }

  dispose(): void {
    this.material.dispose();
  }
}

/** Shorthand for the very common `{ value }` wrapper. */
export const u = <T>(value: T): { value: T } => ({ value });
