/**
 * Roads.
 *
 * 4 253 km of Boston street network, drawn as mitred ribbons draped on the
 * terrain, stitched together by real junction polygons, marked, kerbed,
 * bridged and tunnelled.
 *
 * Structure:
 *  - `network.ts`   topology: splitting, welding, junction polygons, trims
 *  - `ribbon.ts`    the mitred rung frame every surface is sampled from
 *  - `carriage.ts`  carriageway, gutter, kerb, pavement, street furniture
 *  - `paint.ts`     lane markings, wear
 *  - `junction.ts`  junction fill, kerb returns, crossings, arrows
 *  - `structures.ts` bridge decks, tunnel portals, railway track
 *
 * Everything is bucketed into tiles at three ranges. The carriageway tier is
 * built once and always drawn; markings, kerbs and pavements are built on
 * demand as the camera approaches and thrown away as it leaves, so the
 * network costs a few hundred draw calls no matter where you stand.
 */
import * as THREE from 'three';
import type { Ctx, WorldModule } from '../core/Context';
import { lonLatToWorld } from '../core/geo';
import { loadRoads } from '../core/data';
import type { RoadRecord } from '../core/types';

import { MeshBuilder } from './roads/builder';
import {
  type Ribbon, emitCarriage, emitKerbWalk, emitMicroDetail, makeRibbon, walkMaterial,
} from './roads/carriage';
import { type Chunk, Buckets, chunkPolyline } from './roads/geom';
import { emitCrossings, emitJunctionFill, emitKerbReturns } from './roads/junction';
import { type MatKey, RoadMaterials, surfaceMat } from './roads/materials';
import { trimHead, reverse } from './roads/math2';
import { type Junction, type Network, type PreparedRoad, buildNetwork } from './roads/network';
import { emitMarkings } from './roads/paint';
import { emitBridge, emitPortal, emitSleepers, emitTrack } from './roads/structures';
import { TUNE } from './roads/spec';
import { disposeFallbacks } from './roads/textures';

/* ---------------------------------------------------------------- tuning */

const BASE_TILE = 1200;
const DETAIL_TILE = 460;
const MICRO_TILE = 240;
const DETAIL_RANGE = 720;
const MICRO_RANGE = 205;
/** Chunk length: short enough that a tile's bounds stay tight. */
const CHUNK = 165;
/** Live detail tiles retained before the furthest are recycled. */
const DETAIL_BUDGET = 70;
const MICRO_BUDGET = 26;

/**
 * Bespoke landmark bridges. `Landmarks` owns the Zakim and the Longfellow;
 * if it has placed them we must not draw a second deck on top. If it has
 * not (or it failed), our generic structure is better than a gap.
 */
const LANDMARK_BRIDGES = [
  { slug: 'zakim-bridge', lon: -71.06170, lat: 42.37000, r: 215 },
  { slug: 'longfellow-bridge', lon: -71.07445, lat: 42.36225, r: 300 },
];

/* ----------------------------------------------------------------- types */

interface Item {
  chunk: Chunk;
  road: PreparedRoad;
  surface: MatKey;
  walk: MatKey;
  /** Carries kerbs, pavements or markings worth building up close. */
  detail: boolean;
  /** Carries manholes, gully grates, tree pits or sleepers. */
  micro: boolean;
}

interface Tile {
  key: number;
  cx: number;
  cz: number;
  items: number[];
  junctions: number[];
  group: THREE.Group | null;
  /** Squared radius of the tile's content, for range tests. */
  extent: number;
  lastSeen: number;
}

type Sample = (x: number, z: number) => number;

/* ------------------------------------------------------------------ module */

export class Roads implements WorldModule {
  readonly name = 'Roads';

  private ctx!: Ctx;
  private mats!: RoadMaterials;
  private root = new THREE.Group();
  private baseGroup = new THREE.Group();
  private detailGroup = new THREE.Group();
  private microGroup = new THREE.Group();
  private structGroup = new THREE.Group();
  private landmarkGroups = new Map<string, THREE.Group>();

  private net: Network | null = null;
  private items: Item[] = [];
  private junctions: Junction[] = [];

  private baseTiles = new Map<number, Tile>();
  private detailTiles = new Map<number, Tile>();
  private microTiles = new Map<number, Tile>();

