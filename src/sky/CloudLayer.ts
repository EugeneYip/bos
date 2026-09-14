import * as THREE from 'three';
import { FullScreenPass, PASS_VERT } from './util';
import { buildCloudVolumes, type CloudVolumes } from './CloudNoise';
import {
  CLOUD_BILLBOARD_FRAG,
  CLOUD_SHADOW_FRAG,
  CLOUD_VOLUMETRIC_FRAG,
} from './shaders/clouds';
import type { AtmosphereUniforms } from './AtmosphereLuts';
import type { WeatherState } from './weather';

/**
 * Drives the cloud passes and owns their buffers.
 *
 * Three products come out of here every frame:
 *
 *   1. `scatterTexture` — RGBA16F at a fraction of the main resolution. RGB is
 *      in-scattered radiance already faded by aerial perspective, A is
 *      transmittance. The sky dome composites it with one multiply-add, and
 *      the starfield multiplies by A so clouds occlude stars.
 *   2. `shadowTexture` — a 256x256 top-down map of how much sunlight survives
 *      the deck, centred on the camera. Injected into every lit material by
 *      `SceneShading`, which is what makes cloud shadows crawl over the city.
 *   3. `sunOcclusion` — the same idea, sampled once at the camera, used to dim
 *      the key light and the IBL.
 *
 * On the `low` tier the raymarch is swapped for an analytic billboard layer
 * with a three-tap self-shadow; it is about a tenth of the cost and still has
 * a lit side and a shaded side.
 */

/** Multiplies the single-scatter source term up to a plausible cloud albedo. */
const SUN_GAIN = 5.5;

export interface CloudSettings {
  /** 0 disables clouds entirely. */
  steps: number;
  volumetric: boolean;
  /** Fraction of the main framebuffer the scatter pass runs at. */
  scale: number;
  shadows: boolean;
}

export class CloudLayer {
  private volumes: CloudVolumes | null = null;
  private scatter: THREE.WebGLRenderTarget | null = null;
  private shadow: THREE.WebGLRenderTarget | null = null;

  private volumetricPass: FullScreenPass | null = null;
  private billboardPass: FullScreenPass | null = null;
  private shadowPass: FullScreenPass | null = null;

  private width = 1;
  private height = 1;
  private scale = 0.5;
  private mode: 'off' | 'volumetric' | 'billboard' = 'off';
  private drift = new THREE.Vector2();
  private frame = 0;

  /** Metres of the world covered by the cloud shadow map. */
  shadowExtent = 9000;
  readonly shadowCentre = new THREE.Vector2();
  buildMs = 0;

  constructor(private renderer: THREE.WebGLRenderer, private atmos: AtmosphereUniforms) {}

  get scatterTexture(): THREE.Texture | null {
    return this.mode === 'off' ? null : this.scatter?.texture ?? null;
  }

  get shadowTexture(): THREE.Texture | null {
    return this.shadow?.texture ?? null;
  }

  get active(): boolean {
    return this.mode !== 'off';
  }

  get technique(): string {
    return this.mode;
  }

  /** (Re)builds passes and buffers for a quality tier. */
  configure(settings: CloudSettings, width: number, height: number): void {
    this.width = width;
    this.height = height;
    this.scale = settings.scale;

    const want: 'off' | 'volumetric' | 'billboard' =
      settings.steps <= 0 ? 'off' : settings.volumetric ? 'volumetric' : 'billboard';

    if (want === 'volumetric' && !this.volumes) {
      this.volumes = buildCloudVolumes(this.renderer, 96, 32);
      this.buildMs = this.volumes.buildMs;
    }

    this.mode = want;
    if (want === 'off') {
      this.disposeTargets();
      return;
    }

    const w = Math.max(64, Math.round(width * this.scale));
    const h = Math.max(64, Math.round(height * this.scale));
    if (!this.scatter || this.scatter.width !== w || this.scatter.height !== h) {
      this.scatter?.dispose();
      this.scatter = new THREE.WebGLRenderTarget(w, h, {
        type: THREE.HalfFloatType,
        format: THREE.RGBAFormat,
        minFilter: THREE.LinearFilter,
        magFilter: THREE.LinearFilter,
        depthBuffer: false,
        stencilBuffer: false,
        generateMipmaps: false,
      });
      this.scatter.texture.colorSpace = THREE.NoColorSpace;
    }

    if (settings.shadows && want === 'volumetric' && !this.shadow) {
      this.shadow = new THREE.WebGLRenderTarget(256, 256, {
        type: THREE.UnsignedByteType,
        format: THREE.RGBAFormat,
        minFilter: THREE.LinearFilter,
        magFilter: THREE.LinearFilter,
        depthBuffer: false,
        stencilBuffer: false,
        generateMipmaps: false,
      });
      this.shadow.texture.colorSpace = THREE.NoColorSpace;
    }

    if (want === 'volumetric' && !this.volumetricPass) this.volumetricPass = this.makeVolumetric();
    if (want === 'billboard' && !this.billboardPass) this.billboardPass = this.makeBillboard();
    if (this.shadow && !this.shadowPass) this.shadowPass = this.makeShadow();

    const u = this.activeUniforms();
    if (u) (u.uSteps.value as number) = settings.steps;
  }

