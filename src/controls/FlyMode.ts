/**
 * Free 6-DOF flight.
 *
 * Feel notes:
 *  - Speed is altitude-aware: `base + agl * k`. At 2 m above a roof you creep
 *    along at walking pace so you can read a cornice; at 2 km you cross the
 *    whole city in seconds. Without this, one speed is always wrong.
 *  - Velocity is integrated and damped (not position-lerped) so there is real
 *    weight: releasing W glides to a stop instead of stopping dead.
 *  - A few degrees of bank while strafing sells the motion. It is tiny (8°)
 *    and damped slowly, which reads as inertia rather than as a gimmick.
 */
import * as THREE from 'three';
import type { Ctx } from '../core/Context';
import type { CameraMode } from './types';
import type { Input } from './Input';
import { clamp, damp, dampVec3 } from './math';
import { groundAt } from './pick';

const MAX_PITCH = Math.PI / 2 - 0.015;

export class FlyMode implements CameraMode {
  readonly id = 'fly' as const;

  private yaw = 0;
  private pitch = 0;
  private yawT = 0;
  private pitchT = 0;
  private roll = 0;
  private vel = new THREE.Vector3();
  private velT = new THREE.Vector3();
  private pos = new THREE.Vector3();

  /** User-tunable multiplier (mouse wheel), surfaced in the HUD. */
  speedScale = 1;

  // Feel parameters -------------------------------------------------------
  lookSpeed = 0.0026; // rad per CSS pixel
  lookDamping = 26;
  accelDamping = 7.5; // while thrusting
  coastDamping = 3.0; // while gliding
  baseSpeed = 6.5; // m/s at ground level
  altitudeGain = 0.55; // extra m/s per metre of altitude
  maxSpeed = 950;
  boost = 4.2;
  crawl = 0.2;
  bankAngle = 0.14; // radians at full lateral speed

  private _q = new THREE.Quaternion();
  private _qi = new THREE.Quaternion();
  private _e = new THREE.Euler(0, 0, 0, 'YXZ');
  private _v = new THREE.Vector3();

  enter(ctx: Ctx): void {
    this.adopt(ctx);
    this.vel.set(0, 0, 0);
    this.velT.set(0, 0, 0);
  }

  exit(): void {
    this.vel.set(0, 0, 0);
  }

  sync(ctx: Ctx): void {
    this.adopt(ctx);
  }

  private adopt(ctx: Ctx): void {
    const cam = ctx.camera;
    this.pos.copy(cam.position);
    this._e.setFromQuaternion(cam.quaternion, 'YXZ');
    this.yaw = this.yawT = this._e.y;
    this.pitch = this.pitchT = clamp(this._e.x, -MAX_PITCH, MAX_PITCH);
    this.roll = 0;
  }

  /** Current speed in m/s — HUD readout. */
  speed = 0;

  update(dt: number, ctx: Ctx, input: Input): void {
    const cam = ctx.camera;

    // --- look -------------------------------------------------------------
    if ((input.dragging && input.dragKind === 'rotate') || input.pointerLocked) {
      this.yawT -= input.rotateX * this.lookSpeed;
      this.pitchT = clamp(this.pitchT - input.rotateY * this.lookSpeed, -MAX_PITCH, MAX_PITCH);
    }
    const akx = input.axis(['ArrowLeft'], ['ArrowRight']);
    const aky = input.axis(['ArrowDown'], ['ArrowUp']);
    if (akx || aky) {
      this.yawT -= akx * 1.15 * dt;
      this.pitchT = clamp(this.pitchT + aky * 0.9 * dt, -MAX_PITCH, MAX_PITCH);
    }
    this.yaw = damp(this.yaw, this.yawT, this.lookDamping, dt);
    this.pitch = damp(this.pitch, this.pitchT, this.lookDamping, dt);

    // --- speed envelope ---------------------------------------------------
    if (input.zoom) this.speedScale = clamp(this.speedScale * Math.exp(input.zoom * 0.16), 0.12, 12);
    const agl = Math.max(this.pos.y - groundAt(ctx, this.pos.x, this.pos.z), 0);
    let speed = (this.baseSpeed + agl * this.altitudeGain) * this.speedScale;
    if (input.shift) speed *= this.boost;
    if (input.ctrl) speed *= this.crawl;
    speed = clamp(speed, 0.35, this.maxSpeed);

    // --- thrust -----------------------------------------------------------
    // WASD/QE drive thrust; the arrow keys steer (handled above) so the whole
    // mode is reachable from the keyboard alone.
    const thrust = input.axis(['KeyS'], ['KeyW']);
    const strafe = input.axis(['KeyA'], ['KeyD']);
    const lift = input.axis(['KeyQ', 'KeyC'], ['KeyE', 'Space']);

    this._e.set(this.pitch, this.yaw, 0, 'YXZ');
    this._q.setFromEuler(this._e);

    this.velT.set(0, 0, 0);
    if (thrust) this.velT.addScaledVector(this._v.set(0, 0, -1).applyQuaternion(this._q), thrust);
    if (strafe) this.velT.addScaledVector(this._v.set(1, 0, 0).applyQuaternion(this._q), strafe);
    if (lift) this.velT.y += lift;
    const moving = this.velT.lengthSq() > 1e-6;
    if (moving) this.velT.normalize().multiplyScalar(speed);

    dampVec3(this.vel, this.velT, moving ? this.accelDamping : this.coastDamping, dt);
    if (this.vel.lengthSq() < 1e-4) this.vel.set(0, 0, 0);
    this.pos.addScaledVector(this.vel, dt);
    this.speed = this.vel.length();

    // --- ground clamp -----------------------------------------------------
    const floor = groundAt(ctx, this.pos.x, this.pos.z) + 1.6;
    if (this.pos.y < floor) {
      this.pos.y = floor;
      if (this.vel.y < 0) this.vel.y = 0;
    }

    // --- bank -------------------------------------------------------------
    this._qi.copy(this._q).invert();
    const lateral = this._v.copy(this.vel).applyQuaternion(this._qi).x;
    const bankT = clamp(-lateral / Math.max(speed, 1), -1, 1) * this.bankAngle;
    this.roll = damp(this.roll, bankT, 4.2, dt);

    this._e.set(this.pitch, this.yaw, this.roll, 'YXZ');
    cam.quaternion.setFromEuler(this._e);
    cam.position.copy(this.pos);
  }
}
