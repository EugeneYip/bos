import * as THREE from 'three';
import type { Ctx, WorldModule } from '../core/Context';
import type { AreaRecord, PropSet, RoadRecord } from '../core/types';
import { loadAreas, loadProps, loadRoads } from '../core/data';
import { SPECIES, autumnFactor } from './vegetation/species';
import { buildTreeLods, midCardMeters, type TreeGeometry } from './vegetation/geometry';
import { createSharedUniforms, createVegMaterial, type Lod, type SharedUniforms } from './vegetation/material';
import { buildTextures, disposeTextures, type VegTextures } from './vegetation/textures';
import { LandMask } from './vegetation/landmask';
import { buildTreeField, type TreeField } from './vegetation/placement';
import { GroundCover } from './vegetation/groundcover';

/**
 * Boston's 88 226 trees, plus the grass, shrubs and hedge lines underneath
 * them.
 *
 * ## Tiers
 *
 * Every tree is always present as an **impostor** — crossed billboards plus a
 * horizontal canopy card, carrying a painted silhouette of its own species.
 * Those are written once at load and never touched again, and they are split
 * into a 4x4 grid of regional meshes so the renderer can frustum-cull whole
 * districts instead of transforming the entire city every frame.
 *
 * The trees nearest the camera are *additionally* drawn with real geometry —
 * a branch armature plus alpha-tested foliage cards (`vegetation/geometry.ts`)
 * — in a **near** and a **mid** tier whose instance buffers are refilled only
 * when the camera has moved far enough to matter. All three tiers cross-fade
 * against each other with a screen-door dither, so nothing pops, nothing is
 * alpha-blended, and no buffer churn lands on the frame budget.
 *
 * Refilling walks a CSR spatial grid in order of increasing distance, so a
 * rebuild touches a few thousand trees rather than all 88 000, and the nearest
 * trees win the budget when it runs out.
 *
 * ## Draw calls
 *
 * Bark and foliage need different materials (one opaque, one alpha-tested), so
 * each tier's geometry carries two groups and one `InstancedMesh` issues two
 * draws. That is 6 species x 2 tiers x 2 roles = 24 for the detailed tiers,
 * plus whichever impostor tiles are on screen, plus two for ground cover.
 */

const REBUILD_MOVE = 28;

interface Tier {
  mesh: THREE.InstancedMesh;
  materials: THREE.Material[];
}

interface SpeciesTier {
  near: Tier;
  mid: Tier;
  far: Tier[];
  nearCap: number;
  midCap: number;
}

/** Tier reach, metres. The near tier has to cover a street; the mid, a park. */
const NEAR_RADIUS = 145;
const MID_RADIUS = 300;
const FADE_BAND = 30;
const GRID_CELL = 64;
const FAR_TILES = 4;

export class Vegetation implements WorldModule {
  readonly name = 'Vegetation';

  private root = new THREE.Group();
  private tiers: SpeciesTier[] = [];
  private field?: TreeField;
  private mask = new LandMask();
  private textures?: VegTextures;
  private shared: SharedUniforms = createSharedUniforms();
  private ground?: GroundCover;

  /** CSR spatial index over every tree. */
  private gx = 0;
  private gz = 0;
  private gMinX = 0;
  private gMinZ = 0;
  private cellStart = new Int32Array(0);
  private cellItems = new Uint32Array(0);
  /** (di, dj) cell offsets within MID_RADIUS, sorted near to far. */
  private cellOrder = new Int32Array(0);

  private lastRebuild = new THREE.Vector3(1e9, 1e9, 1e9);
  private nearTotal = 0;
  private midTotal = 0;
  private drawnNear = 0;
  private drawnMid = 0;
  private buildMs = 0;
  private updateMs = 0;

