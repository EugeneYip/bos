/**
 * Grass, shrubs and hedges inside the city's green areas.
 *
 * A park that is bare ground with trees standing on it is the second loudest
 * tell of a procedural city (the first is the trees). But there is no budget
 * to place a million grass tufts, and no reason to: only the ones you can see
 * matter.
 *
 * So nothing is stored. Every time the camera has moved far enough, the module
 * walks a set of concentric, distance-thinned jittered grids around it, asks
 * the land mask whether each sample is plantable, and writes the survivors
 * straight into two instanced meshes. The sample pattern is a pure function of
 * world position, so a tuft does not jump when the camera moves — it just
 * appears and disappears at the edge of the window, under a distance fade.
 */
import * as THREE from 'three';
import type { Ctx } from '../../core/Context';
import { grassTuft, shrubClump } from './geometry';
import { createGroundMaterial, type SharedUniforms, type VegMaterial } from './material';
import { CLASS_FOREST, CLASS_LAWN, LandMask } from './landmask';

/** radius, spacing — denser close in, thinning out with distance. */
const GRASS_RINGS: [number, number][] = [[20, 0.62], [44, 1.35], [80, 2.7]];
const SHRUB_RADIUS = 130;
const SHRUB_SPACING = 8.5;
const REBUILD_MOVE = 9;

