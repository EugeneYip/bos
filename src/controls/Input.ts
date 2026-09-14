/**
 * Unified pointer / touch / keyboard / wheel input for the camera rig.
 *
 * Everything is accumulated between frames and consumed once per `update()`,
 * so a 144 Hz mouse and a 30 Hz frame produce the same total rotation. Deltas
 * are in CSS pixels; zoom is in normalised "notches" (one mouse-wheel detent
 * ≈ 1.0) so every mode can apply its own sensitivity.
 *
 * Gesture mapping
 *   mouse   left-drag = rotate, right/middle-drag or shift+left = pan, wheel = zoom
 *   trackpad two-finger scroll = pan-ish zoom, pinch (ctrl+wheel) = zoom
 *   touch   one finger = rotate, two fingers = pinch zoom + centroid pan
 */
import { clamp } from './math';

export type DragKind = 'none' | 'rotate' | 'pan';

interface PointerRec {
  id: number;
  x: number;
  y: number;
  button: number;
}

function isTypingTarget(e: Event): boolean {
  const t = e.target as HTMLElement | null;
  if (!t || !t.closest) return false;
  return !!t.closest('input, textarea, select, button, a, [contenteditable="true"], [data-hud-root]');
}

export class Input {
  /** Physical key codes currently held (KeyW, ShiftLeft, …). */
  readonly keys = new Set<string>();

  /** Accumulated rotate-drag, CSS pixels. */
  rotateX = 0;
  rotateY = 0;
  /** Accumulated pan-drag, CSS pixels. */
  panX = 0;
  panY = 0;
  /** Accumulated zoom in notches; positive = move closer. */
  zoom = 0;
  /** Viewport-relative cursor position at the time of the last zoom event. */
  zoomAnchorX = 0.5;
  zoomAnchorY = 0.5;
  hasZoomAnchor = false;

  /** Fling velocity at the moment the last rotate-drag ended, px/s. */
  flingX = 0;
  flingY = 0;
  /** True on the frame a rotate-drag ended. */
  flingReady = false;

  /** True for one frame after a clean click (press + release, no drag). */
  clicked = false;
  /** Viewport-relative (0..1) position of that click. */
  clickX = 0.5;
  clickY = 0.5;

  /** Bumped by every genuine user input; the rig uses it to leave QA-hold. */
  activity = 0;
  /** True while any pointer is pressed on the canvas. */
  dragging = false;
  dragKind: DragKind = 'none';
  pointerLocked = false;
  /** Number of active touch/pen/mouse contacts. */
  get contacts(): number {
    return this.pointers.size;
  }

  private pointers = new Map<number, PointerRec>();
  private lastCentroid = { x: 0, y: 0 };
  private lastSpread = 0;
  private el!: HTMLElement;
  private wantsLock = false;
  private lockPending = false;
  private lastMoveTime = 0;
  private velX = 0;
  private velY = 0;
  private downX = 0;
  private downY = 0;
  private downTime = 0;
  private movedFar = false;
  private disposers: Array<() => void> = [];

  attach(el: HTMLElement): void {
    this.el = el;
    const on = <K extends keyof WindowEventMap>(
      t: EventTarget,
      type: K | string,
      fn: (e: never) => void,
      opts?: AddEventListenerOptions,
    ): void => {
      t.addEventListener(type, fn as EventListener, opts);
      this.disposers.push(() => t.removeEventListener(type, fn as EventListener, opts));
    };

    on(el, 'pointerdown', this.onPointerDown);
    on(window, 'pointermove', this.onPointerMove, { passive: true });
    on(window, 'pointerup', this.onPointerUp);
    on(window, 'pointercancel', this.onPointerUp);
    on(el, 'wheel', this.onWheel, { passive: false });
    on(el, 'contextmenu', (e: Event) => e.preventDefault());
    on(window, 'keydown', this.onKeyDown);
    on(window, 'keyup', this.onKeyUp);
    on(window, 'blur', this.onBlur);
    on(document, 'pointerlockchange', this.onLockChange);
    on(document, 'pointerlockerror', this.onLockError);
  }

  dispose(): void {
    for (const d of this.disposers) d();
    this.disposers = [];
    this.keys.clear();
    this.pointers.clear();
  }

  // ---------------------------------------------------------------- queries

  key(code: string): boolean {
    return this.keys.has(code);
  }