  async init(ctx: Ctx): Promise<void> {
    this.root.name = 'vegetation';
    ctx.scene.add(this.root);
    const t0 = performance.now();

    let sets: PropSet[] = [];
    let areas: AreaRecord[] = [];
    let roads: RoadRecord[] = [];
    try {
      [sets, areas, roads] = await Promise.all([loadProps(), loadAreas(), loadRoads()]);
    } catch (err) {
      console.warn('[Vegetation] data unavailable; skipping', err);
      return;
    }
    if (!sets.some((s) => s.kind === 'tree')) return;

    const tMask = performance.now();
    this.mask.build(areas, roads);
    const tField = performance.now();

    this.field = buildTreeField(sets, {
      mask: this.mask,
      sampleHeight: ctx.sampleHeight,
      infill: true,
      clump: true,
    });
    const field = this.field;
    const tTex = performance.now();

    const aniso = Math.min(ctx.quality.anisotropy, ctx.renderer.capabilities.getMaxAnisotropy());
    const hiRes = ctx.tier === 'high' || ctx.tier === 'ultra';
    this.textures = buildTextures(SPECIES, aniso, hiRes, SPECIES.map(midCardMeters));
    const tex = this.textures;
    console.info('[VegDiag] mean', JSON.stringify({
      bark: [...tex.mean.bark.entries()], leaf: tex.mean.leaf.map((v) => +v.toFixed(3)),
      clump: tex.mean.clump.map((v) => +v.toFixed(3)),
      imp: tex.mean.impostor.map((v) => +v.toFixed(3)),
      grass: tex.mean.grass, shrub: tex.mean.shrub,
    }));
    const tGeo = performance.now();

    this.buildGrid(field);

    // Tier budgets. Near geometry is ~430 triangles a tree and mid ~80, so the
    // near tier is deliberately the smaller of the two.
    const budget = ctx.quality.treeBudget;
    this.nearTotal = THREE.MathUtils.clamp(Math.round(budget * 0.05), 400, 2600);
    this.midTotal = THREE.MathUtils.clamp(Math.round(budget * 0.16), 1600, 9000);
    const nearCap = Math.ceil((this.nearTotal / SPECIES.length) * 1.9);
    const midCap = Math.ceil((this.midTotal / SPECIES.length) * 1.9);

    let tris = 0;
    for (let s = 0; s < SPECIES.length; s++) {
      const sp = SPECIES[s];
      const lods = buildTreeLods(sp, 1009 + s * 7717);
      tris += lods.near.triangles;

      const near = this.makeTier(ctx, s, lods.near, 'near', nearCap);
      const mid = this.makeTier(ctx, s, lods.mid, 'mid', midCap);
      const far = this.makeFarTiles(ctx, s, lods.far);
      this.tiers.push({ near, mid, far, nearCap, midCap });
      // Yield so the loading bar keeps painting while the crowns are built.
      await new Promise((r) => setTimeout(r, 0));
    }

    this.ground = new GroundCover(this.mask, this.root);
    this.ground.build(ctx, this.shared, tex.grass, tex.shrub, tex.mean.grass, tex.mean.shrub);

    this.shared.season.value = autumnFactor(ctx.dayOfYear);
    this.rebuild(ctx);
    this.ground.rebuild(ctx);

    this.buildMs = performance.now() - t0;
    ctx.stats.trees = field.count;
    console.info(
      `[Vegetation] ${field.count} trees (${field.stats.street} street, ${field.stats.park} park, `
      + `${field.stats.forest} woodland, ${field.stats.lawn} lawn, +${field.stats.infill} infill), `
      + `${this.mask.greenCells} green cells, near≤${this.nearTotal} mid≤${this.midTotal}, `
      + `${Math.round(tris / SPECIES.length)} tris/near tree | `
      + `load ${(tMask - t0) | 0}ms mask ${(tField - tMask) | 0}ms place ${(tTex - tField) | 0}ms `
      + `tex ${(tGeo - tTex) | 0}ms geo+mesh ${(performance.now() - tGeo) | 0}ms`,
    );

    ctx.on('quality-changed', () => {
      this.lastRebuild.set(1e9, 1e9, 1e9);
      this.ground?.invalidate();
    });
  }

  // -------------------------------------------------------------------------

