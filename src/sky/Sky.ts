import * as THREE from 'three';
import type { Ctx, WorldModule } from '../core/Context';

/** Physical sky, sun/moon, clouds, and the IBL environment probe. */
export class Sky implements WorldModule {
  readonly name = 'Sky';
  private hemi?: THREE.HemisphereLight;
  private sun?: THREE.DirectionalLight;

  init(ctx: Ctx): void {
    ctx.scene.background = new THREE.Color(0x9dc4e8);
    ctx.scene.fog = new THREE.Fog(0xaecbe4, 900, 12000);
    this.hemi = new THREE.HemisphereLight(0xbcd8f5, 0x6b6154, 1.1);
    ctx.scene.add(this.hemi);
    this.sun = new THREE.DirectionalLight(0xfff2e0, 2.6);
    this.sun.position.copy(ctx.sun.direction).multiplyScalar(3000);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(ctx.quality.shadowMapSize, ctx.quality.shadowMapSize);
    const c = this.sun.shadow.camera;
    c.left = -900; c.right = 900; c.top = 900; c.bottom = -900; c.near = 100; c.far = 6000;
    c.updateProjectionMatrix();
    ctx.scene.add(this.sun);
    ctx.scene.add(this.sun.target);
  }

  update(_dt: number, ctx: Ctx): void {
    if (!this.sun) return;
    this.sun.position.copy(ctx.sun.direction).multiplyScalar(3000).add(ctx.camera.position.clone().setY(0));
    this.sun.target.position.copy(ctx.camera.position).setY(0);
    this.sun.target.updateMatrixWorld();
  }
}