  /** 1 if `pos` held, -1 if `neg` held, 0 otherwise (both cancel out). */
  axis(neg: string[], pos: string[]): number {
    let v = 0;
    for (const k of pos) if (this.keys.has(k)) { v += 1; break; }
    for (const k of neg) if (this.keys.has(k)) { v -= 1; break; }
    return v;
  }

  get shift(): boolean {
    return this.keys.has('ShiftLeft') || this.keys.has('ShiftRight');
  }

  get ctrl(): boolean {
    return this.keys.has('ControlLeft') || this.keys.has('ControlRight');
  }

  /** Called by the rig once per frame after every mode has read the deltas. */
  endFrame(): void {
    this.rotateX = 0;
    this.rotateY = 0;
    this.panX = 0;
    this.panY = 0;
    this.zoom = 0;
    this.hasZoomAnchor = false;
    this.flingReady = false;
    this.clicked = false;
  }

  // ------------------------------------------------------------ pointerlock

  requestLock(): void {
    if (this.pointerLocked || this.lockPending) return;
    this.wantsLock = true;
    this.lockPending = true;
    try {
      const r = this.el.requestPointerLock() as unknown as Promise<void> | undefined;
      // Chrome 113+ returns a promise; a rejection here is routine (the user
      // pressed Esc a moment ago) and must not surface as a console error.
      if (r && typeof r.then === 'function') r.then(() => {}, () => { this.lockPending = false; });
    } catch {
      this.lockPending = false;
    }
  }

  releaseLock(): void {
    this.wantsLock = false;
    this.lockPending = false;
    if (document.pointerLockElement) {
      try { document.exitPointerLock(); } catch { /* already gone */ }
    }
  }

  private onLockChange = (): void => {
    this.pointerLocked = document.pointerLockElement === this.el;
    this.lockPending = false;
    if (!this.pointerLocked) this.wantsLock = false;
  };

  private onLockError = (): void => {
    this.pointerLocked = false;
    this.lockPending = false;
    this.wantsLock = false;
  };

  // --------------------------------------------------------------- handlers

  private onPointerDown = (e: PointerEvent): void => {
    if (isTypingTarget(e)) return;
    this.el.focus?.();
    this.pointers.set(e.pointerId, { id: e.pointerId, x: e.clientX, y: e.clientY, button: e.button });
    try { this.el.setPointerCapture(e.pointerId); } catch { /* not capturable */ }
    this.dragging = true;
    this.activity++;
    this.velX = 0;
    this.velY = 0;
    this.lastMoveTime = performance.now();
    this.downX = e.clientX;
    this.downY = e.clientY;
    this.downTime = this.lastMoveTime;
    this.movedFar = false;

    if (this.pointers.size === 2) {
      this.resetGestureBaseline();
      this.dragKind = 'pan';
    } else {
      const pan = e.button === 1 || e.button === 2 || (e.button === 0 && e.shiftKey);
      this.dragKind = pan ? 'pan' : 'rotate';
    }
    if (e.button === 2 || e.button === 1) e.preventDefault();
  };

  private onPointerMove = (e: PointerEvent): void => {
    if (this.pointerLocked) {
      const dx = e.movementX || 0;
      const dy = e.movementY || 0;
      if (dx || dy) {
        this.rotateX += dx;
        this.rotateY += dy;
        this.activity++;
      }
      return;
    }

    const rec = this.pointers.get(e.pointerId);
    if (!rec) return;

    const now = performance.now();
    const dtMs = Math.max(now - this.lastMoveTime, 1);
    this.lastMoveTime = now;

    const dx = e.clientX - rec.x;
    const dy = e.clientY - rec.y;
    rec.x = e.clientX;
    rec.y = e.clientY;
    if (Math.hypot(e.clientX - this.downX, e.clientY - this.downY) > 6) this.movedFar = true;

    if (this.pointers.size >= 2) {
      this.handleGesture();
      this.activity++;
      return;
    }

    if (this.dragKind === 'pan') {
      this.panX += dx;
      this.panY += dy;
    } else {
      this.rotateX += dx;
      this.rotateY += dy;
      // Track instantaneous velocity for release inertia (px/s, smoothed).
      const vx = (dx / dtMs) * 1000;
      const vy = (dy / dtMs) * 1000;
      const a = 0.35;
      this.velX = this.velX * (1 - a) + vx * a;
      this.velY = this.velY * (1 - a) + vy * a;
    }
    this.activity++;
  };

