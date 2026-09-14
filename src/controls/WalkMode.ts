/**
 * First-person pedestrian.
 *
 * Feel notes:
 *  - Eye height 1.7 m, glued to `ctx.sampleHeight` through a damped follower so
 *    a coarse heightfield doesn't make the head vibrate.
 *  - Head-bob is driven by *distance travelled*, not by time, so it stays in
 *    step with the feet at any speed and stops instantly when you do.
 *  - Each footfall fires a small decaying pitch/roll impulse. It is only ~0.4°
 *    but it is the difference between "camera sliding along" and "someone
 *    walking".
 *  - Collision asks the Physics module via the `physics:move-character` event
 *    and falls back to terrain-only if nobody answers.
 */
import * as THREE from 'three';
import type { Ctx } from '../core/Context';
import type { CameraMode, CharacterMoveRequest } from './types';
import type { Input } from './Input';
import { clamp, damp } from './math';
import { groundAt } from './pick';

const MAX_PITCH = Math.PI / 2 - 0.05;
const RADIUS = 0.34;

interface PhysicsLike {
  moveCharacter?: (
    pos: { x: number; y: number; z: number },
    delta: { x: number; y: number; z: number },
    radius: number,
    height: number,
  ) => { x: number; y: number; z: number } | null | undefined;
}

export class WalkMode implements CameraMode {
  readonly id = 'walk' as const;

  private yaw = 0;
  private pitch = 0;
  private yawT = 0;
  private pitchT = 0;
  private pos = new THREE.Vector3(); // feet position
  private vel = new THREE.Vector3();
  private groundY = 0;
  private stridePhase = 0;
  private stepKick = 0;
  private stepKickVel = 0;
  private lean = 0;
  private bobY = 0;
  private bobX = 0;
  private lastStepSide = 1;

  // Feel parameters -------------------------------------------------------
  lookSpeed = 0.0028;
  lookDamping = 30;
  eyeHeight = 1.7;
  crouchHeight = 1.14;
  walkSpeed = 1.55;
  runSpeed = 4.5;
  crouchSpeed = 0.9;
  accel = 12;
  strideLength = 0.82; // metres per half-stride
  bobAmount = 0.032;
  groundDamping = 17;

  /** Current ground speed, m/s — HUD readout. */
  speed = 0;

  private req: CharacterMoveRequest = {
    position: { x: 0, y: 0, z: 0 },
    delta: { x: 0, y: 0, z: 0 },
    radius: RADIUS,
    height: 1.8,
    out: { x: 0, y: 0, z: 0 },
    grounded: false,
    handled: false,
  };

  private _e = new THREE.Euler(0, 0, 0, 'YXZ');
  private _v = new THREE.Vector3();

  enter(ctx: Ctx): void {
    this.adopt(ctx);
    this.vel.set(0, 0, 0);
    this.stridePhase = 0;
    this.stepKick = 0;
    this.stepKickVel = 0;
  }

  sync(ctx: Ctx): void {
    this.adopt(ctx);
  }

