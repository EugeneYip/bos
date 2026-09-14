import * as THREE from 'three';

/**
 * Cascaded shadow maps for the key light.
 *
 * three.js has no CSM in core, and the `examples/jsm/csm` add-on needs every
 * material registered by hand, which would mean reaching into other modules.
 * This is a self-contained implementation instead:
 *
 *   - N `DirectionalLight`s share one direction and one colour, so three's own
 *     shadow pipeline renders the N depth maps and supplies the N shadow
 *     matrices. No custom depth pass, no hand-registered materials.
 *   - Splits use the practical scheme (Zhang et al.): a blend of the
 *     logarithmic and uniform distributions, so the near cascade is tight
 *     enough for contact shadows and the far one still reaches the skyline.
 *   - Each cascade is fitted to the *bounding sphere* of its view-frustum
 *     slice, which keeps the ortho extent constant as the camera turns, and
 *     the sphere centre is snapped to whole shadow texels, which is what stops
 *     shadow edges crawling when the camera moves.
 *   - Cascade selection and blending happen in a patched
 *     `lights_fragment_begin` (see `SceneShading.ts`): each cascade's weight
 *     comes from how far inside its own shadow-map rectangle the fragment
 *     sits, so the transition is a gradient, not a seam.
 *
 * Because every cascade light carries the full sun colour and the weights sum
 * to one, the scene receives exactly one sun's worth of light.
 */

const WORLD_UP = new THREE.Vector3(0, 1, 0);
const POLAR_UP = new THREE.Vector3(0, 0, 1);

export interface CascadedShadowOptions {
  cascades: number;
  mapSize: number;
  /** Furthest distance from the camera that receives shadows, metres. */
  distance: number;
  /** 0 = uniform splits, 1 = logarithmic. */
  lambda?: number;
  /** Head- and foot-room along the light axis, metres. */
  zMargin?: number;
}

export class CascadedShadows {
  readonly group = new THREE.Group();
  readonly lights: THREE.DirectionalLight[] = [];

  /** Far distance of each cascade, metres from the camera. */
  readonly splits: number[] = [];
  /** Fitted radius of each cascade, metres. */
  readonly radii: number[] = [];
  /** World size of one shadow texel in each cascade, metres. */
  readonly texels: number[] = [];

  private direction = new THREE.Vector3(0, 1, 0);
  private lambda: number;
  private zMargin: number;
  private mapSize: number;
  private distance: number;
  private near = 1;
  private enabled = true;

  private readonly corners: THREE.Vector3[] = [];
  private readonly centre = new THREE.Vector3();
  private readonly lightToWorld = new THREE.Matrix4();
  private readonly worldToLight = new THREE.Matrix4();
  private readonly scratch = new THREE.Vector3();

  constructor(opts: CascadedShadowOptions) {
    this.lambda = opts.lambda ?? 0.72;
    this.zMargin = opts.zMargin ?? 3200;
    this.mapSize = opts.mapSize;
    this.distance = opts.distance;
    this.group.name = 'sky-cascades';
    this.group.matrixAutoUpdate = false;
    for (let i = 0; i < 8; i++) this.corners.push(new THREE.Vector3());
    this.build(Math.max(1, opts.cascades));
  }

  get cascadeCount(): number {
    return this.lights.length;
  }

  private build(count: number): void {
    this.destroyLights();
    for (let i = 0; i < count; i++) {
      const light = new THREE.DirectionalLight(0xffffff, 1);
      light.name = `sky-cascade-${i}`;
      light.castShadow = true;
      light.shadow.mapSize.set(this.mapSize, this.mapSize);
      // Cascade 0 is tiny, cascade N covers kilometres; a single bias value
      // cannot serve both, so it is recomputed from the texel size each frame.
      light.shadow.bias = 0;
      light.shadow.normalBias = 0.02;
      light.shadow.camera.up.copy(WORLD_UP);
      light.matrixAutoUpdate = false;
      light.target.matrixAutoUpdate = false;
      this.group.add(light, light.target);
      this.lights.push(light);
      this.splits.push(0);
      this.radii.push(0);
      this.texels.push(0);
    }
  }

  private destroyLights(): void {
    for (const l of this.lights) {
      l.shadow.dispose();
      this.group.remove(l, l.target);
    }
    this.lights.length = 0;
    this.splits.length = 0;
    this.radii.length = 0;
    this.texels.length = 0;
  }