  private onPointerUp = (e: PointerEvent): void => {
    if (!this.pointers.has(e.pointerId)) return;
    this.pointers.delete(e.pointerId);
    try { this.el.releasePointerCapture(e.pointerId); } catch { /* fine */ }

    if (this.pointers.size === 0) {
      const now = performance.now();
      if (!this.movedFar && now - this.downTime < 320 && e.button === 0) {
        this.clicked = true;
        this.setZoomAnchor(e.clientX, e.clientY);
        this.clickX = this.zoomAnchorX;
        this.clickY = this.zoomAnchorY;
        this.hasZoomAnchor = false;
      }
      if (this.dragKind === 'rotate' && performance.now() - this.lastMoveTime < 90) {
        this.flingX = clamp(this.velX, -4000, 4000);
        this.flingY = clamp(this.velY, -4000, 4000);
        this.flingReady = true;
      }
      this.dragging = false;
      this.dragKind = 'none';
      this.velX = 0;
      this.velY = 0;
    } else {
      // 2 -> 1 finger: re-baseline so the remaining finger doesn't jump.
      this.resetGestureBaseline();
      this.dragKind = this.pointers.size === 1 ? 'rotate' : 'pan';
    }
    this.activity++;
  };

  private onWheel = (e: WheelEvent): void => {
    if (isTypingTarget(e)) return;
    e.preventDefault();
    // deltaMode: 0 px, 1 line, 2 page.
    const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 400 : 1;
    let notches = (-e.deltaY * unit) / 100;
    // macOS pinch arrives as ctrl+wheel with small deltas; scale it up so a
    // pinch feels like a pinch rather than a very slow scroll.
    if (e.ctrlKey) notches *= 2.6;
    this.zoom += clamp(notches, -4, 4);
    this.setZoomAnchor(e.clientX, e.clientY);
    this.activity++;
  };

  private onKeyDown = (e: KeyboardEvent): void => {
    if (isTypingTarget(e)) return;
    if (e.metaKey) return; // leave browser shortcuts alone
    this.keys.add(e.code);
    this.activity++;
    // Stop the page scrolling / zooming out from under the canvas.
    if (
      e.code.startsWith('Arrow') ||
      e.code === 'Space' ||
      e.code === 'PageUp' ||
      e.code === 'PageDown'
    ) e.preventDefault();
  };

  private onKeyUp = (e: KeyboardEvent): void => {
    this.keys.delete(e.code);
  };

  private onBlur = (): void => {
    this.keys.clear();
    this.pointers.clear();
    this.dragging = false;
    this.dragKind = 'none';
  };

  // --------------------------------------------------------------- gestures

  private resetGestureBaseline(): void {
    const pts = [...this.pointers.values()];
    if (pts.length < 2) {
      if (pts.length === 1) this.lastCentroid = { x: pts[0].x, y: pts[0].y };
      this.lastSpread = 0;
      return;
    }
    this.lastCentroid = { x: (pts[0].x + pts[1].x) / 2, y: (pts[0].y + pts[1].y) / 2 };
    this.lastSpread = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
  }

  private handleGesture(): void {
    const pts = [...this.pointers.values()];
    if (pts.length < 2) return;
    const cx = (pts[0].x + pts[1].x) / 2;
    const cy = (pts[0].y + pts[1].y) / 2;
    const spread = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);

    this.panX += cx - this.lastCentroid.x;
    this.panY += cy - this.lastCentroid.y;

    if (this.lastSpread > 8 && spread > 8) {
      // log-ratio keeps pinch symmetric: doubling and halving move the same
      // distance in opposite directions.
      this.zoom += clamp(Math.log(spread / this.lastSpread) * 3.2, -4, 4);
      this.setZoomAnchor(cx, cy);
    }

    this.lastCentroid = { x: cx, y: cy };
    this.lastSpread = spread;
  }

  private setZoomAnchor(clientX: number, clientY: number): void {
    const r = this.el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) return;
    this.zoomAnchorX = clamp((clientX - r.left) / r.width, 0, 1);
    this.zoomAnchorY = clamp((clientY - r.top) / r.height, 0, 1);
    this.hasZoomAnchor = true;
  }
}
