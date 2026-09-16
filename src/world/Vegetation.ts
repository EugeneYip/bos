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
/**
 * Milliseconds per frame the tier refill may spend. At 4 ms a 200 ms pass takes
 * fifty frames — a couple of seconds of trees resolving in the middle distance,
 * which is far less noticeable than a fifth of a second of frozen picture.
 */
const REBUILD_BUDGET_MS = 4;

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
/**
 * Width of the near/mid hand-over band, metres. Kept as its own constant
 * (distinct from FADE_BAND, which still governs mid/impostor unchanged)
 * rather than an alias, but tuned to the *same* value deliberately, not by
 * default: wider was tried — 40 m and 90 m, measured with `qa/_common_lod.mjs`
 * across four forced tier swaps — and every width past 30 made the frame's
 * mean-luma swing on a swap *worse* (30 m: ~0.9% mean |dLuma|, about a wash
 * against no cross-fade at all; 40 m: ~1.0%; 90 m: ~1.1%). Near and mid art do
 * not average to quite the same post-normalisation brightness for the same
 * species (`qa/_common_vegdiag.mjs`'s raw map means differ by roughly a
 * fifth before the shader's own mean-1 renormalisation, and the square root
 * in that renormalisation compresses a high-contrast leaf card's mean down
 * further than a softer clump card's), so any tree whose near/mid split
 * moves nudges the scene's aggregate brightness a little regardless of how
 * gradually it is dithered — and a wider band means more trees moving at
 * once. That is a real but different problem from the one this band exists
 * to fix, which is a *specific, identifiable* tree changing its entire
 * rendered appearance in one frame: the dither removes that categorically
 * regardless of width (the two tiers' keep-regions partition the pixel
 * exactly — see VEG_NEARMID), so there is no reason to pay the aggregate cost
 * of a band wider than the one already proven not to regress it.
 */
