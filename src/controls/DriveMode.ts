/**
 * Chase camera for a vehicle published by the Physics module.
 *
 * The Physics module is built concurrently, so this mode discovers a vehicle
 * defensively and reports itself unavailable when there isn't one. Two
 * discovery paths are supported, both optional:
 *
 *   1. `ctx.vehicle = { position, forward|quaternion, speed }` (a plain object)
 *   2. `ctx.on('physics:get-vehicle', req => { …fill req…; req.handled = true })`
 *
 * Feel notes: the rig trails the car rather than being rigidly bolted to it —
 * position damping is slower than aim damping, so the camera swings wide on
 * corners and catches up on the straights. A few degrees of FOV with speed
 * does most of the work of selling velocity.
 */
import * as THREE from 'three';
import type { Ctx } from '../core/Context';
import type { CameraMode, VehicleStateRequest } from './types';
import type { Input } from './Input';
import { RENDER } from '../core/config';
import { clamp, damp, dampVec3 } from './math';
import { groundAt } from './pick';

interface VehicleLike {
  position?: { x: number; y: number; z: number };
  forward?: { x: number; y: number; z: number };
  quaternion?: { x: number; y: number; z: number; w: number };
  speed?: number;
}

export class DriveMode implements CameraMode {
  readonly id = 'drive' as const;
  unavailableReason = 'No vehicle published by the Physics module yet';

  // Feel parameters -------------------------------------------------------
  height = 2.9;
  distance = 8.2;
  lookAhead = 9;
  posDamping = 5.0;
  aimDamping = 8.5;
  fovKick = 6;

  private pos = new THREE.Vector3();
  private aim = new THREE.Vector3();
  private fov: number = RENDER.fov;
  private orbitYaw = 0; // user can look around while driving
  private orbitYawT = 0;

  private req: VehicleStateRequest = {
    position: { x: 0, y: 0, z: 0 },
    forward: { x: 0, y: 0, z: -1 },
    speed: 0,
    handled: false,
  };

  private _v = new THREE.Vector3();
  private _f = new THREE.Vector3();
  private _q = new THREE.Quaternion();
  private _desired = new THREE.Vector3();

  /** Vehicle speed in m/s — HUD readout. */
  speed = 0;

  available(ctx: Ctx): boolean {
    return this.read(ctx) !== null;
  }

  enter(ctx: Ctx): void {
    this.pos.copy(ctx.camera.position);
    this.aim.copy(ctx.camera.position);
    ctx.camera.getWorldDirection(this._v);
    this.aim.addScaledVector(this._v, 30);
    this.fov = ctx.camera.fov;
    this.orbitYaw = this.orbitYawT = 0;
  }

  exit(ctx: Ctx): void {
    if (ctx.camera.fov !== RENDER.fov) {
      ctx.camera.fov = RENDER.fov;
      ctx.camera.updateProjectionMatrix();
    }
  }

  sync(ctx: Ctx): void {
    this.pos.copy(ctx.camera.position);
  }

  private read(ctx: Ctx): VehicleLike | null {
    const direct = (ctx as unknown as { vehicle?: VehicleLike }).vehicle;
    if (direct && direct.position && Number.isFinite(direct.position.x)) return direct;

    const req = this.req;
    req.handled = false;
    req.speed = 0;
    try {
      ctx.emit('physics:get-vehicle', req);
    } catch {
      return null;
    }
    return req.handled && Number.isFinite(req.position.x) ? req : null;
  }

  update(dt: number, ctx: Ctx, input: Input): void {
    const cam = ctx.camera;
    const v = this.read(ctx);
    if (!v || !v.position) {
      // Vehicle vanished mid-drive: hold still rather than snapping to origin.
      cam.position.copy(this.pos);
      cam.lookAt(this.aim);
      return;
    }

    if (v.forward) {
      this._f.set(v.forward.x, 0, v.forward.z);
    } else if (v.quaternion) {
      this._q.set(v.quaternion.x, v.quaternion.y, v.quaternion.z, v.quaternion.w);
      this._f.set(0, 0, -1).applyQuaternion(this._q).setY(0);
    } else {
      this._f.set(0, 0, -1);
    }
    if (this._f.lengthSq() < 1e-6) this._f.set(0, 0, -1);
    this._f.normalize();

    this.speed = Math.abs(v.speed ?? 0);

    // Let the driver look around; recentres when they let go.
    if (input.dragging && input.dragKind === 'rotate') this.orbitYawT -= input.rotateX * 0.004;
    else this.orbitYawT = damp(this.orbitYawT, 0, 1.6, dt);
    this.orbitYaw = damp(this.orbitYaw, clamp(this.orbitYawT, -2.6, 2.6), 10, dt);
    if (this.orbitYaw) this._f.applyAxisAngle(this._v.set(0, 1, 0), this.orbitYaw);

    const speedT = clamp(this.speed / 32, 0, 1);
    const dist = this.distance * (1 + speedT * 0.32);

    this._desired.set(v.position.x, v.position.y, v.position.z)
      .addScaledVector(this._f, -dist);
    this._desired.y += this.height + speedT * 0.5;

    const floor = groundAt(ctx, this._desired.x, this._desired.z) + 1.2;
    if (this._desired.y < floor) this._desired.y = floor;

    dampVec3(this.pos, this._desired, this.posDamping + speedT * 3, dt);

    this._v.set(v.position.x, v.position.y + 1.25, v.position.z).addScaledVector(this._f, this.lookAhead);
    dampVec3(this.aim, this._v, this.aimDamping, dt);

    const fovT = RENDER.fov + speedT * this.fovKick;
    const nextFov = damp(this.fov, fovT, 3.5, dt);
    if (Math.abs(nextFov - this.fov) > 0.01) {
      this.fov = nextFov;
      cam.fov = nextFov;
      cam.updateProjectionMatrix();
    }

    cam.position.copy(this.pos);
    cam.up.set(0, 1, 0);
    cam.lookAt(this.aim);
  }
}