  private adopt(ctx: Ctx): void {
    const cam = ctx.camera;
    this._e.setFromQuaternion(cam.quaternion, 'YXZ');
    this.yaw = this.yawT = this._e.y;
    this.pitch = this.pitchT = clamp(this._e.x, -MAX_PITCH, MAX_PITCH);
    this.pos.set(cam.position.x, 0, cam.position.z);
    this.groundY = groundAt(ctx, this.pos.x, this.pos.z);
    this.pos.y = this.groundY;
    this.bobX = 0;
    this.bobY = 0;
    this.lean = 0;
  }

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
      this.yawT -= akx * 1.3 * dt;
      this.pitchT = clamp(this.pitchT + aky * 1.0 * dt, -MAX_PITCH, MAX_PITCH);
    }
    this.yaw = damp(this.yaw, this.yawT, this.lookDamping, dt);
    this.pitch = damp(this.pitch, this.pitchT, this.lookDamping, dt);

    // --- intent -----------------------------------------------------------
    const crouching = input.ctrl;
    const fwd = input.axis(['KeyS'], ['KeyW']);
    const strafe = input.axis(['KeyA'], ['KeyD']);
    const target = crouching ? this.crouchSpeed : input.shift ? this.runSpeed : this.walkSpeed;

    const sy = Math.sin(this.yaw);
    const cy = Math.cos(this.yaw);
    // Forward on the ground plane for yaw (three's -Z forward).
    this._v.set(-fwd * sy + strafe * cy, 0, -fwd * cy - strafe * sy);
    const moving = this._v.lengthSq() > 1e-6;
    if (moving) this._v.normalize().multiplyScalar(target);

    const a = 1 - Math.exp(-(moving ? this.accel : this.accel * 1.4) * dt);
    this.vel.x += (this._v.x - this.vel.x) * a;
    this.vel.z += (this._v.z - this.vel.z) * a;
    if (Math.abs(this.vel.x) < 1e-3) this.vel.x = 0;
    if (Math.abs(this.vel.z) < 1e-3) this.vel.z = 0;

    // --- move with collision ---------------------------------------------
    const dx = this.vel.x * dt;
    const dz = this.vel.z * dt;
    if (dx !== 0 || dz !== 0) this.move(ctx, dx, dz);

    this.speed = Math.hypot(this.vel.x, this.vel.z);

    // --- stick to the ground ---------------------------------------------
    const g = groundAt(ctx, this.pos.x, this.pos.z);
    this.groundY = damp(this.groundY, g, this.groundDamping, dt);
    this.pos.y = this.groundY;

    // --- gait -------------------------------------------------------------
    const eye = crouching ? this.crouchHeight : this.eyeHeight;
    const prevPhase = this.stridePhase;
    this.stridePhase += (this.speed * dt) / this.strideLength * Math.PI;
    if (this.stridePhase > 1e6) this.stridePhase %= Math.PI * 2;
    if (Math.floor(this.stridePhase / Math.PI) !== Math.floor(prevPhase / Math.PI) && this.speed > 0.25) {
      // Footfall: a critically-damped kick, alternating sides.
      this.lastStepSide = -this.lastStepSide;
      this.stepKickVel -= clamp(this.speed / this.runSpeed, 0.2, 1) * 0.055;
    }
    // Spring the kick back to zero (k ~ 220 -> ~0.42 s settle).
    this.stepKickVel += (-this.stepKick * 220 - this.stepKickVel * 22) * dt;
    this.stepKick += this.stepKickVel * dt;

    const gait = clamp(this.speed / this.walkSpeed, 0, 3);
    const amp = this.bobAmount * Math.min(gait, 1.9);
    this.bobY = damp(this.bobY, -Math.cos(this.stridePhase * 2) * amp, 22, dt);
    this.bobX = damp(this.bobX, Math.sin(this.stridePhase) * amp * 0.55, 22, dt);

    // Lean into a strafe, and roll a hair with each footfall.
    const leanT = clamp(-strafe * 0.5, -1, 1) * 0.022 * Math.min(gait, 1);
    this.lean = damp(this.lean, leanT, 6, dt);

    // --- compose ----------------------------------------------------------
    const roll = this.lean + this.stepKick * 0.5 * this.lastStepSide;
    this._e.set(this.pitch + this.stepKick * 0.85, this.yaw, roll, 'YXZ');
    cam.quaternion.setFromEuler(this._e);

    cam.position.set(
      this.pos.x + this.bobX * -Math.cos(this.yaw),
      this.pos.y + eye + this.bobY,
      this.pos.z + this.bobX * Math.sin(this.yaw),
    );
  }

  /** Building collision if Physics offers it, terrain-only if not. */
  private move(ctx: Ctx, dx: number, dz: number): void {
    const phys = (ctx as unknown as { physics?: PhysicsLike }).physics;
    if (phys && typeof phys.moveCharacter === 'function') {
      try {
        const r = phys.moveCharacter(
          { x: this.pos.x, y: this.pos.y, z: this.pos.z },
          { x: dx, y: 0, z: dz },
          RADIUS,
          this.eyeHeight + 0.1,
        );
        if (r && Number.isFinite(r.x) && Number.isFinite(r.z)) {
          this.applyResolved(r.x, r.z, dx, dz);
          return;
        }
      } catch {
        /* physics still booting — fall through */
      }
    }

    const req = this.req;
    req.position.x = this.pos.x;
    req.position.y = this.pos.y;
    req.position.z = this.pos.z;
    req.delta.x = dx;
    req.delta.y = 0;
    req.delta.z = dz;
    req.radius = RADIUS;
    req.height = this.eyeHeight + 0.1;
    req.out.x = this.pos.x + dx;
    req.out.y = this.pos.y;
    req.out.z = this.pos.z + dz;
    req.grounded = true;
    req.handled = false;
    ctx.emit('physics:move-character', req);
    if (req.handled && Number.isFinite(req.out.x) && Number.isFinite(req.out.z)) {
      this.applyResolved(req.out.x, req.out.z, dx, dz);
      return;
    }

    this.pos.x += dx;
    this.pos.z += dz;
  }

  private applyResolved(x: number, z: number, dx: number, dz: number): void {
    const movedX = x - this.pos.x;
    const movedZ = z - this.pos.z;
    this.pos.x = x;
    this.pos.z = z;
    // Kill the component of velocity that got absorbed by a wall so we stop
    // pushing into it and slide along instead.
    const want = Math.hypot(dx, dz);
    const got = Math.hypot(movedX, movedZ);
    if (want > 1e-6 && got < want * 0.98) {
      const f = clamp(got / want, 0, 1);
      this.vel.x *= f;
      this.vel.z *= f;
    }
  }
}
