/**
 * Frame-rate-independent smoothing helpers.
 *
 * Every interpolation in the camera rig is of the form
 *
 *   x += (target - x) * (1 - exp(-lambda * dt))
 *
 * which converges at the same rate in wall-clock time regardless of frame rate.
 * `lambda` is a *rate* in units of 1/second: the value closes ~63% of the
 * remaining gap every `1/lambda` seconds. Never use a bare lerp factor here —
 * the feel changes between a 30 Hz laptop and a 144 Hz desktop.
 */
import * as THREE from 'three';

export const TAU = Math.PI * 2;

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/** Exponential smoothing toward `target`. */
export function damp(current: number, target: number, lambda: number, dt: number): number {
  return current + (target - current) * (1 - Math.exp(-lambda * dt));
}

/** Exponential smoothing of a vector, in place on `current`. */
export function dampVec3(
  current: THREE.Vector3,
  target: THREE.Vector3,
  lambda: number,
  dt: number,
): THREE.Vector3 {
  const a = 1 - Math.exp(-lambda * dt);
  current.x += (target.x - current.x) * a;
  current.y += (target.y - current.y) * a;
  current.z += (target.z - current.z) * a;
  return current;
}

/** Shortest-path angular smoothing (handles the ±π wrap). */
export function dampAngle(current: number, target: number, lambda: number, dt: number): number {
  let d = (target - current) % TAU;
  if (d > Math.PI) d -= TAU;
  if (d < -Math.PI) d += TAU;
  return current + d * (1 - Math.exp(-lambda * dt));
}

/** Frame-rate-independent exponential decay of a velocity (friction). */
export function decay(value: number, lambda: number, dt: number): number {
  return value * Math.exp(-lambda * dt);
}

export function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = clamp((x - edge0) / (edge1 - edge0), 0, 1);
  return t * t * (3 - 2 * t);
}

export function easeInOutCubic(t: number): number {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

export function easeOutCubic(t: number): number {
  return 1 - Math.pow(1 - t, 3);
}

export function easeInOutSine(t: number): number {
  return -(Math.cos(Math.PI * t) - 1) / 2;
}

/** Wrap an angle into [-π, π). */
export function wrapPi(a: number): number {
  let x = (a + Math.PI) % TAU;
  if (x < 0) x += TAU;
  return x - Math.PI;
}

/** Compass heading in degrees (0 = north, 90 = east) for a world-space forward vector. */
export function headingDeg(forward: THREE.Vector3): number {
  // World: +X east, +Z south. North is -Z.
  const deg = (Math.atan2(forward.x, -forward.z) * 180) / Math.PI;
  return (deg + 360) % 360;
}

const CARDINALS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'] as const;
export function cardinal(deg: number): string {
  return CARDINALS[Math.round(((deg % 360) + 360) % 360 / 45) % 8];
}
