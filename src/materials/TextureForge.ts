import * as THREE from 'three';
import type { TextureSet } from '../core/Context';
import { COMMON_GLSL } from './shaders/common';
import { FULLSCREEN_VERT, OUTPUT_MAIN, SOBEL_FRAG } from './shaders/passes';

export interface BakeSpec {
  /** GLSL body providing `void bosShade(vec2 uv, inout BosSurface s)`. */
  fragment: string;
  /** Extra uniforms consumed by the family shader. */
  uniforms?: Record<string, THREE.IUniform>;
  /** Albedo/normal resolution in texels (power of two). */
  res: number;
  /** World metres covered by one UV tile. */
  tileMeters: number;
  /** Divisor for the ORM map. 2 halves its memory for no visible loss. */
  ormDiv?: number;
  /** Multiplier on the Sobel gradient. 1 = physically derived. */
  normalStrength?: number;
  /** Skip the ORM pack (surfaces that only need albedo + normal). */
  noOrm?: boolean;
  anisotropy: number;
}

export interface BakedSet extends TextureSet {
  bytes: number;
  targets: THREE.WebGLRenderTarget[];
}

const SHARED_UNIFORM_NAMES = ['uOutput', 'uSuper', 'uTexel'];

/**
 * GPU texture bakery.
 *
 * Every family is rendered with full-screen passes into render targets, which is
 * one to two orders of magnitude faster than CPU canvas loops and lets us afford
 * 2048² hero maps. The normal map is always a Sobel derivative of the *same*
 * height field the shader authored — never an approximation from the albedo.
 */
export class TextureForge {
  private quadScene = new THREE.Scene();
  private quadCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private quad: THREE.Mesh;
  private sobelMat: THREE.RawShaderMaterial;
  private heightRT: THREE.WebGLRenderTarget | null = null;
  private heightRes = 0;
  private matCache = new Map<string, THREE.RawShaderMaterial>();

  constructor(private renderer: THREE.WebGLRenderer) {
    const geo = new THREE.PlaneGeometry(2, 2);
    this.quad = new THREE.Mesh(geo, new THREE.MeshBasicMaterial());
    this.quad.frustumCulled = false;
    this.quadScene.add(this.quad);

    this.sobelMat = new THREE.RawShaderMaterial({
      vertexShader: FULLSCREEN_VERT,
      fragmentShader: SOBEL_FRAG,
      uniforms: {
        uHeight: { value: null },
        uTexel: { value: new THREE.Vector2() },
        uMetersPerTexel: { value: 1 },
        uStrength: { value: 1 },
      },
      depthTest: false,
      depthWrite: false,
    });
  }

  /** Bytes a texture of this size occupies including the full mip chain. */
  private static cost(res: number): number {
    return Math.round(res * res * 4 * 1.3334);
  }

  private colorTarget(res: number, srgb: boolean, aniso: number): THREE.WebGLRenderTarget {
    const rt = new THREE.WebGLRenderTarget(res, res, {
      format: THREE.RGBAFormat,
      type: THREE.UnsignedByteType,
      colorSpace: srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace,
      minFilter: THREE.LinearMipmapLinearFilter,
      magFilter: THREE.LinearFilter,
      wrapS: THREE.RepeatWrapping,
      wrapT: THREE.RepeatWrapping,
      generateMipmaps: true,
      depthBuffer: false,
      stencilBuffer: false,
    });
    rt.texture.anisotropy = aniso;
    return rt;
  }

  private ensureHeight(res: number): THREE.WebGLRenderTarget {
    if (this.heightRT && this.heightRes === res) return this.heightRT;
    this.heightRT?.dispose();
    this.heightRes = res;
    this.heightRT = new THREE.WebGLRenderTarget(res, res, {
      format: THREE.RGBAFormat,
      type: THREE.HalfFloatType,
      colorSpace: THREE.NoColorSpace,
      minFilter: THREE.NearestFilter,
      magFilter: THREE.NearestFilter,
      wrapS: THREE.RepeatWrapping,
      wrapT: THREE.RepeatWrapping,
      generateMipmaps: false,
      depthBuffer: false,
      stencilBuffer: false,
    });
    return this.heightRT;
  }