  private queue: Tile[] = [];
  private queueTier: Array<1 | 2> = [];
  private frame = 0;
  private buildMs = 0;
  private ready = false;
  private disposed = false;
  private lastCamX = 1e9;
  private lastCamZ = 1e9;
  private tris = 0;

  async init(ctx: Ctx): Promise<void> {
    this.ctx = ctx;
    this.mats = new RoadMaterials(ctx);

    this.root.name = 'roads';
    this.baseGroup.name = 'roads-base';
    this.detailGroup.name = 'roads-detail';
    this.microGroup.name = 'roads-micro';
    this.structGroup.name = 'roads-structures';
    this.root.add(this.baseGroup, this.structGroup, this.detailGroup, this.microGroup);
    ctx.scene.add(this.root);

    let records: RoadRecord[];
    try {
      records = await loadRoads();
    } catch (err) {
      console.warn('[Roads] no road data; skipping', err);
      return;
    }
    if (this.disposed) return;
    await yieldFrame();

    const sample: Sample = (x, z) => {
      const v = ctx.sampleHeight?.(x, z);
      return Number.isFinite(v) ? (v as number) : 0;
    };

    const t0 = performance.now();
    this.net = buildNetwork(records, sample);
    const tNet = performance.now() - t0;
    await yieldFrame();

    this.bucket();
    await yieldFrame();

    const t1 = performance.now();
    await this.buildBase();
    const tBase = performance.now() - t1;

    this.buildStructures(sample);
    await yieldFrame();

    ctx.stats.roadKm = Math.round(
      this.net.roads.reduce((s, r) => s + (r.tunnel ? 0 : r.length), 0) / 100,
    ) / 10;
    ctx.stats.roadNodes = this.junctions.length;
    console.info(
      `[Roads] ${this.net.roads.length} ways, ${this.junctions.length} junctions, ` +
      `${this.items.length} chunks; topology ${tNet.toFixed(0)} ms, base ${tBase.toFixed(0)} ms`,
    );

    ctx.on('landmark-slugs', () => this.applyLandmarkSuppression());
    ctx.on('quality-changed', () => { /* materials re-resolve on next build */ });
    this.applyLandmarkSuppression();
    this.ready = true;
  }

  /* ------------------------------------------------------------ bucketing */

  private bucket(): void {
    const net = this.net;
    if (!net) return;

    for (const road of net.roads) {
      if (road.tunnel) continue;               // the Big Dig stays underground
      if (road.pts.length < 2) continue;

      // Cut the ribbon back to the junction boundaries before anything else.
      let pts = road.pts;
      let ys = road.ys;
      if (road.trimStart > 0.01) {
        const t = trimHead(pts, ys, road.trimStart);
        pts = t.pts; ys = t.ys;
      }
      if (road.trimEnd > 0.01 && pts.length > 1) {
        const r = reverse(pts, ys);
        const t = trimHead(r.pts, r.ys, road.trimEnd);
        const b = reverse(t.pts, t.ys);
        pts = b.pts; ys = b.ys;
      }
      if (pts.length < 2) continue;

      const isRail = road.cls === 'rail';
      const detail = !isRail && (
        (road.spec.kerb && road.spec.sidewalk > 0) ||
        road.spec.markings ||
        road.cls === 'cycleway'
      );
      const micro = isRail || (road.spec.streetDetail && road.spec.kerb);

      for (const chunk of chunkPolyline(pts, ys, CHUNK)) {
        const idx = this.items.length;
        this.items.push({
          chunk,
          road,
          surface: isRail ? 'ballast' : surfaceMat(road.surface),
          walk: walkMaterial(chunk.mx, chunk.mz),
          detail,
          micro,
        });
        this.push(this.baseTiles, BASE_TILE, chunk.mx, chunk.mz, idx, false);
        if (detail) this.push(this.detailTiles, DETAIL_TILE, chunk.mx, chunk.mz, idx, false);
        if (micro) this.push(this.microTiles, MICRO_TILE, chunk.mx, chunk.mz, idx, false);
      }
    }

    for (const j of net.junctions) {
      const idx = this.junctions.length;
      this.junctions.push(j);
      this.push(this.baseTiles, BASE_TILE, j.p.x, j.p.z, idx, true);
      this.push(this.detailTiles, DETAIL_TILE, j.p.x, j.p.z, idx, true);
    }
  }