  private materialsFor(ctx: Ctx, s: number, lod: Lod, tg: TreeGeometry): THREE.Material[] {
    const sp = SPECIES[s];
    const tex = this.textures!;
    // Every tree lives in exactly one of near/mid, so those two never need to
    // fade against each other — only against the impostor, which holds *all*
    // of them. Hence: near and mid are simply on; the impostor fades in over
    // the last band of the mid tier's reach, with the complementary dither.
    const fade = {
      near: { in: -1e6, out: 1e9 },
      mid: { in: -1e6, out: MID_RADIUS },
      far: { in: MID_RADIUS - FADE_BAND, out: 1e9 },
    }[lod];

    // Each tier gets art authored for its own card size: near cards carry
    // life-size leaves, mid cards carry a 4 m clump of them with the form
    // lighting baked in, and the impostor carries the whole tree.
    const map = lod === 'far' ? tex.impostor[s] : lod === 'mid' ? tex.clump[s] : tex.leaf[s];
    const mapMean = lod === 'far' ? tex.mean.impostor[s]
      : lod === 'mid' ? tex.mean.clump[s] : tex.mean.leaf[s];

    const leaf = createVegMaterial({
      species: sp,
      lod,
      role: 'leaf',
      map,
      shared: this.shared,
      fadeIn: fade.in,
      fadeOut: fade.out,
      fadeBand: FADE_BAND,
      envMapIntensity: lod === 'far' ? 1.5 : 1.15,
      canopy: lod === 'far' ? 0.26 : 0.42,
      mapMean,
    }).material;
    void ctx;

    if (!tg.twoGroups) return [leaf];

    const bark = createVegMaterial({
      species: sp,
      lod,
      role: 'bark',
      map: tex.bark.get(sp.bark)!,
      shared: this.shared,
      fadeIn: fade.in,
      fadeOut: fade.out,
      fadeBand: FADE_BAND,
      envMapIntensity: 1.3,
      // A trunk stands under its own crown. Nothing in the renderer knows
      // that, and its screen-space occlusion assumes the worst, so without a
      // skylight floor every trunk on the Common is a black post. Measured on
      // the Commonwealth Avenue Mall, 0.85 still left the elm boles at nine of
      // 255 with two thirds of their pixels below the grade pass's grain
      // floor, i.e. no bark at all.
      canopy: 1.3,
      mapMean: tex.mean.bark.get(sp.bark),
    }).material;
    return [bark, leaf];
  }

  private makeTier(ctx: Ctx, s: number, tg: TreeGeometry, lod: Lod, capacity: number): Tier {
    const materials = this.materialsFor(ctx, s, lod, tg);
    const mesh = new THREE.InstancedMesh(
      tg.geometry,
      materials.length === 1 ? materials[0] : materials,
      capacity,
    );
    mesh.name = `trees:${SPECIES[s].name}:${lod}`;
    mesh.frustumCulled = false; // budgeted by distance instead
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    mesh.count = 0;
    mesh.userData.noShadow = true;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    this.root.add(mesh);
    return { mesh, materials };
  }

  /**
   * Impostors, split into a 4x4 grid of regional meshes. One mesh holding all
   * 88 000 would have a city-sized bounding sphere and could never be culled;
   * split, the renderer skips every district behind the camera.
   */
  private makeFarTiles(ctx: Ctx, s: number, tg: TreeGeometry): Tier[] {
    const field = this.field!;
    const idx = field.bySpecies[s];
    const materials = this.materialsFor(ctx, s, 'far', tg);

    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (let i = 0; i < field.count; i++) {
      if (field.px[i] < minX) minX = field.px[i];
      if (field.px[i] > maxX) maxX = field.px[i];
      if (field.pz[i] < minZ) minZ = field.pz[i];
      if (field.pz[i] > maxZ) maxZ = field.pz[i];
    }
    const spanX = Math.max(1, maxX - minX);
    const spanZ = Math.max(1, maxZ - minZ);
    const tileOf = (i: number): number => {
      const tx = Math.min(FAR_TILES - 1, Math.floor(((field.px[i] - minX) / spanX) * FAR_TILES));
      const tz = Math.min(FAR_TILES - 1, Math.floor(((field.pz[i] - minZ) / spanZ) * FAR_TILES));
      return tz * FAR_TILES + tx;
    };

    const counts = new Int32Array(FAR_TILES * FAR_TILES);
    for (let k = 0; k < idx.length; k++) counts[tileOf(idx[k])]++;

    const out: Tier[] = [];
    const cursor = new Int32Array(FAR_TILES * FAR_TILES);
    const meshes: (THREE.InstancedMesh | null)[] = new Array(FAR_TILES * FAR_TILES).fill(null);
    for (let t = 0; t < counts.length; t++) {
      if (!counts[t]) continue;
      const mesh = new THREE.InstancedMesh(
        tg.geometry,
        materials.length === 1 ? materials[0] : materials,
        counts[t],
      );
      mesh.name = `trees:${SPECIES[s].name}:far:${t}`;
      mesh.userData.noShadow = true;
      mesh.castShadow = false;
      mesh.receiveShadow = true;
      mesh.count = counts[t];
      meshes[t] = mesh;
      this.root.add(mesh);
      out.push({ mesh, materials });
    }

    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const p = new THREE.Vector3();
    const sc = new THREE.Vector3();
    for (let k = 0; k < idx.length; k++) {
      const i = idx[k];
      const t = tileOf(i);
      const mesh = meshes[t];
      if (!mesh) continue;
      const h = field.height[i];
      const w = field.width[i] * h;
      p.set(field.px[i], field.py[i], field.pz[i]);
      sc.set(w, h, w);
      // No yaw: the shader spins the billboard to face the camera itself, and
      // an instance rotation would fight it.
      m.compose(p, q, sc);
      mesh.setMatrixAt(cursor[t]++, m);
    }
    for (const mesh of meshes) {
      if (!mesh) continue;
      mesh.instanceMatrix.needsUpdate = true;
      mesh.computeBoundingSphere();
    }
    return out;
  }