  /** Rebuilds if the cascade count or map size changed. Recompiles shaders. */
  configure(cascades: number, mapSize: number, distance: number): boolean {
    this.distance = distance;
    if (cascades === this.lights.length && mapSize === this.mapSize) return false;
    this.mapSize = mapSize;
    this.build(Math.max(1, cascades));
    return true;
  }

  /** Direction *toward* the light, unit length. */
  setDirection(dir: THREE.Vector3): void {
    this.direction.copy(dir).normalize();
  }

  setLight(color: THREE.Color, intensity: number): void {
    // Below a sliver of light the cascades are invisible, so stop paying for
    // four depth passes. The maps go stale rather than being torn down, which
    // avoids a shader recompile every dusk.
    const on = intensity > 0.004;
    if (on !== this.enabled) {
      this.enabled = on;
      for (const l of this.lights) l.shadow.autoUpdate = on;
    }
    for (const l of this.lights) {
      l.color.copy(color);
      l.intensity = intensity;
    }
  }

  /**
   * Refits every cascade to the camera. Call once per frame, after the camera
   * has its final pose for this frame.
   */
  update(camera: THREE.PerspectiveCamera): void {
    const count = this.lights.length;
    if (count === 0) return;

    const near = this.near;
    const far = Math.max(near + 1, this.distance);
    const up = Math.abs(this.direction.y) > 0.999 ? POLAR_UP : WORLD_UP;

    // Light-space basis, shared by every cascade so the texel grid is common.
    this.lightToWorld.lookAt(this.direction, new THREE.Vector3(), up);
    this.worldToLight.copy(this.lightToWorld).transpose();

    const tanV = Math.tan(THREE.MathUtils.degToRad(camera.fov * 0.5));
    const tanH = tanV * camera.aspect;

    camera.updateMatrixWorld();

    let sliceNear = near;
    for (let i = 0; i < count; i++) {
      const p = (i + 1) / count;
      const logSplit = near * Math.pow(far / near, p);
      const uniSplit = near + (far - near) * p;
      const sliceFar = this.lambda * logSplit + (1 - this.lambda) * uniSplit;
      this.splits[i] = sliceFar;

      // Eight corners of this frustum slice, in view space then world space.
      let c = 0;
      for (const d of [sliceNear, sliceFar]) {
        const x = d * tanH;
        const y = d * tanV;
        for (const sy of [-1, 1]) {
          for (const sx of [-1, 1]) {
            this.corners[c++].set(sx * x, sy * y, -d).applyMatrix4(camera.matrixWorld);
          }
        }
      }

      // Bounding sphere of the slice. The radius is invariant under camera
      // rotation, which is precisely why shadow texel density stays constant.
      this.centre.set(0, 0, 0);
      for (const v of this.corners) this.centre.add(v);
      this.centre.multiplyScalar(1 / 8);
      let radius = 0;
      for (const v of this.corners) radius = Math.max(radius, this.centre.distanceTo(v));
      radius = Math.ceil(radius * 16) / 16;
      this.radii[i] = radius;

      const texel = (2 * radius) / this.mapSize;
      this.texels[i] = texel;

      // Snap the centre to the light-space texel grid.
      this.scratch.copy(this.centre).applyMatrix4(this.worldToLight);
      this.scratch.x = Math.floor(this.scratch.x / texel) * texel;
      this.scratch.y = Math.floor(this.scratch.y / texel) * texel;
      this.scratch.applyMatrix4(this.lightToWorld);

      const light = this.lights[i];
      const back = radius + this.zMargin;
      light.position.copy(this.scratch).addScaledVector(this.direction, back);
      light.target.position.copy(this.scratch);
      light.updateMatrix();
      light.updateMatrixWorld(true);
      light.target.updateMatrix();
      light.target.updateMatrixWorld(true);

      const cam = light.shadow.camera;
      cam.up.copy(up);
      cam.left = -radius;
      cam.right = radius;
      cam.top = radius;
      cam.bottom = -radius;
      cam.near = 1;
      cam.far = back + radius + this.zMargin;
      cam.updateProjectionMatrix();

      // Depth bias, expressed in metres and converted into the cascade's own
      // normalised depth range, so cascade 0 is not over-biased into
      // peter-panning and cascade 3 is not under-biased into acne.
      const depthRange = cam.far - cam.near;
      light.shadow.bias = -Math.max(0.02, texel * 0.75) / depthRange;
      light.shadow.normalBias = Math.max(0.03, texel * 1.35);

      sliceNear = sliceFar * 0.96; // slight overlap so the blend band has data
    }
  }

  dispose(): void {
    this.destroyLights();
    this.group.removeFromParent();
  }
}
