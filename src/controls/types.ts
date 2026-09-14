import type * as THREE from 'three';
import type { Ctx } from '../core/Context';
import type { Input } from './Input';

export type ModeId = 'orbit' | 'fly' | 'walk' | 'drive' | 'cinematic';

export const MODE_IDS: ModeId[] = ['orbit', 'fly', 'walk', 'drive', 'cinematic'];

export interface ModeInfo {
  id: ModeId;
  label: string;
  hint: string;
}

export const MODE_INFO: Record<ModeId, ModeInfo> = {
  orbit: { id: 'orbit', label: 'Orbit', hint: 'Drag to orbit · right-drag to pan · scroll to zoom' },
  fly: { id: 'fly', label: 'Fly', hint: 'WASD + QE · drag to look · shift boost · ctrl crawl' },
  walk: { id: 'walk', label: 'Walk', hint: 'WASD at street level · shift to run · ctrl to crouch' },
  drive: { id: 'drive', label: 'Drive', hint: 'Chase camera following a vehicle' },
  cinematic: { id: 'cinematic', label: 'Cinematic', hint: 'Scripted flythroughs along a spline path' },
};

/**
 * One camera behaviour. Modes write straight to `ctx.camera`; the rig owns
 * when they are allowed to run.
 */
export interface CameraMode {
  readonly id: ModeId;
  /** Adopt the live camera pose so switching in never snaps. */
  enter(ctx: Ctx, input: Input): void;
  exit?(ctx: Ctx): void;
  update(dt: number, ctx: Ctx, input: Input): void;
  /**
   * Called every frame while the rig is suspended (QA harness drove the
   * camera). Modes track the external pose so resuming is seamless.
   */
  sync(ctx: Ctx): void;
  /** False when a dependency (e.g. a physics vehicle) is missing. */
  available?(ctx: Ctx): boolean;
  /** Reason shown in the UI when `available()` is false. */
  unavailableReason?: string;
}

export type Vec3Tuple = [number, number, number];

/** Payload for the `camera-fly-to` event. */
export interface FlyToRequest {
  pos: Vec3Tuple | THREE.Vector3;
  target: Vec3Tuple | THREE.Vector3;
  /** Seconds; omitted means "derive from distance". */
  duration?: number;
  /** Mode to land in. Defaults to the current mode (cinematic falls to orbit). */
  mode?: ModeId;
  /** Skip the arc and cut straight there. */
  instant?: boolean;
  label?: string;
}

/**
 * Character-collision request broadcast on `physics:move-character`.
 * Any physics implementation may answer it by writing `out`, `grounded` and
 * setting `handled = true`. If nobody answers we fall back to terrain-only
 * collision. See the module report for the full contract.
 */
export interface CharacterMoveRequest {
  position: { x: number; y: number; z: number };
  delta: { x: number; y: number; z: number };
  radius: number;
  height: number;
  out: { x: number; y: number; z: number };
  grounded: boolean;
  handled: boolean;
}

/**
 * Vehicle state request broadcast on `physics:get-vehicle`. A physics module
 * with a driveable vehicle fills in the fields and sets `handled = true`.
 */
export interface VehicleStateRequest {
  position: { x: number; y: number; z: number };
  /** Forward direction, unit length. */
  forward: { x: number; y: number; z: number };
  /** Metres/second along `forward`. */
  speed: number;
  handled: boolean;
}
