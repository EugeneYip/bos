/**
 * Damped orbit around a focus point — the default way to look at the city.
 *
 * Feel notes:
 *  - Rotation is target-driven with exponential smoothing, plus release
 *    inertia, so a flick spins the city and settles rather than stopping dead.
 *  - Dolly is multiplicative (`radius *= exp(-notches * k)`), which makes the
 *    zoom rate automatically proportional to distance-to-target: one notch
 *    always covers the same *fraction* of the remaining distance whether you
 *    are 40 m or 8 km out.
 *  - Zoom is anchored to the cursor: the world point under the pointer stays
 *    under the pointer, which is what every DCC app does and what makes
 *    navigating dense geometry feel precise.
 */
import * as THREE from 'three';
import type { Ctx } from '../core/Context';
import type { CameraMode } from './types';
import type { Input } from './Input';
import { clamp, damp, dampVec3, decay } from './math';
import { groundAt, pickGroundOrPlane, pickTerrain } from './pick';

const MIN_RADIUS = 9;
const MAX_RADIUS = 15000;
const MIN_POLAR = 0.045; // ~2.6° off straight-down
const MAX_POLAR = 1.5533; // ~89°, never under the horizon
const CLEARANCE = 2.4; // metres the camera keeps above terrain

export class OrbitMode implements CameraMode {
  readonly id = 'orbit' as const;

  // Smoothed state (what the camera actually uses).
  private theta = 2.38;
  private phi = 1.02;
  private radius = 1750;
  private focus = new THREE.Vector3(-260, 30, 60);

  // Desired state (what input writes to).
  private thetaT = this.theta;
  private phiT = this.phi;
  private radiusT = this.radius;
  private focusT = this.focus.clone();

  // Release inertia, rad/s.
  private spinX = 0;
  private spinY = 0;

  private groundY = 0;
  private _v = new THREE.Vector3();
  private _p = new THREE.Vector3();

  // Feel parameters -------------------------------------------------------
  rotateSpeed = 0.0044; // rad per CSS pixel
  rotateDamping = 12;
  inertiaDamping = 3.1; // how fast a fling dies
  inertiaScale = 0.00042; // px/s -> rad/s
  zoomSpeed = 0.17; // e-folds per notch
  zoomDamping = 10;
  panDamping = 15;

  enter(ctx: Ctx): void {
    this.adopt(ctx);
    this.spinX = 0;
    this.spinY = 0;
  }

  sync(ctx: Ctx): void {
    this.adopt(ctx);
  }

  /** Rebuild orbit state from the live camera pose without moving anything. */
  private adopt(ctx: Ctx): void {
    const cam = ctx.camera;
    cam.updateMatrixWorld();
    cam.getWorldDirection(this._v);
    const ground = groundAt(ctx, cam.position.x, cam.position.z);
    const altitude = Math.max(cam.position.y - ground, 1);

    // Pivot on whatever the centre of frame is actually looking at, so an
    // externally-set view (QA harness, fly-to) orbits around its own subject.
    const hit = pickTerrain(ctx, 0, 0, 24000, this._p);
    let dist: number;
    if (hit) {
      dist = clamp(hit.distanceTo(cam.position), MIN_RADIUS, MAX_RADIUS);
    } else {
      dist = clamp(altitude * 3.2, 60, 4000);
    }
    this._p.copy(cam.position).addScaledVector(this._v, dist);
    this.focus.copy(this._p);
    this.focusT.copy(this._p);

    const off = this._v.copy(cam.position).sub(this.focus);
    this.radius = clamp(off.length(), MIN_RADIUS, MAX_RADIUS);
    this.radiusT = this.radius;
    this.phi = clamp(Math.acos(clamp(off.y / this.radius, -1, 1)), MIN_POLAR, MAX_POLAR);
    this.phiT = this.phi;
    this.theta = Math.atan2(off.x, off.z);
    this.thetaT = this.theta;
  }

  /** Used by the rig for fly-to landings so the orbit pivot is sensible. */
  setFocus(focus: THREE.Vector3, radius: number, theta: number, phi: number): void {
    this.focus.copy(focus);
    this.focusT.copy(focus);
    this.radius = this.radiusT = clamp(radius, MIN_RADIUS, MAX_RADIUS);
    this.theta = this.thetaT = theta;
    this.phi = this.phiT = clamp(phi, MIN_POLAR, MAX_POLAR);
  }