function hash2(x: number, z: number, salt: number): number {
  let h = Math.imul(x | 0, 73856093) ^ Math.imul(z | 0, 19349663) ^ Math.imul(salt, 83492791);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

export class GroundCover {
  private grass?: THREE.InstancedMesh;
  private bush?: THREE.InstancedMesh;
  private mats: VegMaterial[] = [];
  private last = new THREE.Vector3(1e9, 1e9, 1e9);
  private grassCap = 0;
  private bushCap = 0;
  drawnGrass = 0;
  drawnBush = 0;

  private m = new THREE.Matrix4();
  private q = new THREE.Quaternion();
  private up = new THREE.Vector3(0, 1, 0);
  private p = new THREE.Vector3();
  private s = new THREE.Vector3();

  constructor(
    private mask: LandMask,
    private root: THREE.Group,
  ) {}

  build(ctx: Ctx, shared: SharedUniforms, grassMap: THREE.Texture, shrubMap: THREE.Texture): void {
    if (!this.mask.ready) return;
    const budget = ctx.quality.treeBudget;
    this.grassCap = THREE.MathUtils.clamp(Math.round(budget * 0.22), 1500, 13000);
    this.bushCap = THREE.MathUtils.clamp(Math.round(budget * 0.035), 260, 2000);

    const gm = createGroundMaterial('grass', grassMap, shared, 0x7d9349, 0xa89a4e, {
      sway: 2.6, alphaTest: 0.34, fadeOut: 96, turnBias: 0.55,
    });
    gm.material.alphaTest = 0.34;
    gm.material.side = THREE.DoubleSide;
    this.mats.push(gm);

    const bm = createGroundMaterial('shrub', shrubMap, shared, 0x55763c, 0x9c6c35, {
      sway: 1.1, alphaTest: 0.4, fadeOut: 170, turnBias: 0.8,
    });
    bm.material.alphaTest = 0.4;
    this.mats.push(bm);

    this.grass = new THREE.InstancedMesh(grassTuft(3), gm.material, this.grassCap);
    this.grass.name = 'vegetation:grass';
    this.grass.frustumCulled = false;
    this.grass.userData.noShadow = true;
    this.grass.castShadow = false;
    this.grass.receiveShadow = true;
    this.grass.count = 0;
    this.root.add(this.grass);

    this.bush = new THREE.InstancedMesh(shrubClump(11, 1.0, 5150), bm.material, this.bushCap);
    this.bush.name = 'vegetation:shrubs';
    this.bush.frustumCulled = false;
    this.bush.userData.noShadow = true;
    this.bush.castShadow = true;
    this.bush.receiveShadow = true;
    this.bush.count = 0;
    this.root.add(this.bush);
  }

  needsRebuild(cam: THREE.Vector3): boolean {
    return !!this.grass && cam.distanceToSquared(this.last) > REBUILD_MOVE * REBUILD_MOVE;
  }

  invalidate(): void {
    this.last.set(1e9, 1e9, 1e9);
  }

  rebuild(ctx: Ctx): void {
    const grass = this.grass;
    const bush = this.bush;
    if (!grass || !bush) return;
    const cam = ctx.camera.position;
    const sample = ctx.sampleHeight;

    // Above roof height there is no point drawing 40 cm of grass.
    const ground = sample(cam.x, cam.z);
    const alt = cam.y - ground;
    const grassOn = alt < 130;

    let g = 0;
    if (grassOn) {
      let inner = 0;
      for (const [radius, spacing] of GRASS_RINGS) {
        const i0 = Math.floor((cam.x - radius) / spacing);
        const i1 = Math.ceil((cam.x + radius) / spacing);
        const j0 = Math.floor((cam.z - radius) / spacing);
        const j1 = Math.ceil((cam.z + radius) / spacing);
        const r2 = radius * radius;
        const in2 = inner * inner;
        for (let j = j0; j <= j1 && g < this.grassCap; j++) {
          for (let i = i0; i <= i1 && g < this.grassCap; i++) {
            const hx = hash2(i, j, 5);
            const hz = hash2(i, j, 9);
            const x = (i + hx) * spacing;
            const z = (j + hz) * spacing;
            const dx = x - cam.x, dz = z - cam.z;
            const d2 = dx * dx + dz * dz;
            if (d2 > r2 || d2 <= in2) continue;
            const cls = this.mask.plantable(x, z);
            if (!cls) continue;
            const hs = hash2(i, j, 13);
            // Mown lawn is thinner than rough park grass and woodland floor.
            const keep = cls === CLASS_LAWN ? 0.55 : cls === CLASS_FOREST ? 0.92 : 0.78;
            if (hs > keep) continue;
            const y = sample(x, z);
            const scale = (0.30 + 0.30 * hash2(i, j, 21)) * (1 + Math.sqrt(d2) * 0.006);
            this.p.set(x, y - 0.04, z);
            this.q.setFromAxisAngle(this.up, hash2(i, j, 33) * Math.PI);
            this.s.set(scale * 1.5, scale * (cls === CLASS_LAWN ? 0.8 : 1.15), scale * 1.5);
            this.m.compose(this.p, this.q, this.s);
            grass.setMatrixAt(g++, this.m);
          }
        }
        inner = radius;
      }
    }
    grass.count = g;
    grass.instanceMatrix.needsUpdate = true;
    this.drawnGrass = g;

    // --- shrubs and hedge runs ---------------------------------------------
    let b = 0;
    if (alt < 260) {
      const sp = SHRUB_SPACING;
      const i0 = Math.floor((cam.x - SHRUB_RADIUS) / sp);
      const i1 = Math.ceil((cam.x + SHRUB_RADIUS) / sp);
      const j0 = Math.floor((cam.z - SHRUB_RADIUS) / sp);
      const j1 = Math.ceil((cam.z + SHRUB_RADIUS) / sp);
      const r2 = SHRUB_RADIUS * SHRUB_RADIUS;
      for (let j = j0; j <= j1 && b < this.bushCap; j++) {
        for (let i = i0; i <= i1 && b < this.bushCap; i++) {
          const x = (i + hash2(i, j, 71)) * sp;
          const z = (j + hash2(i, j, 73)) * sp;
          const dx = x - cam.x, dz = z - cam.z;
          if (dx * dx + dz * dz > r2) continue;
          const cls = this.mask.plantable(x, z);
          if (!cls) continue;
          const edge = this.mask.edgeDistance(x, z, 3);
          const hedge = edge <= 2;
          const gate = hedge ? 0.72 : cls === CLASS_FOREST ? 0.45 : 0.16;
          if (hash2(i, j, 77) > gate) continue;

          const y = ctx.sampleHeight(x, z);
          let yaw = hash2(i, j, 79) * Math.PI * 2;
          let w = 1.1 + 1.1 * hash2(i, j, 83);
          let h = 1.0 + 0.7 * hash2(i, j, 89);
          if (hedge) {
            // Line the run up with the boundary so it reads as a clipped hedge.
            const gx = (this.mask.plantable(x + 6, z) ? 1 : 0) - (this.mask.plantable(x - 6, z) ? 1 : 0);
            const gz = (this.mask.plantable(x, z + 6) ? 1 : 0) - (this.mask.plantable(x, z - 6) ? 1 : 0);
            yaw = Math.atan2(gz, gx) + Math.PI * 0.5;
            w = 3.2;
            h = 0.85 + 0.25 * hash2(i, j, 97);
          }
          this.p.set(x, y - 0.05, z);
          this.q.setFromAxisAngle(this.up, yaw);
          this.s.set(w, h, hedge ? 1.1 : w * 0.92);
          this.m.compose(this.p, this.q, this.s);
          bush.setMatrixAt(b++, this.m);
        }
      }
    }
    bush.count = b;
    bush.instanceMatrix.needsUpdate = true;
    this.drawnBush = b;

    this.last.copy(cam);
  }

  dispose(): void {
    for (const m of [this.grass, this.bush]) {
      if (!m) continue;
      m.geometry.dispose();
      this.root.remove(m);
    }
    for (const m of this.mats) m.material.dispose();
    this.mats.length = 0;
  }
}