  // -------------------------------------------------------------------------

  private buildGrid(field: TreeField): void {
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (let i = 0; i < field.count; i++) {
      if (field.px[i] < minX) minX = field.px[i];
      if (field.px[i] > maxX) maxX = field.px[i];
      if (field.pz[i] < minZ) minZ = field.pz[i];
      if (field.pz[i] > maxZ) maxZ = field.pz[i];
    }
    this.gMinX = minX;
    this.gMinZ = minZ;
    this.gx = Math.max(1, Math.ceil((maxX - minX) / GRID_CELL) + 1);
    this.gz = Math.max(1, Math.ceil((maxZ - minZ) / GRID_CELL) + 1);

    const n = this.gx * this.gz;
    const counts = new Int32Array(n + 1);
    const cellOf = (i: number): number => {
      const ci = Math.min(this.gx - 1, Math.max(0, ((field.px[i] - minX) / GRID_CELL) | 0));
      const cj = Math.min(this.gz - 1, Math.max(0, ((field.pz[i] - minZ) / GRID_CELL) | 0));
      return cj * this.gx + ci;
    };
    for (let i = 0; i < field.count; i++) counts[cellOf(i) + 1]++;
    for (let c = 0; c < n; c++) counts[c + 1] += counts[c];
    this.cellStart = counts;
    this.cellItems = new Uint32Array(field.count);
    const cursor = counts.slice(0, n);
    for (let i = 0; i < field.count; i++) this.cellItems[cursor[cellOf(i)]++] = i;

    // Cell offsets covering the mid radius, visited nearest first so the
    // budget always goes to the trees you can actually see.
    const reach = Math.ceil(MID_RADIUS / GRID_CELL) + 1;
    const offs: { d: number; di: number; dj: number }[] = [];
    for (let dj = -reach; dj <= reach; dj++) {
      for (let di = -reach; di <= reach; di++) {
        const d = Math.hypot(Math.max(0, Math.abs(di) - 1), Math.max(0, Math.abs(dj) - 1)) * GRID_CELL;
        if (d > MID_RADIUS) continue;
        offs.push({ d, di, dj });
      }
    }
    offs.sort((a, b) => a.d - b.d);
    this.cellOrder = new Int32Array(offs.length * 2);
    for (let k = 0; k < offs.length; k++) {
      this.cellOrder[k * 2] = offs[k].di;
      this.cellOrder[k * 2 + 1] = offs[k].dj;
    }
  }

  private static _m = new THREE.Matrix4();
  private static _q = new THREE.Quaternion();
  private static _qt = new THREE.Quaternion();
  private static _up = new THREE.Vector3(0, 1, 0);
  private static _ax = new THREE.Vector3();
  private static _p = new THREE.Vector3();
  private static _s = new THREE.Vector3();

  /**
   * One species is one mesh, so every red maple on the Common is the same
   * geometry. Yaw alone does not hide that — but a tree leans, and a few
   * degrees of lean about a random axis, different for every individual, does.
   */
  private write(field: TreeField, mesh: THREE.InstancedMesh, slot: number, i: number): void {
    const h = field.height[i];
    const w = field.width[i] * h;
    Vegetation._p.set(field.px[i], field.py[i], field.pz[i]);
    Vegetation._q.setFromAxisAngle(Vegetation._up, field.rot[i]);
    const tilt = field.tilt[i];
    if (tilt !== 0) {
      const a = field.tiltAz[i];
      Vegetation._ax.set(Math.cos(a), 0, Math.sin(a));
      Vegetation._qt.setFromAxisAngle(Vegetation._ax, tilt);
      Vegetation._q.premultiply(Vegetation._qt);
    }
    Vegetation._s.set(w, h, w);
    Vegetation._m.compose(Vegetation._p, Vegetation._q, Vegetation._s);
    mesh.setMatrixAt(slot, Vegetation._m);
  }