  update(dt: number, ctx: Ctx, input: Input): void {
    const cam = ctx.camera;
    const h = ctx.renderer.domElement.clientHeight || window.innerHeight;

    // --- rotate -----------------------------------------------------------
    if (input.rotateX || input.rotateY) {
      this.thetaT -= input.rotateX * this.rotateSpeed;
      this.phiT = clamp(this.phiT - input.rotateY * this.rotateSpeed * 0.82, MIN_POLAR, MAX_POLAR);
      this.spinX = 0;
      this.spinY = 0;
    }
    // Keyboard nudge for accessibility (arrow keys orbit).
    const kx = input.axis(['ArrowLeft'], ['ArrowRight']);
    const ky = input.axis(['ArrowUp'], ['ArrowDown']);
    if (kx || ky) {
      this.thetaT -= kx * 1.1 * dt;
      this.phiT = clamp(this.phiT + ky * 0.8 * dt, MIN_POLAR, MAX_POLAR);
    }

    if (input.flingReady) {
      this.spinX = -input.flingX * this.inertiaScale;
      this.spinY = -input.flingY * this.inertiaScale * 0.82;
    }
    if (!input.dragging && (this.spinX !== 0 || this.spinY !== 0)) {
      this.thetaT += this.spinX * dt;
      this.phiT = clamp(this.phiT + this.spinY * dt, MIN_POLAR, MAX_POLAR);
      this.spinX = decay(this.spinX, this.inertiaDamping, dt);
      this.spinY = decay(this.spinY, this.inertiaDamping, dt);
      if (Math.abs(this.spinX) < 1e-4) this.spinX = 0;
      if (Math.abs(this.spinY) < 1e-4) this.spinY = 0;
    }

    // --- dolly ------------------------------------------------------------
    if (input.zoom !== 0) {
      const prev = this.radiusT;
      this.radiusT = clamp(this.radiusT * Math.exp(-input.zoom * this.zoomSpeed), MIN_RADIUS, MAX_RADIUS);
      const ratio = this.radiusT / prev;
      if (input.hasZoomAnchor && Math.abs(ratio - 1) > 1e-4) {
        // Zoom-to-cursor: keep the world point under the pointer fixed by
        // sliding the pivot along the line between it and the old pivot.
        const nx = input.zoomAnchorX * 2 - 1;
        const ny = -(input.zoomAnchorY * 2 - 1);
        const hit = pickGroundOrPlane(ctx, nx, ny, this.focusT.y, this._p);
        if (hit) {
          const maxPull = this.radiusT * 6;
          if (hit.distanceToSquared(this.focusT) < maxPull * maxPull) {
            this.focusT.lerpVectors(hit, this.focusT, ratio);
          }
        }
      }
    }
    const kz = input.axis(['Minus', 'NumpadSubtract'], ['Equal', 'NumpadAdd']);
    if (kz) this.radiusT = clamp(this.radiusT * Math.exp(-kz * 1.4 * dt), MIN_RADIUS, MAX_RADIUS);

    // --- pan --------------------------------------------------------------
    if (input.panX || input.panY) {
      const vfov = (cam.fov * Math.PI) / 180;
      const perPixel = (2 * Math.tan(vfov / 2) * this.radiusT) / h;
      cam.getWorldDirection(this._v);
      const fx = this._v.x;
      const fz = this._v.z;
      let flen = Math.hypot(fx, fz);
      let fwdX: number;
      let fwdZ: number;
      if (flen < 1e-3) {
        // Looking straight down: screen-up is the camera's own up vector.
        this._v.set(0, 1, 0).applyQuaternion(cam.quaternion);
        flen = Math.hypot(this._v.x, this._v.z) || 1;
        fwdX = this._v.x / flen;
        fwdZ = this._v.z / flen;
      } else {
        fwdX = fx / flen;
        fwdZ = fz / flen;
      }
      // right = forward x up  (world up = +Y)
      const rightX = -fwdZ;
      const rightZ = fwdX;
      this.focusT.x += (-input.panX * rightX + input.panY * fwdX) * perPixel;
      this.focusT.z += (-input.panX * rightZ + input.panY * fwdZ) * perPixel;
      // Keep the pivot glued to the ground so panning across hills feels flat.
      this.focusT.y = groundAt(ctx, this.focusT.x, this.focusT.z) + 18;
    }

    // --- integrate --------------------------------------------------------
    this.theta = damp(this.theta, this.thetaT, this.rotateDamping, dt);
    this.phi = damp(this.phi, this.phiT, this.rotateDamping, dt);
    this.radius = damp(this.radius, this.radiusT, this.zoomDamping, dt);
    dampVec3(this.focus, this.focusT, this.panDamping, dt);

    const sp = Math.sin(this.phi);
    this._p.set(
      this.focus.x + this.radius * sp * Math.sin(this.theta),
      this.focus.y + this.radius * Math.cos(this.phi),
      this.focus.z + this.radius * sp * Math.cos(this.theta),
    );

    // Ground clamp: slide along the terrain rather than punching through it.
    const g = groundAt(ctx, this._p.x, this._p.z);
    this.groundY = damp(this.groundY, g, 14, dt);
    const floor = this.groundY + CLEARANCE;
    if (this._p.y < floor) {
      this._p.y = floor;
      // Push the desired polar angle back up so we don't fight the clamp.
      const flat = Math.hypot(this._p.x - this.focus.x, this._p.z - this.focus.z);
      const dy = floor - this.focus.y;
      if (flat > 0.01) this.phiT = Math.min(this.phiT, Math.atan2(flat, dy));
    }

    cam.position.copy(this._p);
    cam.up.set(0, 1, 0);
    cam.lookAt(this.focus);
  }

  /** Distance from the camera to the pivot — used for HUD readouts. */
  get distance(): number {
    return this.radius;
  }
}
