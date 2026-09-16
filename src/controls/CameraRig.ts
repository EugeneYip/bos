/**
 * CameraRig — every way of moving through the city.
 *
 * Modes: orbit (default), fly, walk, drive, cinematic. Each one owns its own
 * state and writes straight to `ctx.camera`; the rig decides *when* they run.
 *
 * ## The QA hold
 *
 * `window.__debug.setView()` emits `'debug-set-view'` before it moves the
 * camera. The rig hears that, suspends itself completely and does not touch
 * the camera again until real user input arrives. This is load-bearing: if the
 * rig overwrote the pose every frame, every screenshot the project produces
 * would be of the wrong place.
 *
 * ## Event contract
 *
 * Listens:
 *   `camera:set-mode`     ModeId
 *   `camera:fly-to`       FlyToRequest { pos, target, duration?, mode?, instant? }
 *   `camera:play-tour`    string | { id, speed?, hour? }
 *   `camera:pause-tour`   boolean | undefined (toggle)
 *   `camera:stop-tour`    —
 *   `camera:scrub-tour`   number 0..1
 *   `camera:tour-speed`   number
 *   `camera:query`        CameraStateRequest (mutable; filled in synchronously)
 *   `photo-mode`          boolean
 *   `debug-set-view`      (from core/debugApi)
 *
 * Emits:
 *   `camera:mode-changed`   { mode, previous }
 *   `camera:mode-rejected`  { mode, reason }
 *   `camera:tour-started`   { id, name, hour }
 *   `camera:tour-progress`  { id, t }         (~12 Hz)
 *   `camera:tour-ended`     { id }
 *   `camera:flyto-started`  { label }
 *   `camera:flyto-ended`    { label }
 *   `camera:suspended`      boolean
 *   `user-input`            — first genuine input after a QA hold
 */
import * as THREE from 'three';
import type { Ctx, WorldModule } from '../core/Context';
import { RENDER } from '../core/config';
import { Input } from './Input';
import { OrbitMode } from './OrbitMode';
import { FlyMode } from './FlyMode';
import { WalkMode } from './WalkMode';
import { DriveMode } from './DriveMode';
import { CinematicMode } from './CinematicMode';
import { findTour, TOURS, type Tour } from './tours';
import { MODE_IDS, type CameraMode, type FlyToRequest, type ModeId, type Vec3Tuple } from './types';
import { clamp, easeInOutCubic, headingDeg } from './math';
import { groundAt, pickTerrain } from './pick';

/** Mutable payload for the `camera:query` event. */
export interface CameraStateRequest {
  mode: ModeId;
  available: Record<ModeId, boolean>;
  /** m/s in the active mode (0 for orbit). */
  speed: number;
  /** Metres above local terrain. */
  altitude: number;
  ground: number;
  heading: number;
  tourId: string | null;
  tourName: string | null;
  tourProgress: number;
  tourPlaying: boolean;
  tourSpeed: number;
  photo: boolean;
  suspended: boolean;
  transitioning: boolean;
  /** Distance to whatever is at the centre of frame; -1 if unknown. */
  focusDistance: number;
  flySpeedScale: number;
  handled: boolean;
}

interface Transition {
  fromPos: THREE.Vector3;
  fromAim: THREE.Vector3;
  ctrl: THREE.Vector3;
  toPos: THREE.Vector3;
  toAim: THREE.Vector3;
  t: number;
  duration: number;
  mode: ModeId;
  label: string;
}

function toVec3(v: Vec3Tuple | THREE.Vector3, out: THREE.Vector3): THREE.Vector3 {
  if (Array.isArray(v)) return out.set(v[0], v[1], v[2]);
  return out.set(v.x, v.y, v.z);
}

export class CameraRig implements WorldModule {
  readonly name = 'CameraRig';

  private ctx!: Ctx;
  private input = new Input();
  private orbit = new OrbitMode();
  private fly = new FlyMode();
  private walk = new WalkMode();
  private drive = new DriveMode();
  private cine = new CinematicMode();
  private modes!: Record<ModeId, CameraMode>;

  private mode: ModeId = 'orbit';
  private modeBeforePhoto: ModeId = 'orbit';
  private photo = false;

  /** True while the QA harness (or anyone calling setView) owns the camera. */
  private suspended = false;
  private lastActivity = 0;
  private transition: Transition | null = null;
  private progressAccum = 0;
  private focusDistance = -1;
  private focusAccum = 0;

  private _a = new THREE.Vector3();
  private _b = new THREE.Vector3();
  private _c = new THREE.Vector3();
  private _d = new THREE.Vector3();
  private _fwd = new THREE.Vector3();

