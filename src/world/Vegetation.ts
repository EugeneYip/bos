import * as THREE from 'three';
import type { Ctx, WorldModule } from '../core/Context';
import type { AreaRecord, PropSet, RoadRecord } from '../core/types';
import { loadAreas, loadProps, loadRoads } from '../core/data';
import { MOBILE } from '../core/gpu';
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
  /** Live impostor tiles, keyed by tile index. All of them on a desktop. */
  far: Map<number, Tier>;
  /** CSR of this species' tree indices by tile, so a tile can be built later. */
  farStart: Int32Array;
  farItems: Uint32Array;
  farGeom: TreeGeometry;
  farMaterials: THREE.Material[];
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
/**
 * Impostor tiles across the city, per axis.
 *
 * Four is enough on a desktop, where the only job is to give the frustum
 * something district-sized to reject. On a phone the tiles are also the unit
 * of *streaming*, so they have to be small enough that a 1600 m disc is not
 * most of the city: 8 puts a tile at roughly 1500 x 1120 m, and the twenty or
 * so tiles a 1600 m disc touches hold about a third of the trees. Finer than
 * that and the win is eaten by the draw call per tile per species -- at 16 a
 * tile averaged forty instances.
 *
 * Tile granularity does not decide where the canopy *ends*: the impostor
 * material fades out at STREAM_RADIUS on a phone regardless, so a tile that
 * straddles the edge draws only the trees inside it.
 */
const FAR_TILES = MOBILE ? 8 : 4;
/**
 * How far a phone builds impostors, metres. The same radius Buildings and
 * Roads stream at, deliberately: a canopy that carried on past the edge of
 * the built city would be far more conspicuous than one that stops with it.
 */