  private push(
    map: Map<number, Tile>, size: number, x: number, z: number, idx: number, junction: boolean,
  ): void {
    const tx = Math.floor(x / size);
    const tz = Math.floor(z / size);
    const key = (tx + 4096) * 16384 + (tz + 4096);
    let t = map.get(key);
    if (!t) {
      t = {
        key,
        cx: (tx + 0.5) * size,
        cz: (tz + 0.5) * size,
        items: [],
        junctions: [],
        group: null,
        extent: size * 0.75,
        lastSeen: 0,
      };
      map.set(key, t);
    }
    (junction ? t.junctions : t.items).push(idx);
  }

  /* ------------------------------------------------------------ base tier */

  private async buildBase(): Promise<void> {
    const tiles = [...this.baseTiles.values()];
    let slice = performance.now();
    for (const tile of tiles) {
      this.buildTile(tile, 0);
      // Yield often enough that the loading screen keeps painting.
      if (performance.now() - slice > 24) {
        await yieldFrame();
        if (this.disposed) return;
        slice = performance.now();
      }
    }
  }

  /**
   * Builds one tile at one detail tier. Every surface family in the tile
   * collapses to a single merged mesh, so a tile is 1-4 draw calls.
   */
  private buildTile(tile: Tile, tier: 0 | 1 | 2): void {
    const bk = new Buckets();
    const mats = this.mats;
    const sample: Sample = (x, z) => {
      const v = this.ctx.sampleHeight?.(x, z);
      return Number.isFinite(v) ? (v as number) : 0;
    };

    for (const i of tile.items) {
      const it = this.items[i];
      const rib = makeRibbon(it.chunk, it.road, tier > 0);
      if (!rib) continue;

      if (tier === 0) {
        if (it.road.cls === 'rail') {
          emitTrack(bk.get('ballast'), bk.get('steel'), rib, mats.tile('ballast'), mats.tile('steel'));
        } else {
          emitCarriage(bk.get(it.surface), rib, mats.tile(it.surface));
          if (it.road.bridge && !this.suppressed(it)) {
            emitBridge(bk.get('structure'), rib, mats.tile('structure'), sample);
          }
        }
      } else if (tier === 1) {
        this.buildDetailItem(bk, it, rib);
      } else {
        if (it.road.cls === 'rail') emitSleepers(bk.get('structure'), rib, mats.tile('structure'));
        else {
          emitMicroDetail(
            bk.get('steel'), bk.get('gravel'), rib, mats.tile('steel'), mats.tile('gravel'),
          );
        }
      }
    }

    for (const i of tile.junctions) {
      const j = this.junctions[i];
      if (tier === 0) {
        emitJunctionFill(bk.get(surfaceMat(j.surface)), j, mats.tile(surfaceMat(j.surface)));
      } else if (tier === 1) {
        const walk = walkMaterial(j.p.x, j.p.z);
        emitKerbReturns(bk.get('kerb'), bk.get(walk), j, mats.tile('kerb'), mats.tile(walk));
        emitCrossings(bk.get('paint'), j, mats.tile('paint'));
      }
    }

    const stats = bk.stats();
    // Ground-level road surface, kerbs and walks lie on the terrain: there is
    // nothing beneath them to shade, and self-shadowing a flat decal only buys
    // acne. Only the structural passes (bridges, portals, below) cast.
    const meshes = bk.flush(mats, `road-t${tier}`, false);
    if (!meshes.length) {
      tile.group = new THREE.Group();
      return;
    }
    const group = new THREE.Group();
    group.matrixAutoUpdate = false;
    let radius = 0;
    for (const m of meshes) {
      // Paint is a decal: it must not write depth or cast shadows.
      if (m.name.endsWith(':paint')) m.castShadow = false;
      group.add(m);
      const bs = m.geometry.boundingSphere;
      if (bs) {
        radius = Math.max(radius, Math.hypot(bs.center.x - tile.cx, bs.center.z - tile.cz) + bs.radius);
      }
    }
    tile.extent = Math.max(radius, 1);
    tile.group = group;
    this.tris += stats.tris;
    (tier === 0 ? this.baseGroup : tier === 1 ? this.detailGroup : this.microGroup).add(group);
  }

