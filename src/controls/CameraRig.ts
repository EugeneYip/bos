import * as THREE from 'three';
import type { Ctx, WorldModule } from '../core/Context';

/** Orbit / fly / walk / drive camera modes with cinematic damping. */
export class CameraRig implements WorldModule {
  readonly name = 'CameraRig';
  private target = new THREE.Vector3(0, 30, 0);
  private theta = 0.9;
  private phi = 1.05;
  private radius = 900;
  private dragging = false;

  init(ctx: Ctx): void {
    const el = ctx.renderer.domElement;
    el.addEventListener('pointerdown', () => { this.dragging = true; });
    window.addEventListener('pointerup', () => { this.dragging = false; });
    window.addEventListener('pointermove', (e) => {
      if (!this.dragging) return;
      this.theta -= e.movementX * 0.004;
      this.phi = Math.min(1.52, Math.max(0.04, this.phi - e.movementY * 0.004));
    });
    el.addEventListener('wheel', (e) => {
      e.preventDefault();
      this.radius = Math.min(9000, Math.max(40, this.radius * (1 + Math.sign(e.deltaY) * 0.1)));
    }, { passive: false });
  }

  update(_dt: number, ctx: Ctx): void {
    const s = Math.sin(this.phi);
    ctx.camera.position.set(
      this.target.x + this.radius * s * Math.sin(this.theta),
      this.target.y + this.radius * Math.cos(this.phi),
      this.target.z + this.radius * s * Math.cos(this.theta),
    );
    ctx.camera.lookAt(this.target);
  }
}
