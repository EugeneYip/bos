import * as THREE from 'three';
import { FullScreenPass, PASS_VERT } from './util';
import {
  MULTISCATTER_FRAG,
  SKYVIEW_FRAG,
  TRANSMITTANCE_FRAG,
} from './shaders/atmosphere';

/**
 * Owns the three atmosphere lookup tables and the shared medium uniforms.
 *
 * The transmittance and multiple-scattering tables only depend on the
 * composition of the air, so they are rebuilt only when the haze changes
 * (i.e. on a weather transition, throttled). The sky-view table depends on the
 * sun and on the observer's altitude, so it is rebuilt every frame — it is
 * 256x144 with 32 raymarch steps, which costs well under a tenth of a
 * millisecond.
 */

/** Rayleigh scattering coefficients at sea level, per megametre. */
const RAYLEIGH = new THREE.Vector3(5.802, 13.558, 33.1);
/** Mie scattering for a clean maritime aerosol, per megametre. */
const MIE_SCATTER = 3.996;
/** Mie absorption. Urban aerosol is dirtier than the textbook value. */
const MIE_ABSORB = 0.9;
/** Ozone absorption in the Chappuis band, per megametre. */
const OZONE = new THREE.Vector3(0.65, 1.881, 0.085);

export const PLANET_RADIUS_MM = 6.36;
export const ATMOSPHERE_TOP_MM = 6.46;

/** Angular radius of the solar disc as seen from Earth, radians. */
export const SUN_ANGULAR_RADIUS = 0.004655;

export interface AtmosphereUniforms {
  uRayleighScatter: { value: THREE.Vector3 };
  uMieScatter: { value: THREE.Vector3 };
  uMieAbsorb: { value: THREE.Vector3 };
  uOzoneAbsorb: { value: THREE.Vector3 };
  uGroundAlbedo: { value: number };
  uMieG: { value: number };
  uTransmittanceLut: { value: THREE.Texture | null };
  uMultiScatterLut: { value: THREE.Texture | null };
}

function makeTarget(w: number, h: number, type: THREE.TextureDataType): THREE.WebGLRenderTarget {
  const rt = new THREE.WebGLRenderTarget(w, h, {
    type,
    format: THREE.RGBAFormat,
    minFilter: THREE.LinearFilter,
    magFilter: THREE.LinearFilter,
    wrapS: THREE.ClampToEdgeWrapping,
    wrapT: THREE.ClampToEdgeWrapping,
    depthBuffer: false,
    stencilBuffer: false,
    generateMipmaps: false,
  });
  rt.texture.colorSpace = THREE.NoColorSpace;
  return rt;
}

export class AtmosphereLuts {
  readonly uniforms: AtmosphereUniforms;

  private transmittance: THREE.WebGLRenderTarget;
  private multiScatter: THREE.WebGLRenderTarget;
  private skyView: THREE.WebGLRenderTarget;

  private transmittancePass: FullScreenPass;
  private multiScatterPass: FullScreenPass;
  private skyViewPass: FullScreenPass;

  /** Haze multiplier the static LUTs were last built with. */
  private builtHaze = -1;

  constructor(renderer: THREE.WebGLRenderer, skyViewWidth = 256, skyViewHeight = 144) {
    const gl = renderer.getContext();
    const canFloat =
      gl.getExtension('EXT_color_buffer_float') !== null ||
      gl.getExtension('EXT_color_buffer_half_float') !== null;
    const half = canFloat ? THREE.HalfFloatType : THREE.UnsignedByteType;

    this.transmittance = makeTarget(256, 64, half);
    this.multiScatter = makeTarget(32, 32, half);
    this.skyView = makeTarget(skyViewWidth, skyViewHeight, half);
    // Azimuth wraps all the way round the sun, so the sky-view LUT must too or
    // there is a hard seam in the anti-solar direction.
    this.skyView.texture.wrapS = THREE.RepeatWrapping;

    this.uniforms = {
      uRayleighScatter: { value: RAYLEIGH.clone() },
      uMieScatter: { value: new THREE.Vector3(MIE_SCATTER, MIE_SCATTER, MIE_SCATTER) },
      uMieAbsorb: { value: new THREE.Vector3(MIE_ABSORB, MIE_ABSORB, MIE_ABSORB) },
      uOzoneAbsorb: { value: OZONE.clone() },
      uGroundAlbedo: { value: 0.22 },
      uMieG: { value: 0.78 },
      uTransmittanceLut: { value: this.transmittance.texture },
      uMultiScatterLut: { value: this.multiScatter.texture },
    };

    const shared = (): Record<string, THREE.IUniform> => ({
      uRayleighScatter: this.uniforms.uRayleighScatter,
      uMieScatter: this.uniforms.uMieScatter,
      uMieAbsorb: this.uniforms.uMieAbsorb,
      uOzoneAbsorb: this.uniforms.uOzoneAbsorb,
      uGroundAlbedo: this.uniforms.uGroundAlbedo,
      uMieG: this.uniforms.uMieG,
    });

    this.transmittancePass = new FullScreenPass(
      new THREE.ShaderMaterial({
        vertexShader: PASS_VERT,
        fragmentShader: TRANSMITTANCE_FRAG,
        uniforms: shared(),
        toneMapped: false,
      }),
    );

    this.multiScatterPass = new FullScreenPass(
      new THREE.ShaderMaterial({
        vertexShader: PASS_VERT,
        fragmentShader: MULTISCATTER_FRAG,
        uniforms: { ...shared(), uTransmittanceLut: this.uniforms.uTransmittanceLut },
        toneMapped: false,
      }),
    );

    this.skyViewPass = new FullScreenPass(
      new THREE.ShaderMaterial({
        vertexShader: PASS_VERT,
        fragmentShader: SKYVIEW_FRAG,
        uniforms: {
          ...shared(),
          uTransmittanceLut: this.uniforms.uTransmittanceLut,
          uMultiScatterLut: this.uniforms.uMultiScatterLut,
          uSunDir: { value: new THREE.Vector3(0, 1, 0) },
          uViewHeight: { value: PLANET_RADIUS_MM },
          uSteps: { value: 32 },
        },
        toneMapped: false,
      }),
    );
  }