  private buildDetailItem(bk: Buckets, it: Item, rib: Ribbon): void {
    const mats = this.mats;
    if (it.road.cls === 'rail') return;
    if (rib.kerbed && rib.walk > 0) {
      emitKerbWalk(bk.get('kerb'), bk.get(it.walk), rib, mats.tile('kerb'), mats.tile(it.walk));
    }
    if (it.road.spec.markings || it.road.cls === 'cycleway') {
      emitMarkings(bk.get('paint'), rib, mats.tile('paint'));
    }
  }

  /* ----------------------------------------------------------- structures */

  private buildStructures(sample: Sample): void {
    const net = this.net;
    if (!net) return;

    // --- landmark-owned bridges, kept separate so they can be switched off --
    const zones = LANDMARK_BRIDGES.map((b) => {
      const [x, z] = lonLatToWorld(b.lon, b.lat);
      return { slug: b.slug, x, z, r2: b.r * b.r };
    });
    for (const zone of zones) {
      const bk = new Buckets();
      for (const it of this.items) {
        if (!it.road.bridge) continue;
        const dx = it.chunk.mx - zone.x;
        const dz = it.chunk.mz - zone.z;
        if (dx * dx + dz * dz > zone.r2) continue;
        const rib = makeRibbon(it.chunk, it.road, false);
        if (!rib) continue;
        emitBridge(bk.get('structure'), rib, this.mats.tile('structure'), sample);
        emitCarriage(bk.get(it.surface), rib, this.mats.tile(it.surface));
      }
      const meshes = bk.flush(this.mats, `road-lm-${zone.slug}`, true);
      if (!meshes.length) continue;
      const g = new THREE.Group();
      for (const m of meshes) g.add(m);
      this.landmarkGroups.set(zone.slug, g);
      this.structGroup.add(g);
    }

    // --- tunnel portals ----------------------------------------------------
    const bk = new Buckets();
    const seen: Array<[number, number]> = [];
    let built = 0;
    const portals = net.portals
      .slice()
      .sort((a, b) => b.width - a.width);
    for (const p of portals) {
      if (built >= 90) break;
      let dupe = false;
      for (const [x, z] of seen) {
        if ((x - p.p.x) ** 2 + (z - p.p.z) ** 2 < 900) { dupe = true; break; }
      }
      if (dupe) continue;
      seen.push([p.p.x, p.p.z]);
      const end: 0 | 1 =
        Math.hypot(p.road.pts[0].x - p.p.x, p.road.pts[0].z - p.p.z) < 1.5 ? 0 : 1;
      const surfaceY = Number.isFinite(p.y) && p.y !== 0
        ? p.y
        : (end === 0 ? p.road.ys[0] : p.road.ys[p.road.ys.length - 1]) ?? 0;
      emitPortal(
        bk.get('structure'), bk.get('void'), p.road, end, surfaceY,
        this.mats.tile('structure'), sample,
      );
      built++;
    }
    for (const m of bk.flush(this.mats, 'road-portal', true)) this.structGroup.add(m);
    this.ctx.stats.roadPortals = built;
  }

  private suppressed(it: Item): boolean {
    for (const b of LANDMARK_BRIDGES) {
      const [x, z] = lonLatToWorld(b.lon, b.lat);
      const dx = it.chunk.mx - x;
      const dz = it.chunk.mz - z;
      if (dx * dx + dz * dz <= b.r * b.r) return true;
    }
    return false;
  }

  /** Hides our generic deck wherever `Landmarks` has placed the real thing. */
  private applyLandmarkSuppression(): void {
    const slugs = (this.ctx as unknown as { landmarkSlugs?: Set<string> }).landmarkSlugs;
    for (const [slug, group] of this.landmarkGroups) {
      group.visible = !(slugs instanceof Set && slugs.has(slug));
    }
  }

  /* --------------------------------------------------------------- update */

