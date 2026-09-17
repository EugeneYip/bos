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
import { GRASS_CARD } from './textures';
import { LIFT as PARK_LIFT } from '../Parks';

/**
 * radius, spacing — denser close in, thinning out with distance.
 *
 * A grass card is GRASS_CARD across, so a spacing a little under that in the
 * first ring gives an almost closed mat immediately in front of the camera,
 * which is where the eye actually checks. Further out the park surface's own
 * albedo carries it and the cards only need to break the silhouette of the
 * ground plane.
 */
const GRASS_RINGS: [number, number][] = [[18, 0.34], [40, 0.90], [76, 2.0]];
const SHRUB_RADIUS = 130;
const SHRUB_SPACING = 8.5;
const REBUILD_MOVE = 7;

/**
 * Where the base of a tuft goes, relative to the terrain height.
 *
 * Every green polygon in the city is drawn by `Parks` as an explicit surface
 * laid `PARK_LIFT` (0.22 m) above the terrain, to clear the CDLOD morph.
 * Ground cover was planted at `sampleHeight - 0.03`, i.e. a quarter of a
 * metre *underneath* the ground you can actually see — and a mown-lawn tuft
 * is 0.19 m tall before its size jitter, so essentially every blade of grass
 * in Boston was buried. Measured: hiding `vegetation:grass` entirely changed
 * the lawn's high-frequency contrast at `common-street` by 0.07 of 6.55
 * points, and an 8x-amplified difference of the two frames over the whole
 * lawn was indistinguishable from TAA noise. Two thousand instances a frame,
 * drawing nothing.
 *
 * The 4 cm is the amount the base is sunk *into* that surface, so a tuft
 * reads as rooted rather than standing on the lawn. The classes ground cover
 * will plant on are a subset of the land-use kinds `Parks` draws, and the
 * triangle budget is not binding (160k of 220k), so a plantable cell is
 * effectively always a cell with a park surface over it.
 */
const GROUND_Y = PARK_LIFT - 0.04;

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

  build(
    ctx: Ctx, shared: SharedUniforms,
    grassMap: THREE.Texture, shrubMap: THREE.Texture,
    grassMean: number, shrubMean: number,
  ): void {
    if (!this.mask.ready) return;
    const budget = ctx.quality.treeBudget;
    this.grassCap = THREE.MathUtils.clamp(Math.round(budget * 0.34), 1200, 14000);
    this.bushCap = THREE.MathUtils.clamp(Math.round(budget * 0.045), 260, 2400);

    // Mown turf: olive, not emerald. A lawn's albedo has far more red in it
    // than a leaf's, and the ones that do not are golf simulators.
    const gm = createGroundMaterial('grass', grassMap, shared, 0x74853f, 0xa2913f, {
      sway: 2.4, alphaTest: 0.2, fadeOut: 86, turnBias: 0.5, canopy: 0.78,
      mapMean: grassMean,
    });
    gm.material.side = THREE.DoubleSide;
    this.mats.push(gm);

    const bm = createGroundMaterial('shrub', shrubMap, shared, 0x4e6c39, 0x96682f, {
      sway: 1.1, alphaTest: 0.3, fadeOut: 170, turnBias: 0.8, canopy: 0.72,
      mapMean: shrubMean,
    });
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
            // Mown lawn is thinner than rough park grass and woodland floor…
            let keep = cls === CLASS_LAWN ? 0.72 : cls === CLASS_FOREST ? 0.95 : 0.88;
            // …and the margin of a path is scuffed by everyone who ever cut
            // the corner. A lawn that runs to a kerb at full density is the
            // tell that nobody walks on it.
            //
            // Gentle, because the land mask is a 5 m raster: "edge distance 1"
            // means somewhere inside the first five metres, not the first one,
            // and on a park as path-riddled as the Common that band is most of
            // the lawn. At 0.34 it took the whole of Boston Common down to
            // eleven hundred tufts and the turf vanished.
            const edge = this.mask.edgeDistance(x, z, 2);
            if (edge <= 1) keep *= 0.62;
            else if (edge === 2) keep *= 0.86;
            if (hs > keep) continue;
            const y = sample(x, z);
            // Cards are authored at GRASS_CARD across (see `grassTexture`).
            // Taller and coarser as the ground gets rougher; a fraction larger
            // with distance so the mat still closes up once the spacing opens.
            const vary = 0.82 + 0.4 * hash2(i, j, 21);
            const grow = 1 + Math.sqrt(d2) * 0.004;
            const tall = cls === CLASS_LAWN ? 0.19 : cls === CLASS_FOREST ? 0.32 : 0.26;
            // On the park surface, not on the terrain under it. See GROUND_Y.
            this.p.set(x, y + GROUND_Y, z);
            this.q.setFromAxisAngle(this.up, hash2(i, j, 33) * Math.PI);
            const wide = GRASS_CARD * vary * grow;
            this.s.set(wide, tall * vary * grow, wide);
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
          this.p.set(x, y + GROUND_Y - 0.02, z);
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
