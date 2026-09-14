/**
 * Cheap world picking that never touches the scene graph.
 *
 * Ray-casting a city of instanced meshes per wheel event is far too expensive,
 * so we march the terrain heightfield instead. The result is good enough for
 * zoom-to-cursor and minimap navigation, and costs a few dozen `sampleHeight`
 * calls only when the user actually scrolls.
 */
import * as THREE from 'three';
import type { Ctx } from '../core/Context';
import { clamp } from './math';

const _ray = new THREE.Ray();
const _tmp = new THREE.Vector3();

/** NDC (-1..1) for a viewport-relative point (0..1 from the top-left). */
export function ndcFromViewport(x: number, y: number): THREE.Vector2 {
  return new THREE.Vector2(x * 2 - 1, -(y * 2 - 1));
}

/**
 * Marches `ctx.sampleHeight` along the view ray. Returns the world hit point,
 * or `null` when the ray escapes over the horizon.
 */
export function pickTerrain(
  ctx: Ctx,
  ndcX: number,
  ndcY: number,
  maxDist = 24000,
  out = new THREE.Vector3(),
): THREE.Vector3 | null {
  const cam = ctx.camera;
  _ray.origin.setFromMatrixPosition(cam.matrixWorld);
  _tmp.set(ndcX, ndcY, 0.5).unproject(cam).sub(_ray.origin).normalize();
  _ray.direction.copy(_tmp);

  const sample = ctx.sampleHeight;
  let t = 1;
  let prevT = 0;
  let prevGap = _ray.origin.y - sample(_ray.origin.x, _ray.origin.z);
  // Geometric steps: fine near the camera where precision matters, coarse far
  // away where a metre either way is invisible.
  let step = 2;
  for (let i = 0; i < 96 && t < maxDist; i++) {
    const px = _ray.origin.x + _ray.direction.x * t;
    const py = _ray.origin.y + _ray.direction.y * t;
    const pz = _ray.origin.z + _ray.direction.z * t;
    const gap = py - sample(px, pz);
    if (gap <= 0 && prevGap > 0) {
      // Linear refine between the last two samples.
      const f = prevGap / (prevGap - gap);
      const ht = prevT + (t - prevT) * f;
      out.set(
        _ray.origin.x + _ray.direction.x * ht,
        _ray.origin.y + _ray.direction.y * ht,
        _ray.origin.z + _ray.direction.z * ht,
      );
      return out;
    }
    prevGap = gap;
    prevT = t;
    step *= 1.14;
    t += step;
  }
  return null;
}

/**
 * Terrain pick with a fallback to the horizontal plane through `planeY`, so
 * zoom-to-cursor still works when aiming at the sky or before terrain loads.
 */
export function pickGroundOrPlane(
  ctx: Ctx,
  ndcX: number,
  ndcY: number,
  planeY: number,
  out = new THREE.Vector3(),
): THREE.Vector3 | null {
  const hit = pickTerrain(ctx, ndcX, ndcY, 24000, out);
  if (hit) return hit;

  const cam = ctx.camera;
  _ray.origin.setFromMatrixPosition(cam.matrixWorld);
  _tmp.set(ndcX, ndcY, 0.5).unproject(cam).sub(_ray.origin).normalize();
  if (Math.abs(_tmp.y) < 1e-5) return null;
  const t = (planeY - _ray.origin.y) / _tmp.y;
  if (t <= 0) return null;
  return out.copy(_ray.origin).addScaledVector(_tmp, Math.min(t, 40000));
}

/** Terrain height with a safe default when the terrain module hasn't loaded. */
export function groundAt(ctx: Ctx, x: number, z: number): number {
  const h = ctx.sampleHeight(x, z);
  return Number.isFinite(h) ? h : 0;
}

/** Smallest camera height that keeps us above the terrain by `clearance`. */
export function floorAt(ctx: Ctx, x: number, z: number, clearance: number): number {
  return groundAt(ctx, x, z) + clearance;
}

export { clamp };