  update(_dt: number, ctx: Ctx): void {
    if (!this.ready) return;
    const t0 = performance.now();
    this.frame++;

    const cam = ctx.camera.position;
    const moved = Math.hypot(cam.x - this.lastCamX, cam.z - this.lastCamZ);
    // Only re-plan when the camera has actually gone somewhere, or every
    // eighth frame so newly queued tiles still get picked up.
    if (moved > 12 || this.frame % 8 === 0) {
      this.lastCamX = cam.x;
      this.lastCamZ = cam.z;
      this.plan(cam.x, cam.z, this.detailTiles, DETAIL_RANGE, 1);
      this.plan(cam.x, cam.z, this.microTiles, MICRO_RANGE, 2);
      this.evict(this.detailTiles, DETAIL_BUDGET);
      this.evict(this.microTiles, MICRO_BUDGET);
    }

    // A camera teleport (the QA harness, or a jump cut) deserves a big slice.
    const budget = moved > 150 || ctx.elapsed < 6 ? 16 : 5;
    while (this.queue.length) {
      if (performance.now() - t0 > budget) break;
      const tile = this.queue.shift()!;
      const tier = this.queueTier.shift()!;
      if (tile.group) continue;
      this.buildTile(tile, tier);
    }

    let draws = 0;
    for (const g of this.baseGroup.children) if (g.visible) draws += g.children.length;
    for (const g of this.detailGroup.children) if (g.visible) draws += g.children.length;
    for (const g of this.microGroup.children) if (g.visible) draws += g.children.length;
    draws += this.structGroup.children.length;

    this.buildMs = this.buildMs * 0.9 + (performance.now() - t0) * 0.1;
    ctx.stats.roadMs = Math.round(this.buildMs * 100) / 100;
    ctx.stats.roadMeshes = draws;
    ctx.stats.roadTris = this.tris;
    ctx.stats.roadQueue = this.queue.length;
  }

  /** Queues tiles in range, newest-nearest first, and hides the rest. */
  private plan(
    cx: number, cz: number, map: Map<number, Tile>, range: number, tier: 1 | 2,
  ): void {
    const want: Tile[] = [];
    for (const tile of map.values()) {
      const d = Math.hypot(tile.cx - cx, tile.cz - cz) - tile.extent;
      const inRange = d < range;
      if (tile.group) {
        tile.group.visible = inRange;
        if (inRange) tile.lastSeen = this.frame;
        continue;
      }
      if (inRange) want.push(tile);
    }
    if (!want.length) return;
    want.sort(
      (a, b) => ((a.cx - cx) ** 2 + (a.cz - cz) ** 2) - ((b.cx - cx) ** 2 + (b.cz - cz) ** 2),
    );
    for (const t of want) {
      if (this.queue.includes(t)) continue;
      this.queue.push(t);
      this.queueTier.push(tier);
    }
  }

  /** Drops the least recently seen built tiles once over budget. */
  private evict(map: Map<number, Tile>, budget: number): void {
    const live: Tile[] = [];
    for (const t of map.values()) if (t.group) live.push(t);
    if (live.length <= budget) return;
    live.sort((a, b) => a.lastSeen - b.lastSeen);
    for (let i = 0; i < live.length - budget; i++) {
      const t = live[i];
      const g = t.group;
      if (!g || t.lastSeen === this.frame) continue;
      g.parent?.remove(g);
      disposeGroup(g);
      t.group = null;
    }
  }

  dispose(ctx: Ctx): void {
    this.disposed = true;
    disposeGroup(this.root);
    ctx.scene.remove(this.root);
    this.mats?.dispose();
    disposeFallbacks();
    this.items.length = 0;
    this.junctions.length = 0;
    this.baseTiles.clear();
    this.detailTiles.clear();
    this.microTiles.clear();
    this.queue.length = 0;
  }
}

/* ----------------------------------------------------------------- utils */

function yieldFrame(): Promise<void> {
  return new Promise((r) => requestAnimationFrame(() => r()));
}

function disposeGroup(g: THREE.Object3D): void {
  g.traverse((o) => {
    const m = o as THREE.Mesh;
    if (m.isMesh) m.geometry?.dispose();
  });
  g.clear();
}

/** Keeps the merged-geometry accumulator exported for tests and tooling. */
export { MeshBuilder, TUNE };