  private fieldUniforms(): Record<string, THREE.IUniform> {
    return {
      uShapeTex: { value: this.volumes?.shape ?? null },
      uDetailTex: { value: this.volumes?.detail ?? null },
      uCloudBottom: { value: 1750 },
      uCloudTop: { value: 3000 },
      uCoverage: { value: 0.3 },
      uDensity: { value: 0.06 },
      uCumuliform: { value: 0.8 },
      uFeatureScale: { value: 9000 },
      uShapeScale: { value: 6200 },
      uDetailScale: { value: 620 },
      uErosion: { value: 0.34 },
      uWind: { value: new THREE.Vector2() },
      uCirrus: { value: 0.2 },
    };
  }

  private sharedAtmos(): Record<string, THREE.IUniform> {
    return {
      uRayleighScatter: this.atmos.uRayleighScatter,
      uMieScatter: this.atmos.uMieScatter,
      uMieAbsorb: this.atmos.uMieAbsorb,
      uOzoneAbsorb: this.atmos.uOzoneAbsorb,
      uGroundAlbedo: this.atmos.uGroundAlbedo,
      uTransmittanceLut: this.atmos.uTransmittanceLut,
      uMultiScatterLut: this.atmos.uMultiScatterLut,
    };
  }

  private commonUniforms(): Record<string, THREE.IUniform> {
    return {
      ...this.sharedAtmos(),
      ...this.fieldUniforms(),
      uSkyViewLut: { value: null },
      uInverseViewProjection: { value: new THREE.Matrix4() },
      uCameraPos: { value: new THREE.Vector3() },
      uSunDir: { value: new THREE.Vector3(0, 1, 0) },
      uSunRadiance: { value: new THREE.Color(1, 1, 1) },
      uGroundBounce: { value: new THREE.Color(0, 0, 0) },
      uCityGlow: { value: new THREE.Color(0, 0, 0) },
      uViewHeight: { value: 6.36 },
      uFrame: { value: 0 },
      uResolution: { value: new THREE.Vector2(1, 1) },
      uAerialFalloff: { value: 1.2e-5 },
      uAmbientScale: { value: 1 },
    };
  }

  private makeVolumetric(): FullScreenPass {
    return new FullScreenPass(
      new THREE.ShaderMaterial({
        vertexShader: PASS_VERT,
        fragmentShader: CLOUD_VOLUMETRIC_FRAG,
        uniforms: {
          ...this.commonUniforms(),
          uSteps: { value: 48 },
          uMaxDistance: { value: 55000 },
        },
        toneMapped: false,
      }),
    );
  }

  private makeBillboard(): FullScreenPass {
    return new FullScreenPass(
      new THREE.ShaderMaterial({
        vertexShader: PASS_VERT,
        fragmentShader: CLOUD_BILLBOARD_FRAG,
        uniforms: { ...this.commonUniforms(), uSteps: { value: 1 } },
        toneMapped: false,
      }),
    );
  }

  private makeShadow(): FullScreenPass {
    return new FullScreenPass(
      new THREE.ShaderMaterial({
        vertexShader: PASS_VERT,
        fragmentShader: CLOUD_SHADOW_FRAG,
        uniforms: {
          ...this.fieldUniforms(),
          uSunDir: { value: new THREE.Vector3(0, 1, 0) },
          uShadowCentre: { value: new THREE.Vector2() },
          uShadowExtent: { value: this.shadowExtent },
          uStrength: { value: 0.8 },
        },
        toneMapped: false,
      }),
    );
  }

