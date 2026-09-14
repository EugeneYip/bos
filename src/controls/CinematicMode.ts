/**
 * Spline-driven cinematic camera.
 *
 * Waypoints become a centripetal Catmull-Rom curve (centripetal avoids the
 * cusps and self-intersections a uniform spline produces when keys bunch up).
 * `getPointAt` gives arc-length parameterisation, so the camera holds a
 * constant *spatial* speed rather than racing through widely-spaced keys — and
 * a small velocity LUT eases in and out at the ends.
 *
 * The look-at point rides its own spline and is damped a touch more slowly
 * than the position, which reads as a human operator panning rather than a
 * turret snapping onto a target.
 */
import * as THREE from 'three';
import type { Ctx } from '../core/Context';
import type { CameraMode } from './types';
import type { Input } from './Input';
import { lonLatToWorld } from '../core/geo';
import { clamp, damp, dampVec3, smoothstep, wrapPi } from './math';
import { groundAt } from './pick';
import { lookToWorld, type Tour } from './tours';

const LUT_N = 256;

export class CinematicMode implements CameraMode {
  readonly id = 'cinematic' as const;

  tour: Tour | null = null;
  playing = false;
  /** Normalised progress 0..1. */
  t = 0;
  speed = 1;

  onProgress: ((t: number, tour: Tour | null) => void) | null = null;
  onEnd: ((tour: Tour) => void) | null = null;

  private curve: THREE.CatmullRomCurve3 | null = null;
  private lookCurve: THREE.CatmullRomCurve3 | null = null;
  private lut = new Float32Array(LUT_N + 1);
  private pos = new THREE.Vector3();
  private aim = new THREE.Vector3();
  private roll = 0;
  private prevYaw = 0;
  private hasPrevYaw = false;
  private _p = new THREE.Vector3();
  private _a = new THREE.Vector3();
  private _e = new THREE.Euler(0, 0, 0, 'YXZ');
  private _m = new THREE.Matrix4();
  private _up = new THREE.Vector3(0, 1, 0);
  private _rollQ = new THREE.Quaternion();

  // Feel parameters -------------------------------------------------------
  posDamping = 16;
  aimDamping = 7;
  bankGain = 0.5;
  maxBank = 0.13;
  easeFraction = 0.14;

  enter(ctx: Ctx): void {
    this.pos.copy(ctx.camera.position);
    ctx.camera.getWorldDirection(this._a);
    this.aim.copy(ctx.camera.position).addScaledVector(this._a, 120);
    this.hasPrevYaw = false;
    this.roll = 0;
  }

  sync(ctx: Ctx): void {
    this.pos.copy(ctx.camera.position);
  }

  /** Build the splines for `tour` and start from the top. */
  load(tour: Tour, ctx: Ctx): void {
    const pts: THREE.Vector3[] = [];
    const looks: THREE.Vector3[] = [];
    for (const key of tour.keys) {
      const [x, z] = lonLatToWorld(key.lon, key.lat);
      pts.push(new THREE.Vector3(x, groundAt(ctx, x, z) + key.agl, z));
      const [lx, ly, lz] = lookToWorld(key);
      looks.push(new THREE.Vector3(lx, ly, lz));
    }
    if (pts.length < 2) return;

    const loop = tour.loop === true;
    this.curve = new THREE.CatmullRomCurve3(pts, loop, 'centripetal', 0.5);
    this.lookCurve = new THREE.CatmullRomCurve3(looks, loop, 'centripetal', 0.5);
    this.buildLut(loop);
    this.tour = tour;
    this.t = 0;
    this.playing = true;
    this.hasPrevYaw = false;
    this.roll = 0;
    // Snap to the first frame so the tour starts from its own opening shot.
    this.sample(0, this.pos, this.aim);
  }

  stop(): void {
    this.playing = false;
  }

  setPlaying(on: boolean): void {
    if (!this.curve) return;
    this.playing = on;
  }

  /** Scrub; used by the HUD timeline. */
  setProgress(t: number): void {
    this.t = clamp(t, 0, 1);
    if (this.curve) this.sample(this.t, this.pos, this.aim);
  }

  private buildLut(loop: boolean): void {
    const e = loop ? 0 : this.easeFraction;
    const dt = 1 / LUT_N;
    let acc = 0;
    this.lut[0] = 0;
    for (let i = 0; i < LUT_N; i++) {
      const t = (i + 0.5) * dt;
      // Velocity profile: ramp up over the first `e`, down over the last `e`,
      // never quite to zero so the shot never fully stalls.
      const w = loop ? 1 : Math.max(smoothstep(0, e, t) * smoothstep(1, 1 - e, t), 0.07);
      acc += w * dt;
      this.lut[i + 1] = acc;
    }
    if (acc > 0) for (let i = 0; i <= LUT_N; i++) this.lut[i] /= acc;
  }

  /** time 0..1 -> arc-length parameter 0..1 */
  private uFromT(t: number): number {
    const x = clamp(t, 0, 1) * LUT_N;
    const i = Math.min(Math.floor(x), LUT_N - 1);
    const f = x - i;
    return this.lut[i] + (this.lut[i + 1] - this.lut[i]) * f;
  }

  private sample(t: number, outPos: THREE.Vector3, outAim: THREE.Vector3): void {
    if (!this.curve || !this.lookCurve) return;
    const u = clamp(this.uFromT(t), 0, 1);
    this.curve.getPointAt(u, outPos);
    this.lookCurve.getPointAt(u, outAim);
  }

  update(dt: number, ctx: Ctx, input: Input): void {
    const cam = ctx.camera;

    if (this.curve && this.lookCurve) {
      const dur = Math.max(this.tour?.duration ?? 40, 1);
      if (this.playing) {
        this.t += (dt * this.speed) / dur;
        if (this.t >= 1) {
          if (this.tour?.loop) {
            this.t %= 1;
          } else {
            this.t = 1;
            this.playing = false;
            if (this.tour) this.onEnd?.(this.tour);
          }
        }
        this.onProgress?.(this.t, this.tour);
      }
      this.sample(this.t, this._p, this._a);

      // Never let a path clip a hill the terrain grew under it.
      const floor = groundAt(ctx, this._p.x, this._p.z) + 5;
      if (this._p.y < floor) this._p.y = floor;

      dampVec3(this.pos, this._p, this.posDamping, dt);
      dampVec3(this.aim, this._a, this.aimDamping, dt);
    }

    // Bank into turns from the rate of change of heading.
    this._p.copy(this.aim).sub(this.pos);
    const yaw = Math.atan2(this._p.x, this._p.z);
    let bank = 0;
    if (this.hasPrevYaw && dt > 1e-5) {
      const rate = wrapPi(yaw - this.prevYaw) / dt;
      bank = clamp(rate * this.bankGain, -this.maxBank, this.maxBank);
    }
    this.prevYaw = yaw;
    this.hasPrevYaw = true;
    this.roll = damp(this.roll, bank, 3.2, dt);

    cam.position.copy(this.pos);
    cam.up.set(0, 1, 0);
    this._m.lookAt(this.pos, this.aim, this._up);
    cam.quaternion.setFromRotationMatrix(this._m);
    if (this.roll !== 0) {
      this._e.set(0, 0, this.roll, 'XYZ');
      cam.quaternion.multiply(this._rollQ.setFromEuler(this._e));
    }
    void input;
  }
}