  init(ctx: Ctx): void {
    this.ctx = ctx;
    this.modes = {
      orbit: this.orbit,
      fly: this.fly,
      walk: this.walk,
      drive: this.drive,
      cinematic: this.cine,
    };

    const el = ctx.renderer.domElement;
    el.setAttribute('tabindex', '0');
    el.style.outline = 'none';
    this.input.attach(el);
    this.lastActivity = this.input.activity;

    this.cine.onEnd = (tour) => {
      ctx.emit('camera:tour-ended', { id: tour.id });
      // Hand control back so the camera is never left dead at the end.
      this.setMode('orbit', true);
    };

    // --- opening framing --------------------------------------------------
    // A high oblique from the north-west, over Somerville, looking south-east
    // down the Charles: the Zakim on the left, the Financial District front-lit
    // in the middle, Back Bay and the Prudential on the right, the harbour and
    // the islands behind.
    //
    // The direction matters more than the position. The default hour is 5:06 pm
    // in late September, when the sun sits about 18 degrees up in the
    // west-south-west, so this looks *with* the light: every facade in frame is
    // a lit one. The previous framing looked north-west, which put the sun just
    // outside the left edge and the whole city behind its aureole -- the model
    // read as fogbound on first sight when the air was actually set to 49 km
    // visibility.
    ctx.camera.position.set(-1900, 560, -2100);
    ctx.camera.lookAt(500, 30, 100);
    ctx.camera.updateMatrixWorld(true);
    this.orbit.enter(ctx);

    // --- QA hold ----------------------------------------------------------
    ctx.on('debug-set-view', () => this.suspend());

    window.addEventListener('keydown', this.onKeyDown);

    // --- commands ---------------------------------------------------------
    ctx.on('camera:set-mode', (p) => {
      if (typeof p === 'string' && (MODE_IDS as string[]).includes(p)) this.setMode(p as ModeId);
    });
    ctx.on('camera:fly-to', (p) => {
      if (p && typeof p === 'object') this.flyTo(p as FlyToRequest);
    });
    ctx.on('camera:play-tour', (p) => {
      const id = typeof p === 'string' ? p : (p as { id?: string } | undefined)?.id;
      const opts = (typeof p === 'object' && p ? p : {}) as { speed?: number };
      if (id) this.playTour(id, opts.speed);
    });
    ctx.on('camera:pause-tour', (p) => {
      const want = typeof p === 'boolean' ? p : !this.cine.playing;
      this.resumeIfSuspended();
      this.cine.setPlaying(want);
    });
    ctx.on('camera:stop-tour', () => {
      this.cine.stop();
      if (this.mode === 'cinematic') this.setMode('orbit', true);
    });
    ctx.on('camera:scrub-tour', (p) => {
      if (typeof p !== 'number') return;
      this.resumeIfSuspended();
      this.cine.setPlaying(false);
      this.cine.setProgress(p);
    });
    ctx.on('camera:tour-speed', (p) => {
      if (typeof p === 'number') this.cine.speed = clamp(p, 0.1, 6);
    });
    ctx.on('photo-mode', (p) => this.setPhoto(p !== false));

    // --- state query ------------------------------------------------------
    ctx.on('camera:query', (p) => {
      const r = p as CameraStateRequest | undefined;
      if (!r || typeof r !== 'object') return;
      this.fillState(r);
    });
  }