  /** Refill the near and mid tiers with the trees closest to the camera. */
  private rebuild(ctx: Ctx): void {
    const field = this.field;
    if (!field) return;
    const cam = ctx.camera.position;
    const ci = Math.floor((cam.x - this.gMinX) / GRID_CELL);
    const cj = Math.floor((cam.z - this.gMinZ) / GRID_CELL);

    const nearN = new Int32Array(SPECIES.length);
    const midN = new Int32Array(SPECIES.length);
    let nearLeft = this.nearTotal;
    let midLeft = this.midTotal;
    const nearR2 = NEAR_RADIUS * NEAR_RADIUS;
    const midR2 = MID_RADIUS * MID_RADIUS;

    for (let k = 0; k < this.cellOrder.length && (nearLeft > 0 || midLeft > 0); k += 2) {
      const i = ci + this.cellOrder[k];
      const j = cj + this.cellOrder[k + 1];
      if (i < 0 || j < 0 || i >= this.gx || j >= this.gz) continue;
      const c = j * this.gx + i;
      const end = this.cellStart[c + 1];
      for (let e = this.cellStart[c]; e < end; e++) {
        const t = this.cellItems[e];
        const dx = field.px[t] - cam.x;
        const dz = field.pz[t] - cam.z;
        const d2 = dx * dx + dz * dz;
        if (d2 > midR2) continue;
        const s = field.species[t];
        const tier = this.tiers[s];
        if (d2 < nearR2 && nearLeft > 0 && nearN[s] < tier.nearCap) {
          this.write(field, tier.near.mesh, nearN[s]++, t);
          nearLeft--;
        } else if (midLeft > 0 && midN[s] < tier.midCap) {
          this.write(field, tier.mid.mesh, midN[s]++, t);
          midLeft--;
        }
      }
    }

    this.drawnNear = 0;
    this.drawnMid = 0;
    for (let s = 0; s < SPECIES.length; s++) {
      const tier = this.tiers[s];
      tier.near.mesh.count = nearN[s];
      tier.mid.mesh.count = midN[s];
      tier.near.mesh.instanceMatrix.needsUpdate = true;
      tier.mid.mesh.instanceMatrix.needsUpdate = true;
      this.drawnNear += nearN[s];
      this.drawnMid += midN[s];
    }
    this.lastRebuild.copy(cam);
  }

  update(dt: number, ctx: Ctx): void {
    if (!this.field) return;
    const t0 = performance.now();

    this.shared.time.value += dt;
    this.shared.season.value = autumnFactor(ctx.dayOfYear);
    // A slow shift in the prevailing wind keeps long shots from looking looped.
    const a = 0.35 + Math.sin(this.shared.time.value * 0.031) * 0.55;
    const gustiness = 0.75 + 0.35 * Math.sin(this.shared.time.value * 0.11 + 1.3);
    this.shared.wind.value.set(Math.cos(a), Math.sin(a), gustiness);

    if (ctx.camera.position.distanceToSquared(this.lastRebuild) > REBUILD_MOVE * REBUILD_MOVE) {
      this.rebuild(ctx);
    }
    if (this.ground?.needsRebuild(ctx.camera.position)) this.ground.rebuild(ctx);

    this.updateMs = this.updateMs * 0.9 + (performance.now() - t0) * 0.1;
    ctx.stats['veg.near'] = this.drawnNear;
    ctx.stats['veg.mid'] = this.drawnMid;
    ctx.stats['veg.grass'] = this.ground?.drawnGrass ?? 0;
    ctx.stats['veg.shrubs'] = this.ground?.drawnBush ?? 0;
    ctx.stats['veg.ms'] = Math.round(this.updateMs * 100) / 100;
    ctx.stats['veg.buildMs'] = Math.round(this.buildMs);
  }

  dispose(ctx: Ctx): void {
    ctx.scene.remove(this.root);
    this.ground?.dispose();
    const seen = new Set<THREE.Material>();
    for (const t of this.tiers) {
      for (const x of [t.near, t.mid, ...t.far]) {
        x.mesh.geometry.dispose();
        for (const m of x.materials) {
          if (!seen.has(m)) {
            seen.add(m);
            m.dispose();
          }
        }
      }
    }
    disposeTextures(this.textures);
    this.tiers.length = 0;
  }
}