const NEARMID_BAND = FADE_BAND;
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
  private lastCamPos = new THREE.Vector3(1e9, 1e9, 1e9);
  private nearTotal = 0;
  private midTotal = 0;
  /** Worst single-frame refill, in ms. A *max*, not an average: see `rebuild`. */
  private worstRebuild = 0;
  private worstGround = 0;
  /** Resumable state for the amortised refill; null when no pass is running. */
  private rb: {
    k: number; ci: number; cj: number;
    nearN: Int32Array; midN: Int32Array;
    nearLeft: number; midLeft: number;
    stageNear: Float32Array[]; stageMid: Float32Array[];
    at: THREE.Vector3;
  } | null = null;
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
    // The first fill runs to completion: this is still inside `init`, behind the
    // loading screen, where a long frame costs nothing and an empty city costs
    // the first impression.
    this.rebuild(ctx, Infinity);
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
    // Three tiers, two hand-overs. Mid <-> impostor already cross-fades over
    // the last FADE_BAND of the mid tier's reach, with a complementary dither
    // (see `rebuild`'s VEG_FADE_INVERT note in vegetation/material.ts). Near
    // <-> mid used to have no such band: a tree was written into exactly one
    // of the two instance buffers, chosen anew each time `rebuild` ran, so a
    // single rebuild could flip a couple dozen trees straight from one tier's
    // art to the other's in one frame — a real, measured pop (`qa/_common_lod.mjs`
    // isolates it: +2.17% of the frame's mean luma on a clean, camera-static
    // tier swap). Near now fades out over NEARMID_BAND approaching
    // NEAR_RADIUS, and mid fades in over the identical band (`rebuild` below
    // writes a boundary tree into *both* buffers across it), so the two
    // dither-partition the hand-over exactly like mid/impostor do — over a
    // band wide enough to survive one rebuild step (see NEARMID_BAND).
    const fade = {
      near: { in: -1e6, out: NEAR_RADIUS, band: NEARMID_BAND, inBand: NEARMID_BAND },
      mid: { in: NEAR_RADIUS - NEARMID_BAND, out: MID_RADIUS, band: FADE_BAND, inBand: NEARMID_BAND },
      far: { in: MID_RADIUS - FADE_BAND, out: 1e9, band: FADE_BAND, inBand: FADE_BAND },
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
      fadeBand: fade.band,
      fadeInBand: fade.inBand,
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
      fadeBand: fade.band,
      fadeInBand: fade.inBand,
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
  /** Compose one instance matrix into a staging array rather than a live mesh. */
  private writeTo(field: TreeField, stage: Float32Array, slot: number, i: number): void {
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
    Vegetation._m.toArray(stage, slot * 16);
  }

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

  /**
   * Refill the near and mid tiers with the trees closest to the camera, spread
   * over as many frames as it takes.
   *
   * This used to run to completion in one frame. Measured over a kilometre
   * fly-through it cost **203 ms in a single frame**, every 28 m of travel,
   * forever — and its own timing was an exponential average, which reads about
   * zero from a parked camera and hid the whole thing. That, plus the
   * groundcover's equivalent, is what "the whole scene keeps blinking" is:
   * nothing to do with the renderer or the quality tier, which is exactly why
   * changing the resolution never moved `fps.low` off 10.
   *
   * The cost is not the matrix writes, it is the scan: up to 89,000 trees get a
   * distance test to find the nearest 11,600. So the walk is resumable, with the
   * cursor and counters held across frames and matrices composed into staging
   * arrays. Partial work is never visible — buffers and instance counts are
   * swapped in together when the pass finishes. The clock is read once per cell
   * rather than per tree, so the overshoot is one cell's worth of work.
   */
  private rebuild(ctx: Ctx, budgetMs: number): void {
    const field = this.field;
    if (!field) return;
    const t0 = performance.now();

    if (!this.rb) {
      const c = ctx.camera.position;
      this.rb = {
        k: 0,
        ci: Math.floor((c.x - this.gMinX) / GRID_CELL),
        cj: Math.floor((c.z - this.gMinZ) / GRID_CELL),
        nearN: new Int32Array(SPECIES.length),
        midN: new Int32Array(SPECIES.length),
        nearLeft: this.nearTotal,
        midLeft: this.midTotal,
        stageNear: this.tiers.map((t) => new Float32Array(t.near.mesh.instanceMatrix.array.length)),
        stageMid: this.tiers.map((t) => new Float32Array(t.mid.mesh.instanceMatrix.array.length)),
        at: c.clone(),
      };
    }
    const rb = this.rb;
    const cam = rb.at;
    const nearR2 = NEAR_RADIUS * NEAR_RADIUS;
    const midR2 = MID_RADIUS * MID_RADIUS;
    // Trees at d2 in [nearFadeR2, nearR2) sit in NEARMID_BAND approaching
    // NEAR_RADIUS: write them into *both* stages so the shader's complementary
    // dither (VEG_NEARMID in vegetation/material.ts) can cross-fade near's art
    // out and mid's in, instead of a tree jumping from one to the other whole.
    const nearFadeR2 = (NEAR_RADIUS - NEARMID_BAND) * (NEAR_RADIUS - NEARMID_BAND);

    while (rb.k < this.cellOrder.length && (rb.nearLeft > 0 || rb.midLeft > 0)) {
      if (performance.now() - t0 > budgetMs) return;
      const i = rb.ci + this.cellOrder[rb.k];
      const j = rb.cj + this.cellOrder[rb.k + 1];
      rb.k += 2;
      if (i < 0 || j < 0 || i >= this.gx || j >= this.gz) continue;
      const c = j * this.gx + i;
      const end = this.cellStart[c + 1];
      for (let e = this.cellStart[c]; e < end; e++) {
        const t = this.cellItems[e];
        const dx = field.px[t] - cam.x;
        const dz = field.pz[t] - cam.z;
        const d2 = dx * dx + dz * dz;
        if (d2 > midR2) continue;
        const sp = field.species[t];
        const tier = this.tiers[sp];
        let wroteNear = false;
        if (d2 < nearR2 && rb.nearLeft > 0 && rb.nearN[sp] < tier.nearCap) {
          this.writeTo(field, rb.stageNear[sp], rb.nearN[sp]++, t);
          rb.nearLeft--;
          wroteNear = true;
        }
        // Mid picks up anything near did not claim (outside NEAR_RADIUS, or
        // budget/capacity turned it away — unchanged fallback), *plus* every
        // tree already in near's own hand-over band, so the pair overlaps
        // there instead of handing off in a single frame.
        const wantMid = !wroteNear || d2 >= nearFadeR2;
        if (wantMid && rb.midLeft > 0 && rb.midN[sp] < tier.midCap) {
          this.writeTo(field, rb.stageMid[sp], rb.midN[sp]++, t);
          rb.midLeft--;
        }
      }
    }

    this.drawnNear = 0;
    this.drawnMid = 0;
    for (let sp = 0; sp < SPECIES.length; sp++) {
      const tier = this.tiers[sp];
      (tier.near.mesh.instanceMatrix.array as Float32Array).set(rb.stageNear[sp]);
      (tier.mid.mesh.instanceMatrix.array as Float32Array).set(rb.stageMid[sp]);
      tier.near.mesh.count = rb.nearN[sp];
      tier.mid.mesh.count = rb.midN[sp];
      tier.near.mesh.instanceMatrix.needsUpdate = true;
      tier.mid.mesh.instanceMatrix.needsUpdate = true;
      this.drawnNear += rb.nearN[sp];
      this.drawnMid += rb.midN[sp];
    }
    this.lastRebuild.copy(cam);
    this.rb = null;
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

    // A pass in flight finishes before another starts, unless the camera has run
    // a long way past where it began — otherwise, at flying speed, every 28 m
    // would restart it and the trees would never update at all.
    const r0 = performance.now();
    if (this.rb) {
      if (ctx.camera.position.distanceToSquared(this.rb.at) > (REBUILD_MOVE * 4) ** 2) this.rb = null;
      this.rebuild(ctx, REBUILD_BUDGET_MS);
    } else if (ctx.camera.position.distanceToSquared(this.lastRebuild) > REBUILD_MOVE * REBUILD_MOVE) {
      this.rebuild(ctx, REBUILD_BUDGET_MS);
    }
    this.worstRebuild = Math.max(this.worstRebuild, performance.now() - r0);

    // Grass is a near-camera effect. Rebuilding it costs a third of a second of
    // terrain sampling, and none of it is visible from a camera moving at forty
    // metres a second — so it waits until the view settles.
    const speed = Math.sqrt(ctx.camera.position.distanceToSquared(this.lastCamPos)) / Math.max(dt, 1e-3);
    this.lastCamPos.copy(ctx.camera.position);
    if (speed < 14 && this.ground?.needsRebuild(ctx.camera.position)) {
      const g0 = performance.now();
      this.ground.rebuild(ctx);
      this.worstGround = Math.max(this.worstGround, performance.now() - g0);
    }

    this.updateMs = this.updateMs * 0.9 + (performance.now() - t0) * 0.1;
    ctx.stats['veg.near'] = this.drawnNear;
    ctx.stats['veg.mid'] = this.drawnMid;
    ctx.stats['veg.grass'] = this.ground?.drawnGrass ?? 0;
    ctx.stats['veg.shrubs'] = this.ground?.drawnBush ?? 0;
    ctx.stats['veg.ms'] = Math.round(this.updateMs * 100) / 100;
    ctx.stats['veg.buildMs'] = Math.round(this.buildMs);
    ctx.stats['veg.worstRebuildMs'] = Math.round(this.worstRebuild * 10) / 10;
    ctx.stats['veg.worstGroundMs'] = Math.round(this.worstGround * 10) / 10;
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