  private material(spec: BakeSpec): THREE.RawShaderMaterial {
    const src = `${COMMON_GLSL}\n${spec.fragment}\n${OUTPUT_MAIN}`;
    const key = src;
    let mat = this.matCache.get(key);
    if (!mat) {
      mat = new THREE.RawShaderMaterial({
        vertexShader: FULLSCREEN_VERT,
        fragmentShader: src,
        uniforms: {
          uOutput: { value: 0 },
          uSuper: { value: 0 },
          uTexel: { value: new THREE.Vector2() },
        },
        depthTest: false,
        depthWrite: false,
      });
      this.matCache.set(key, mat);
    }
    // Families that share a shader differ only in uniforms; rebind them each bake.
    for (const name of Object.keys(mat.uniforms)) {
      if (!SHARED_UNIFORM_NAMES.includes(name) && !(spec.uniforms && name in spec.uniforms)) {
        delete mat.uniforms[name];
      }
    }
    if (spec.uniforms) for (const [k, v] of Object.entries(spec.uniforms)) mat.uniforms[k] = v;
    return mat;
  }

  private draw(mat: THREE.Material, rt: THREE.WebGLRenderTarget): void {
    this.quad.material = mat;
    this.renderer.setRenderTarget(rt);
    this.renderer.render(this.quadScene, this.quadCam);
  }

  /** Bakes one surface family. Synchronous — the GPU work is fire-and-forget. */
  bake(spec: BakeSpec): BakedSet {
    const prev = this.renderer.getRenderTarget();
    const res = spec.res;
    const ormRes = Math.max(64, Math.floor(res / (spec.ormDiv ?? 2)));
    const mat = this.material(spec);
    const texel = mat.uniforms.uTexel.value as THREE.Vector2;

    const albedoRT = this.colorTarget(res, true, spec.anisotropy);
    let bytes = TextureForge.cost(res);

    // ---- albedo -------------------------------------------------------------
    mat.uniforms.uOutput.value = 0;
    mat.uniforms.uSuper.value = 0;
    texel.set(1 / res, 1 / res);
    this.draw(mat, albedoRT);

    // ---- height (scratch, half float) --------------------------------------
    const heightRT = this.ensureHeight(res);
    mat.uniforms.uOutput.value = 1;
    this.draw(mat, heightRT);

    // ---- normal from height -------------------------------------------------
    const normalRT = this.colorTarget(res, false, spec.anisotropy);
    bytes += TextureForge.cost(res);
    this.sobelMat.uniforms.uHeight.value = heightRT.texture;
    (this.sobelMat.uniforms.uTexel.value as THREE.Vector2).set(1 / res, 1 / res);
    this.sobelMat.uniforms.uMetersPerTexel.value = spec.tileMeters / res;
    this.sobelMat.uniforms.uStrength.value = spec.normalStrength ?? 1;
    this.draw(this.sobelMat, normalRT);

    // ---- AO / roughness / metalness pack ------------------------------------
    let ormRT: THREE.WebGLRenderTarget | null = null;
    if (!spec.noOrm) {
      ormRT = this.colorTarget(ormRes, false, spec.anisotropy);
      bytes += TextureForge.cost(ormRes);
      mat.uniforms.uOutput.value = 2;
      mat.uniforms.uSuper.value = 1;
      texel.set(1 / ormRes, 1 / ormRes);
      this.draw(mat, ormRT);
      mat.uniforms.uSuper.value = 0;
    }

    this.renderer.setRenderTarget(prev);

    const targets = [albedoRT, normalRT];
    if (ormRT) targets.push(ormRT);

    const set: BakedSet = {
      map: albedoRT.texture,
      normalMap: normalRT.texture,
      roughnessMap: ormRT?.texture,
      metalnessMap: ormRT?.texture,
      aoMap: ormRT?.texture,
      tileMeters: spec.tileMeters,
      bytes,
      targets,
    };
    set.map.name = 'albedo';
    set.normalMap!.name = 'normal';
    if (ormRT) ormRT.texture.name = 'orm';
    return set;
  }

  /** Frees the scratch height target; safe to call between batches. */
  releaseScratch(): void {
    this.heightRT?.dispose();
    this.heightRT = null;
    this.heightRes = 0;
  }

  dispose(): void {
    this.releaseScratch();
    for (const m of this.matCache.values()) m.dispose();
    this.matCache.clear();
    this.sobelMat.dispose();
    this.quad.geometry.dispose();
  }
}
