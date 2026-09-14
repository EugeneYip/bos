import * as THREE from 'three';
import type { Ctx, WorldModule } from '../core/Context';

/** Heightfield ground surface with blended land-cover materials. */
export class Terrain implements WorldModule {
  readonly name = 'Terrain';
  async init(ctx: Ctx): Promise<void> {
    const g = new THREE.PlaneGeometry(14000, 14000, 1, 1);
    g.rotateX(-Math.PI / 2);
    const m = new THREE.MeshStandardMaterial({ color: 0x51553f, roughness: 0.96, metalness: 0 });
    const mesh = new THREE.Mesh(g, m);
    mesh.receiveShadow = true;
    mesh.name = 'terrain-placeholder';
    ctx.scene.add(mesh);
    ctx.sampleHeight = () => 0;
  }
}
