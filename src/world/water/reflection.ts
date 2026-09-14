/**
 * Planar reflection pass.
 *
 * The scene is re-rendered from a camera mirrored through the water plane into
 * a reduced-resolution target, with Lengyel's oblique near-plane trick so the
 * frustum's near plane *is* the water plane — nothing under the harbour floor
 * can leak into the reflection, which is the usual give-away.
 *
 * Cost control, because a second pass over 63k buildings is not free:
 *  - the target runs at 0.3-0.5x of the backbuffer depending on tier,
 *  - shadow maps are switched off for the pass (their contribution to a
 *    blurred, Fresnel-weighted reflection is nearly invisible),
 *  - the far plane is pulled in to 9 km, past which aerial perspective has
 *    flattened everything to fog anyway,
 *  - the water itself is hidden so the pass cannot recurse.
 *
 * Mipmaps are generated on the target so the shader can pick a blur level
 * from surface roughness — a mirror-smooth Charles samples mip 0, a
 * wind-roughened outer harbour samples mip 3-4.
 */
import * as THREE from 'three';

export interface ReflectionOptions {
  /** Backbuffer fraction for the reflection target. */
  scale: number;
  /** Render every Nth frame; 1 = every frame. */
  interval: number;
  /** Reflections beyond this are fog. */
  far: number;
}

export class PlanarReflection {
  readonly target: THREE.WebGLRenderTarget;
  readonly textureMatrix = new THREE.Matrix4();
  /** Highest mip the shader may sample. */
  maxLod = 0;

  private camera = new THREE.PerspectiveCamera();
  private opts: ReflectionOptions;
  private frame = 0;
  private width = 2;
  private height = 2;

  // Scratch — allocating in the render loop is how you get GC hitches.
  private reflectorPos = new THREE.Vector3();
  private cameraPos = new THREE.Vector3();
  private normal = new THREE.Vector3(0, 1, 0);
  private view = new THREE.Vector3();
  private target3 = new THREE.Vector3();
  private lookAt = new THREE.Vector3();
  private rotation = new THREE.Matrix4();
  private clipPlane = new THREE.Vector4();
  private q = new THREE.Vector4();

  constructor(width: number, height: number, opts: ReflectionOptions) {
    this.opts = opts;
    this.target = new THREE.WebGLRenderTarget(2, 2, {
      type: THREE.HalfFloatType,
      format: THREE.RGBAFormat,
      minFilter: THREE.LinearMipmapLinearFilter,
      magFilter: THREE.LinearFilter,
      generateMipmaps: true,
      depthBuffer: true,
      stencilBuffer: false,
      samples: 0,
    });
    this.target.texture.colorSpace = THREE.NoColorSpace;
    this.target.texture.wrapS = THREE.ClampToEdgeWrapping;
    this.target.texture.wrapT = THREE.ClampToEdgeWrapping;
    this.resize(width, height);
  }

  setOptions(opts: Partial<ReflectionOptions>): void {
    Object.assign(this.opts, opts);
  }

  resize(width: number, height: number): void {
    const w = Math.max(64, Math.round(width * this.opts.scale));
    const h = Math.max(64, Math.round(height * this.opts.scale));
    if (w === this.width && h === this.height) return;
    this.width = w;
    this.height = h;
    this.target.setSize(w, h);
    this.maxLod = Math.max(0, Math.floor(Math.log2(Math.min(w, h))) - 2);
  }

  /** @returns true when the target was refreshed this frame. */
  render(
    renderer: THREE.WebGLRenderer,
    scene: THREE.Scene,
    camera: THREE.PerspectiveCamera,
    planeY: number,
    hide: THREE.Object3D,
  ): boolean {
    this.frame++;
    if (this.opts.interval > 1 && this.frame % this.opts.interval !== 0) return false;

    const virt = this.camera;
    this.reflectorPos.set(0, planeY, 0);
    this.cameraPos.setFromMatrixPosition(camera.matrixWorld);

    // Mirror the camera's position and its look-at target through the plane.
    this.view.subVectors(this.reflectorPos, this.cameraPos);
    this.view.reflect(this.normal).negate().add(this.reflectorPos);

    this.rotation.extractRotation(camera.matrixWorld);
    this.lookAt.set(0, 0, -1).applyMatrix4(this.rotation).add(this.cameraPos);
    this.target3.subVectors(this.reflectorPos, this.lookAt);
    this.target3.reflect(this.normal).negate().add(this.reflectorPos);

    virt.position.copy(this.view);
    virt.up.set(0, 1, 0).applyMatrix4(this.rotation).reflect(this.normal);
    virt.lookAt(this.target3);
    virt.near = camera.near;
    virt.far = Math.min(camera.far, this.opts.far);
    virt.fov = camera.fov;
    virt.aspect = camera.aspect;
    virt.layers.mask = camera.layers.mask;
    virt.updateMatrixWorld(true);
    virt.updateProjectionMatrix();

    // World -> reflection UV, built before the oblique hack (which only
    // rewrites the depth row, so the xy projection is identical either way).
    this.textureMatrix.set(
      0.5, 0.0, 0.0, 0.5,
      0.0, 0.5, 0.0, 0.5,
      0.0, 0.0, 0.5, 0.5,
      0.0, 0.0, 0.0, 1.0,
    );
    this.textureMatrix.multiply(virt.projectionMatrix);
    this.textureMatrix.multiply(virt.matrixWorldInverse);

    // Oblique near plane == the water plane (Lengyel 2005).
    this.clipPlane.set(this.normal.x, this.normal.y, this.normal.z, -planeY);
    this.clipPlane.applyMatrix4(virt.matrixWorldInverse.clone().transpose().invert());
    const p = virt.projectionMatrix.elements;
    this.q.x = (Math.sign(this.clipPlane.x) + p[8]) / p[0];
    this.q.y = (Math.sign(this.clipPlane.y) + p[9]) / p[5];
    this.q.z = -1.0;
    this.q.w = (1.0 + p[10]) / p[14];
    const c = this.clipPlane.multiplyScalar(2.0 / this.clipPlane.dot(this.q));
    p[2] = c.x;
    p[6] = c.y;
    p[10] = c.z + 1.0 - 1e-5;
    p[14] = c.w;

    const prevTarget = renderer.getRenderTarget();
    const prevShadows = renderer.shadowMap.enabled;
    const prevXR = renderer.xr.enabled;
    const wasVisible = hide.visible;

    hide.visible = false;
    renderer.shadowMap.enabled = false;
    renderer.xr.enabled = false;
    renderer.setRenderTarget(this.target);
    renderer.clear(true, true, false);
    renderer.render(scene, virt);
    renderer.setRenderTarget(prevTarget);

    hide.visible = wasVisible;
    renderer.shadowMap.enabled = prevShadows;
    renderer.xr.enabled = prevXR;
    return true;
  }

  dispose(): void {
    this.target.dispose();
  }
}