  /** Mode hotkeys 1–5. Ignored while typing or interacting with the HUD. */
  private onKeyDown = (e: KeyboardEvent): void => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const t = e.target as HTMLElement | null;
    if (t?.closest?.('input, textarea, select, [contenteditable="true"], [data-hud-root]')) return;
    const i = MODE_IDS.findIndex((_, n) => e.code === `Digit${n + 1}`);
    if (i >= 0) this.setMode(MODE_IDS[i]);
  };

  // ------------------------------------------------------------------ state

  private fillState(r: CameraStateRequest): void {
    const ctx = this.ctx;
    const cam = ctx.camera;
    r.mode = this.mode;
    r.available = {
      orbit: true,
      fly: true,
      walk: true,
      drive: this.drive.available(ctx),
      cinematic: true,
    };
    r.speed =
      this.mode === 'fly' ? this.fly.speed
      : this.mode === 'walk' ? this.walk.speed
      : this.mode === 'drive' ? this.drive.speed
      : 0;
    r.ground = groundAt(ctx, cam.position.x, cam.position.z);
    r.altitude = cam.position.y - r.ground;
    cam.getWorldDirection(this._fwd);
    r.heading = headingDeg(this._fwd);
    r.tourId = this.cine.tour?.id ?? null;
    r.tourName = this.cine.tour?.name ?? null;
    r.tourProgress = this.cine.t;
    r.tourPlaying = this.cine.playing;
    r.tourSpeed = this.cine.speed;
    r.photo = this.photo;
    r.suspended = this.suspended;
    r.transitioning = this.transition !== null;
    r.focusDistance = this.focusDistance;
    r.flySpeedScale = this.fly.speedScale;
    r.handled = true;
  }

  // ------------------------------------------------------------- suspension

  private suspend(): void {
    if (this.transition) {
      this.transition = null;
      this.ctx.emit('camera:flyto-ended', { label: '' });
    }
    this.cine.setPlaying(false);
    if (this.ctx.camera.fov !== RENDER.fov) {
      this.ctx.camera.fov = RENDER.fov;
      this.ctx.camera.updateProjectionMatrix();
    }
    if (!this.suspended) {
      this.suspended = true;
      this.ctx.emit('camera:suspended', true);
    }
  }

  /** Called the moment genuine user input arrives after a QA hold. */
  private resumeIfSuspended(): void {
    if (!this.suspended) return;
    this.suspended = false;
    // Cinematic with nothing playing would leave a dead camera — hand back to
    // orbit so the first drag does something.
    if (this.mode === 'cinematic' && !this.cine.playing) this.mode = 'orbit';
    this.modes[this.mode].enter(this.ctx, this.input);
    this.ctx.emit('camera:suspended', false);
    this.ctx.emit('user-input');
  }

  // ------------------------------------------------------------------ modes

  setMode(next: ModeId, silent = false): void {
    if (!(MODE_IDS as string[]).includes(next)) return;
    const m = this.modes[next];
    if (m.available && !m.available(this.ctx)) {
      this.ctx.emit('camera:mode-rejected', {
        mode: next,
        reason: m.unavailableReason ?? 'Unavailable',
      });
      return;
    }
    if (next === this.mode) return;
    const previous = this.mode;
    this.resumeIfSuspended();
    this.modes[previous].exit?.(this.ctx);
    if (previous === 'cinematic') this.cine.stop();
    if (previous === 'fly' || previous === 'walk') this.input.releaseLock();
    this.mode = next;
    m.enter(this.ctx, this.input);
    this.ctx.emit('camera:mode-changed', { mode: next, previous, silent });
  }

  private setPhoto(on: boolean): void {
    if (on === this.photo) return;
    this.photo = on;
    if (on) {
      this.modeBeforePhoto = this.mode;
      this.cine.setPlaying(false);
      if (this.mode !== 'fly') this.setMode('fly', true);
      // Photo mode wants slow, deliberate movement.
      this.fly.speedScale = 0.32;
    } else {
      this.fly.speedScale = 1;
      if (this.modeBeforePhoto !== this.mode) this.setMode(this.modeBeforePhoto, true);
    }
  }

  // -------------------------------------------------------------- fly-to

  flyTo(req: FlyToRequest): void {
    const ctx = this.ctx;
    this.resumeIfSuspended();
    this.cine.setPlaying(false);

    const toPos = toVec3(req.pos, new THREE.Vector3());
    const toAim = toVec3(req.target, new THREE.Vector3());
    let mode = req.mode ?? this.mode;
    if (mode === 'cinematic') mode = 'orbit';
    if (mode === 'drive' && !this.drive.available(ctx)) mode = 'orbit';

    if (req.instant) {
      ctx.camera.position.copy(toPos);
      ctx.camera.up.set(0, 1, 0);
      ctx.camera.lookAt(toAim);
      ctx.camera.updateMatrixWorld(true);
      this.landOn(mode);
      return;
    }

    const fromPos = ctx.camera.position.clone();
    ctx.camera.getWorldDirection(this._fwd);
    const fromAim = fromPos.clone().addScaledVector(this._fwd, Math.max(fromPos.distanceTo(toPos) * 0.4, 60));

    const dist = fromPos.distanceTo(toPos);
    const duration = req.duration ?? clamp(1.0 + dist / 950, 1.15, 4.6);

    // Arc over the city rather than ploughing through it: lift the control
    // point above the highest terrain between here and there.
    const ctrl = fromPos.clone().add(toPos).multiplyScalar(0.5);
    let maxGround = 0;
    for (let i = 1; i < 12; i++) {
      const f = i / 12;
      const x = fromPos.x + (toPos.x - fromPos.x) * f;
      const z = fromPos.z + (toPos.z - fromPos.z) * f;
      maxGround = Math.max(maxGround, groundAt(ctx, x, z));
    }
    ctrl.y = Math.max(ctrl.y + Math.min(dist * 0.17, 620), maxGround + 70);

    this.transition = {
      fromPos,
      fromAim,
      ctrl,
      toPos,
      toAim,
      t: 0,
      duration,
      mode,
      label: req.label ?? '',
    };
    ctx.emit('camera:flyto-started', { label: this.transition.label });
  }

  private landOn(mode: ModeId): void {
    if (mode !== this.mode) {
      const previous = this.mode;
      this.modes[previous].exit?.(this.ctx);
      this.mode = mode;
      this.ctx.emit('camera:mode-changed', { mode, previous });
    }
    this.modes[this.mode].enter(this.ctx, this.input);
  }

  // --------------------------------------------------------------- tours

  playTour(id: string, speed?: number): void {
    const tour: Tour | undefined = findTour(id) ?? TOURS[0];
    if (!tour) return;
    this.resumeIfSuspended();
    if (this.mode !== 'cinematic') {
      const previous = this.mode;
      this.modes[previous].exit?.(this.ctx);
      if (previous === 'fly' || previous === 'walk') this.input.releaseLock();
      this.mode = 'cinematic';
      this.cine.enter(this.ctx);
      this.ctx.emit('camera:mode-changed', { mode: 'cinematic', previous });
    }
    if (speed !== undefined) this.cine.speed = clamp(speed, 0.1, 6);
    this.cine.load(tour, this.ctx);
    this.ctx.emit('camera:tour-started', { id: tour.id, name: tour.name, hour: tour.hour });
  }

  // --------------------------------------------------------------- update

  update(dt: number, ctx: Ctx): void {
    const input = this.input;

    // Any genuine user input releases the QA hold and cancels a fly-to.
    if (input.activity !== this.lastActivity) {
      this.lastActivity = input.activity;
      if (this.suspended) {
        this.resumeIfSuspended();
      } else if (this.transition) {
        this.transition = null;
        ctx.emit('camera:flyto-ended', { label: '' });
        this.modes[this.mode].enter(ctx, input);
      }
    }

    if (this.suspended) {
      input.endFrame();
      return;
    }

    if (this.transition) {
      this.stepTransition(dt, ctx);
      input.endFrame();
      return;
    }

    // Click-to-lock in the first-person modes.
    if (input.clicked && (this.mode === 'fly' || this.mode === 'walk') && !input.pointerLocked) {
      input.requestLock();
    }

    this.modes[this.mode].update(dt, ctx, input);

    // Throttled tour progress for the HUD scrubber.
    if (this.mode === 'cinematic' && this.cine.playing) {
      this.progressAccum += dt;
      if (this.progressAccum > 1 / 12) {
        this.progressAccum = 0;
        ctx.emit('camera:tour-progress', { id: this.cine.tour?.id ?? null, t: this.cine.t });
      }
    }

    // Centre-of-frame distance, for the photo-mode "focus here" control.
    if (this.photo) {
      this.focusAccum += dt;
      if (this.focusAccum > 0.12) {
        this.focusAccum = 0;
        const hit = pickTerrain(ctx, 0, 0, 24000, this._d);
        this.focusDistance = hit ? hit.distanceTo(ctx.camera.position) : -1;
      }
    } else {
      this.focusDistance = -1;
    }

    input.endFrame();
  }

  private stepTransition(dt: number, ctx: Ctx): void {
    const tr = this.transition;
    if (!tr) return;
    tr.t = Math.min(tr.t + dt / tr.duration, 1);
    const e = easeInOutCubic(tr.t);

    // Quadratic Bezier for position, straight lerp for the aim point.
    const inv = 1 - e;
    this._a.copy(tr.fromPos).multiplyScalar(inv * inv);
    this._b.copy(tr.ctrl).multiplyScalar(2 * inv * e);
    this._c.copy(tr.toPos).multiplyScalar(e * e);
    this._a.add(this._b).add(this._c);

    const floor = groundAt(ctx, this._a.x, this._a.z) + 3;
    if (this._a.y < floor) this._a.y = floor;

    this._b.lerpVectors(tr.fromAim, tr.toAim, e);

    ctx.camera.position.copy(this._a);
    ctx.camera.up.set(0, 1, 0);
    ctx.camera.lookAt(this._b);

    if (tr.t >= 1) {
      const { mode, label } = tr;
      this.transition = null;
      ctx.camera.position.copy(tr.toPos);
      ctx.camera.lookAt(tr.toAim);
      ctx.camera.updateMatrixWorld(true);
      this.landOn(mode);
      ctx.emit('camera:flyto-ended', { label });
    }
  }

  dispose(): void {
    window.removeEventListener('keydown', this.onKeyDown);
    this.input.releaseLock();
    this.input.dispose();
  }
}