  private activeUniforms(): Record<string, THREE.IUniform> | null {
    if (this.mode === 'volumetric') return this.volumetricPass?.material.uniforms ?? null;
    if (this.mode === 'billboard') return this.billboardPass?.material.uniforms ?? null;
    return null;
  }

  private applyField(u: Record<string, THREE.IUniform>, w: WeatherState): void {
    u.uCloudBottom.value = w.bottom;
    u.uCloudTop.value = w.top;
    u.uCoverage.value = w.coverage;
    u.uDensity.value = w.density;
    u.uCumuliform.value = w.cumuliform;
    u.uFeatureScale.value = w.featureScale;
    u.uCirrus.value = w.cirrus;
    (u.uWind.value as THREE.Vector2).copy(this.drift);
  }

  /**
   * Renders the scatter buffer and the shadow map.
   *
   * @param sunDir unit vector toward the key light.
   * @param sunColor linear RGB of the key light, already attenuated.
   * @param nightFactor 0 by day, 1 once the sun is well down.
   */
  update(
    dt: number,
    camera: THREE.PerspectiveCamera,
    weather: WeatherState,
    sunDir: THREE.Vector3,
    sunColor: THREE.Color,
    sunIntensity: number,
    skyViewLut: THREE.Texture,
    viewHeightMm: number,
    nightFactor: number,
  ): void {
    this.frame++;
    this.drift.x -= Math.sin(weather.windBearing) * weather.windSpeed * dt;
    this.drift.y += Math.cos(weather.windBearing) * weather.windSpeed * dt;
    if (this.mode === 'off' || !this.scatter) return;

    const u = this.activeUniforms();
    if (!u) return;

    this.applyField(u, weather);
    u.uSkyViewLut.value = skyViewLut;
    (u.uCameraPos.value as THREE.Vector3).copy(camera.position);
    (u.uSunDir.value as THREE.Vector3).copy(sunDir);
    (u.uInverseViewProjection.value as THREE.Matrix4)
      .multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse)
      .invert();
    u.uViewHeight.value = viewHeightMm;
    u.uFrame.value = this.frame;
    (u.uResolution.value as THREE.Vector2).set(this.scatter.width, this.scatter.height);

    (u.uSunRadiance.value as THREE.Color).copy(sunColor).multiplyScalar(sunIntensity * SUN_GAIN);
    // Light bouncing off the city and the harbour into the cloud base, plus
    // the sodium/LED underlight that makes a Boston overcast glow orange.
    (u.uGroundBounce.value as THREE.Color).copy(sunColor).multiplyScalar(sunIntensity * 0.055);
    (u.uCityGlow.value as THREE.Color).setRGB(0.0055, 0.0034, 0.0019, THREE.LinearSRGBColorSpace)
      .multiplyScalar(nightFactor);
    u.uAerialFalloff.value = 1.0e-5 * weather.haze;

    if (this.volumetricPass && this.mode === 'volumetric') {
      this.volumetricPass.render(this.renderer, this.scatter);
    } else if (this.billboardPass) {
      this.billboardPass.render(this.renderer, this.scatter);
    }

    if (this.shadow && this.shadowPass && this.mode === 'volumetric') {
      const su = this.shadowPass.material.uniforms;
      this.applyField(su, weather);
      (su.uSunDir.value as THREE.Vector3).copy(sunDir);
      this.shadowCentre.set(camera.position.x, camera.position.z);
      (su.uShadowCentre.value as THREE.Vector2).copy(this.shadowCentre);
      su.uShadowExtent.value = this.shadowExtent;
      // Hard-edged cloud shadows under a thin deck look wrong; scale the
      // contrast with how much cloud there actually is.
      su.uStrength.value = 0.55 + 0.4 * weather.coverage;
      this.shadowPass.render(this.renderer, this.shadow);
    }
  }

  resize(width: number, height: number, settings: CloudSettings): void {
    this.configure(settings, width, height);
  }

  private disposeTargets(): void {
    this.scatter?.dispose();
    this.scatter = null;
    this.shadow?.dispose();
    this.shadow = null;
  }

  dispose(): void {
    this.disposeTargets();
    this.volumetricPass?.dispose();
    this.billboardPass?.dispose();
    this.shadowPass?.dispose();
    this.volumes?.dispose();
    this.volumes = null;
  }
}
