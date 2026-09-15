import * as THREE from 'three';
import type { QualitySettings, QualityTier } from './config';

/**
 * Samples terrain elevation (metres above sea level) at a world X/Z.
 * Provided by the terrain module; before it loads this returns 0.
 */
export type HeightSampler = (x: number, z: number) => number;

export interface SunState {
  /** Unit vector pointing from the world toward the sun. */
  direction: THREE.Vector3;
  /** Linear RGB colour of direct sunlight at the current elevation. */
  color: THREE.Color;
  /** Scalar irradiance multiplier, 0 at night. */
  intensity: number;
  /** Sun elevation above the horizon, radians. Negative at night. */
  elevation: number;
  azimuth: number;
}

/**
 * Physical aerial perspective, published by the sky module once its scattering
 * tables exist.
 *
 * Anything built on `MeshStandardMaterial` already gets this through the fog
 * chunk the sky module rewrites, and needs nothing from here. A hand-written
 * `ShaderMaterial` — the water — cannot be reached that way, so it pastes
 * `glsl` into its fragment stage and merges `uniforms` into its own. Sharing
 * the uniform *objects* is the point: the sky writes them once a frame and
 * every consumer sees the same atmosphere, which is the only way the water,
 * the far terrain and the dome can meet at the horizon without a seam.
 */
export interface AerialPerspective {
  /**
   * Declares the `uApXxx` uniforms and defines `skyApRadiance( dir, rough )`,
   * `skyApplyOffset( colour, worldOffset )` and `skyCloudTransmittance( p )`.
   * Self-guarded, so including it twice is harmless.
   */
  glsl: string;
  uniforms: Record<string, THREE.IUniform>;
}

/**
 * The single object threaded through every world module. Modules read from it
 * and may publish capabilities onto it (e.g. the terrain module installs
 * `sampleHeight`). Keep additions additive so modules stay decoupled.
 */
export interface Ctx {
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  renderer: THREE.WebGLRenderer;
  clock: THREE.Clock;

  tier: QualityTier;
  quality: QualitySettings;

  /** Seconds since boot. */
  elapsed: number;
  /** Local Boston time of day in hours, 0-24, drives the sun. */
  timeOfDay: number;
  /** Day of year 1-365, drives the solar declination. */
  dayOfYear: number;
  sun: SunState;

  /** Terrain elevation lookup. Installed by the terrain module. */
  sampleHeight: HeightSampler;

  /** Environment map used for IBL; installed by the sky module. */
  envMap: THREE.Texture | null;

  /**
   * The exposure the last frame was actually presented at, written by whatever
   * owns presentation — the post chain when it is up, the sky module otherwise.
   *
   * Read it, do not set it. Anything authored *display-referred* — lit windows,
   * street lamps, vehicle lights, the city's glow on the water — has to divide
   * by this or it clips the moment exposure winds up after sunset. The value
   * matters more than it looks: the sky publishes an artistic exposure on the
   * renderer, the grade then blends that with a metered one, and at night the
   * metered half is three or four times higher. Compensating against the sky's
   * number alone is what turned every tower into a white slab after dark.
   *
   * One frame stale by construction, which is nothing on a quantity that
   * already adapts over seconds.
   */
  exposure: number;

  /** Shared atmosphere for shaders that cannot use the fog chunk; see above. */
  aerial: AerialPerspective | null;

  /** Shared PBR texture/material library; installed by the Materials module. */
  materials: MaterialLibrary;

  /** Per-frame stats surfaced to the HUD. */
  stats: Record<string, number | string>;

  /** Simple event bus for cross-module signals (e.g. 'quality-changed'). */
  on(evt: string, fn: (payload?: unknown) => void): void;
  emit(evt: string, payload?: unknown): void;
}

/**
 * Texture set for one surface family. Maps are tileable and share UV scale.
 * `NoColorSpace` on every map except `map`.
 */
export interface TextureSet {
  map: THREE.Texture;
  normalMap?: THREE.Texture;
  roughnessMap?: THREE.Texture;
  aoMap?: THREE.Texture;
  metalnessMap?: THREE.Texture;
  /** World-space metres covered by one UV tile, used to derive UVs. */
  tileMeters: number;
}

/**
 * Published by the Materials module as `ctx.materials`. Every other module
 * pulls surfaces from here rather than constructing its own, so the whole city
 * shares one coherent, colour-managed look.
 */
export interface MaterialLibrary {
  /** Named PBR texture sets: 'brick', 'brownstone', 'concrete', 'asphalt', ... */
  textures(name: string): TextureSet | undefined;
  /**
   * A cached, ready-to-use material. `tint` is an sRGB hex multiplied into the
   * albedo so thousands of buildings can share one material+texture but differ
   * in colour (via instance colour where the caller supports it).
   */
  get(name: string, tint?: number): THREE.Material;
  /** Register an externally-authored set so it participates in disposal. */
  register(name: string, set: TextureSet): void;
}

export interface WorldModule {
  readonly name: string;
  /** Heavier setup; may fetch. Modules are initialised in registration order. */
  init?(ctx: Ctx): Promise<void> | void;
  /** Called once per frame before rendering. */
  update?(dt: number, ctx: Ctx): void;
  resize?(width: number, height: number, ctx: Ctx): void;
  dispose?(ctx: Ctx): void;
}