  get skyViewTexture(): THREE.Texture {
    return this.skyView.texture;
  }

  get transmittanceTexture(): THREE.Texture {
    return this.transmittance.texture;
  }

  /**
   * Sets the aerosol load. 1 is a clean day; overcast and storm push it up.
   * Rebuilding the static tables costs ~1 ms so it is gated on a real change.
   */
  setHaze(renderer: THREE.WebGLRenderer, haze: number): void {
    if (Math.abs(haze - this.builtHaze) < 0.02) return;
    this.builtHaze = haze;
    this.uniforms.uMieScatter.value.setScalar(MIE_SCATTER * haze);
    this.uniforms.uMieAbsorb.value.setScalar(MIE_ABSORB * haze);
    this.transmittancePass.render(renderer, this.transmittance);
    this.multiScatterPass.render(renderer, this.multiScatter);
  }

  /**
   * Rebuilds the sky-view table.
   * @param cameraAltitude metres above sea level.
   */
  updateSkyView(
    renderer: THREE.WebGLRenderer,
    sunDir: THREE.Vector3,
    cameraAltitude: number,
    steps: number,
  ): void {
    const u = this.skyViewPass.material.uniforms;
    (u.uSunDir.value as THREE.Vector3).copy(sunDir);
    // Keep the observer a little above the ground sphere: at exactly the
    // surface the horizon angle degenerates and the LUT's bottom row breaks.
    u.uViewHeight.value = PLANET_RADIUS_MM + Math.max(2, cameraAltitude) * 1e-6;
    u.uSteps.value = steps;
    this.skyViewPass.render(renderer, this.skyView);
  }

  /** Observer height in megametres that the sky-view LUT was built for. */
  get viewHeightMm(): number {
    return this.skyViewPass.material.uniforms.uViewHeight.value as number;
  }

  dispose(): void {
    this.transmittance.dispose();
    this.multiScatter.dispose();
    this.skyView.dispose();
    this.transmittancePass.dispose();
    this.multiScatterPass.dispose();
    this.skyViewPass.dispose();
  }
}

/**
 * CPU mirror of the transmittance raymarch, used to colour the directional
 * light. Reading the GPU LUT back would stall the pipeline; forty iterations
 * of arithmetic per frame is free by comparison and the two agree to well
 * under a percent.
 *
 * @param altitude observer altitude in metres.
 * @param sunElevation radians above the horizon.
 * @param haze aerosol multiplier matching {@link AtmosphereLuts.setHaze}.
 */
export function sunTransmittanceCPU(
  altitude: number,
  sunElevation: number,
  haze: number,
  out = new THREE.Color(),
): THREE.Color {
  const r0 = PLANET_RADIUS_MM + Math.max(0, altitude) * 1e-6;
  // Observer at (0, r0, 0); the ray toward the sun has +Y = up.
  const dy = Math.sin(sunElevation);
  const dx = Math.cos(sunElevation);
  const b = r0 * dy;

  /** Nearest positive root of |O + tD| = rad, or -1. */
  const hit = (rad: number): number => {
    const c = r0 * r0 - rad * rad;
    if (c > 0 && b > 0) return -1;
    const disc = b * b - c;
    if (disc < 0) return -1;
    const s = Math.sqrt(disc);
    return disc > b * b ? -b + s : -b - s;
  };

  // The planet occludes the sun below the geometric horizon.
  if (hit(PLANET_RADIUS_MM) > 0) return out.setRGB(0, 0, 0, THREE.LinearSRGBColorSpace);
  const tMax = hit(ATMOSPHERE_TOP_MM);
  if (tMax <= 0) return out.setRGB(1, 1, 1, THREE.LinearSRGBColorSpace);

  const mieS = MIE_SCATTER * haze;
  const mieA = MIE_ABSORB * haze;

  const STEPS = 40;
  let odR = 0;
  let odM = 0;
  let odO = 0;
  let t = 0;
  for (let i = 0; i < STEPS; i++) {
    const newT = ((i + 0.3) / STEPS) * tMax;
    const dt = newT - t;
    t = newT;
    const px = dx * t;
    const py = r0 + dy * t;
    const h = (Math.sqrt(px * px + py * py) - PLANET_RADIUS_MM) * 1000;
    odR += dt * Math.exp(-h / 8);
    odM += dt * Math.exp(-h / 1.2);
    odO += dt * Math.max(0, 1 - Math.abs(h - 25) / 15);
  }

  const r = Math.exp(-(RAYLEIGH.x * odR + (mieS + mieA) * odM + OZONE.x * odO));
  const g = Math.exp(-(RAYLEIGH.y * odR + (mieS + mieA) * odM + OZONE.y * odO));
  const bch = Math.exp(-(RAYLEIGH.z * odR + (mieS + mieA) * odM + OZONE.z * odO));
  return out.setRGB(r, g, bch, THREE.LinearSRGBColorSpace);
}