const STREAM_RADIUS = 1600;
/** Extra reach before a built tile is thrown away, so the edge does not thrash. */
const STREAM_HYSTERESIS = 260;
/** Tiles a phone may build in one frame. One is about a third of a millisecond. */
const STREAM_PER_FRAME = 2;

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
  private worstStream = 0;
  private lastStream = new THREE.Vector3(1e9, 1e9, 1e9);
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
  /** Last `ctx.envMap` bound to this module's materials. */
  private envRef: THREE.Texture | null = null;

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
    // Placement is the only reader of the mask's park-size hint; see
    // `dropExtent`. 4.3 MB, every platform.
    this.mask.dropExtent();
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
    this.buildFarLayout(field);

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
      this.tiers.push({
        near, mid, nearCap, midCap,
        far: new Map(),
        ...this.indexFarTiles(ctx, s, lods.far),
      });
      // Yield so the loading bar keeps painting while the crowns are built.
      await new Promise((r) => setTimeout(r, 0));
    }
    // Desktop builds every tile now; a phone builds the ones it is standing in
    // and picks up the rest as the camera moves.
    this.streamFar(ctx, Infinity);
    this.lastStream.copy(ctx.camera.position);

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
      // A phone stops the canopy where Buildings and Roads stop their own
      // streaming. The tile grid is far too coarse to place that edge -- a
      // tile is 1.5 km across -- so the material does it per tree, and the
      // vertex shader collapses everything past it to zero area. Without this
      // a phone renders a forest standing on the far side of the edge of the
      // modelled city, which is a worse artefact than the edge itself.
      far: {
        in: MID_RADIUS - FADE_BAND,
        out: MOBILE ? STREAM_RADIUS : 1e9,
        band: MOBILE ? 220 : FADE_BAND,
        inBand: FADE_BAND,
      },
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
      // 1.0 for the impostor, and not the 1.5 this line used to read.
      //
      // Nothing in this file's intensities was reaching the shader: three
      // overrides `envMapIntensity` with `scene.environmentIntensity` for any
      // standard material whose own `envMap` is null, and none of these bound
      // one. So the impostor tier has in fact been running at 1.0 for its
      // whole life. Putting 1.5 into effect brightens the aerial canopy by
      // 4 % of its foliage luma at `backbay-grid`, in the direction this tier
      // is already too bright in; 1.0 leaves it exactly where it is. The
      // detailed tiers' 1.15, and bark's 1.3, are worth having: they lift a
      // trunk in the shade of its own crown by a fifth, which is what they
      // were chosen for.
      envMap: ctx.envMap,
      envMapIntensity: lod === 'far' ? 1.0 : 1.15,
      canopy: lod === 'far' ? 0.26 : 0.42,
      mapMean,
    }).material;

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
      envMap: ctx.envMap,
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
   * Index this species' trees by impostor tile, without building anything.
   *
   * One mesh holding all 88 000 would have a city-sized bounding sphere and
   * could never be culled; split, the renderer skips every district behind
   * the camera. On a phone the tiles are also the unit of streaming, so the
   * membership is kept as a CSR list and the meshes are built on demand --
   * see `streamFar`.
   */
  private indexFarTiles(
    ctx: Ctx, s: number, tg: TreeGeometry,
  ): Pick<SpeciesTier, 'farStart' | 'farItems' | 'farGeom' | 'farMaterials'> {
    const field = this.field!;
    const idx = field.bySpecies[s];
    const n = FAR_TILES * FAR_TILES;
    const start = new Int32Array(n + 1);
    for (let k = 0; k < idx.length; k++) start[this.tileOf(idx[k]) + 1]++;
    for (let t = 0; t < n; t++) start[t + 1] += start[t];
    const items = new Uint32Array(idx.length);
    const cursor = start.slice(0, n);
    for (let k = 0; k < idx.length; k++) items[cursor[this.tileOf(idx[k])]++] = idx[k];
    return {
      farStart: start,
      farItems: items,
      farGeom: tg,
      farMaterials: this.materialsFor(ctx, s, 'far', tg),
    };
  }

  /** World bounds of the impostor tile grid, set once by `buildFarLayout`. */
  private fMinX = 0;
  private fMinZ = 0;
  private fStepX = 1;
  private fStepZ = 1;

  private buildFarLayout(field: TreeField): void {
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (let i = 0; i < field.count; i++) {
      if (field.px[i] < minX) minX = field.px[i];
      if (field.px[i] > maxX) maxX = field.px[i];
      if (field.pz[i] < minZ) minZ = field.pz[i];
      if (field.pz[i] > maxZ) maxZ = field.pz[i];
    }
    this.fMinX = minX;
    this.fMinZ = minZ;
    this.fStepX = Math.max(1, maxX - minX) / FAR_TILES;
    this.fStepZ = Math.max(1, maxZ - minZ) / FAR_TILES;
  }

  private tileOf(i: number): number {
    const field = this.field!;
    const tx = Math.min(FAR_TILES - 1, Math.max(0, ((field.px[i] - this.fMinX) / this.fStepX) | 0));
    const tz = Math.min(FAR_TILES - 1, Math.max(0, ((field.pz[i] - this.fMinZ) / this.fStepZ) | 0));
    return tz * FAR_TILES + tx;
  }

  private static _fm = new THREE.Matrix4();
  private static _fq = new THREE.Quaternion();

  /** Build one species' impostor mesh for one tile. */
  private makeFarTile(st: SpeciesTier, s: number, t: number): Tier | null {
    const field = this.field!;
    const a = st.farStart[t];
    const b = st.farStart[t + 1];
    if (b <= a) return null;
    const mesh = new THREE.InstancedMesh(
      st.farGeom.geometry,
      st.farMaterials.length === 1 ? st.farMaterials[0] : st.farMaterials,
      b - a,
    );
    mesh.name = `trees:${SPECIES[s].name}:far:${t}`;
    mesh.userData.noShadow = true;
    mesh.castShadow = false;
    mesh.receiveShadow = true;
    mesh.count = b - a;
    const m = Vegetation._fm;
    const q = Vegetation._fq;
    const p = Vegetation._p;
    const sc = Vegetation._s;
    for (let k = a; k < b; k++) {
      const i = st.farItems[k];
      const h = field.height[i];
      const w = field.width[i] * h;
      p.set(field.px[i], field.py[i], field.pz[i]);
      sc.set(w, h, w);
      // No yaw: the shader spins the billboard to face the camera itself, and
      // an instance rotation would fight it.
      m.compose(p, q, sc);
      mesh.setMatrixAt(k - a, m);
    }
    mesh.instanceMatrix.needsUpdate = true;
    mesh.computeBoundingSphere();
    this.root.add(mesh);
    return { mesh, materials: st.farMaterials };
  }

  /** Shortest distance from the camera to a tile's footprint, metres. */
  private tileDistance(t: number, cx: number, cz: number): number {
    const tx = t % FAR_TILES;
    const tz = (t / FAR_TILES) | 0;
    const x0 = this.fMinX + tx * this.fStepX;
    const z0 = this.fMinZ + tz * this.fStepZ;
    const dx = Math.max(x0 - cx, 0, cx - (x0 + this.fStepX));
    const dz = Math.max(z0 - cz, 0, cz - (z0 + this.fStepZ));
    return Math.hypot(dx, dz);
  }

  /**
   * Bring the set of live impostor tiles in line with where the camera is.
   *
   * A no-op on a desktop after the first call, which builds every tile: the
   * whole set is 5.6 MB of instance matrices and the frustum handles the rest.
   * On a phone the tiles outside STREAM_RADIUS are never built, and ones left
   * behind are thrown away, so the canopy occupies a disc rather than the
   * county -- and stops at the same distance the buildings and the roads do,
   * which is the only way the edge of the model does not read as a clearing.
   *
   * `budget` caps how many tiles may be *built* in this call, so a phone
   * spreads the work over frames instead of dropping one. Returns how many
   * wanted tiles the budget turned away, so the caller knows to come back.
   */
  private streamFar(ctx: Ctx, budget: number): number {
    if (!this.field) return 0;
    const cam = ctx.camera.position;
    const nTiles = FAR_TILES * FAR_TILES;
    let built = 0;
    let pending = 0;
    for (let t = 0; t < nTiles; t++) {
      const d = MOBILE ? this.tileDistance(t, cam.x, cam.z) : 0;
      const want = d <= STREAM_RADIUS;
      const drop = d > STREAM_RADIUS + STREAM_HYSTERESIS;
      for (let s = 0; s < this.tiers.length; s++) {
        const st = this.tiers[s];
        const live = st.far.get(t);
        if (want && !live) {
          if (built >= budget) { pending++; continue; }
          const tier = this.makeFarTile(st, s, t);
          if (tier) st.far.set(t, tier);
          built++;
        } else if (drop && live) {
          this.root.remove(live.mesh);
          live.mesh.dispose();
          st.far.delete(t);
        }
      }
    }
    return pending;
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

  private ditherFrame = 0;

  update(dt: number, ctx: Ctx): void {
    if (!this.field) return;
    const t0 = performance.now();

    this.shared.time.value += dt;
    this.shared.season.value = autumnFactor(ctx.dayOfYear);

    // Sky bakes the IBL after the world modules initialise, and replaces it on
    // a quality change, so the binding made at construction has to be redone
    // when it appears. Without this every material falls back to
    // `scene.environmentIntensity` and the intensities in `materialsFor`
    // mean nothing -- which is the state this module was in until now.
    if (ctx.envMap !== this.envRef) {
      this.envRef = ctx.envMap;
      this.root.traverse((o) => {
        const mm = (o as THREE.Mesh).material;
        for (const m of Array.isArray(mm) ? mm : [mm]) {
          const sm = m as THREE.MeshStandardMaterial | undefined;
          if (!sm || !('envMap' in sm)) continue;
          sm.envMap = this.envRef;
          sm.needsUpdate = true;
        }
      });
    }

    // Walk the LOD dither one golden-ratio step per frame so the accumulator
    // has something to average. Held at zero when there is no accumulator:
    // see the note on `vegIGN`. 5.588238 is a whole number of periods of the
    // noise's own x term, which keeps successive frames decorrelated instead
    // of sliding the same pattern sideways.
    if (ctx.quality.taa) {
      this.ditherFrame = (this.ditherFrame + 1) % 64;
      this.shared.dither.value = 5.588238 * ((this.ditherFrame * 0.6180339887) % 1);
    } else {
      // Negative is the sentinel for 'no accumulator'; see `vegFadeCut`.
      this.shared.dither.value = -1;
    }
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

    // Impostor tiles follow the camera on a phone; a no-op on a desktop,
    // where every tile was built at load.
    if (MOBILE && ctx.camera.position.distanceToSquared(this.lastStream) > 120 * 120) {
      const s0 = performance.now();
      const pending = this.streamFar(ctx, STREAM_PER_FRAME);
      this.worstStream = Math.max(this.worstStream, performance.now() - s0);
      if (!pending) this.lastStream.copy(ctx.camera.position);
    }

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
    if (MOBILE) {
      let tiles = 0;
      for (const t of this.tiers) tiles += t.far.size;
      ctx.stats['veg.farTiles'] = tiles;
      ctx.stats['veg.worstStreamMs'] = Math.round(this.worstStream * 10) / 10;
    }
  }

  dispose(ctx: Ctx): void {
    ctx.scene.remove(this.root);
    this.ground?.dispose();
    const seen = new Set<THREE.Material>();
    const seenGeo = new Set<THREE.BufferGeometry>();
    for (const t of this.tiers) {
      for (const x of [t.near, t.mid, ...t.far.values()]) {
        // Every live impostor tile shares one geometry, so this has to be
        // idempotent rather than once per mesh.
        if (!seenGeo.has(x.mesh.geometry)) {
          seenGeo.add(x.mesh.geometry);
          x.mesh.geometry.dispose();
        }
        x.mesh.dispose();
        for (const m of x.materials) {
          if (!seen.has(m)) {
            seen.add(m);
            m.dispose();
          }
        }
      }
      // A phone may have no tile of a species live at all; its geometry is
      // still holding GPU memory.
      if (!seenGeo.has(t.farGeom.geometry)) {
        seenGeo.add(t.farGeom.geometry);
        t.farGeom.geometry.dispose();
      }
      for (const m of t.farMaterials) {
        if (!seen.has(m)) { seen.add(m); m.dispose(); }
      }
    }
    disposeTextures(this.textures);
    this.tiers.length = 0;
  }
}
