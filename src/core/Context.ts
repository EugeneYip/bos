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

  /** Shared PBR texture library; installed by the materials module. */
  textures: Map<string, THREE.Texture>;

  /** Per-frame stats surfaced to the HUD. */
  stats: Record<string, number | string>;

  /** Simple event bus for cross-module signals (e.g. 'quality-changed'). */
  on(evt: string, fn: (payload?: unknown) => void): void;
  emit(evt: string, payload?: unknown): void;
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
