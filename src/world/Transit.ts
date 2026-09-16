import * as THREE from 'three';
import type { Ctx, WorldModule } from '../core/Context';
import type { QualityTier } from '../core/config';
import type { RoadRecord } from '../core/types';
import { loadRoads } from '../core/data';
import {
  buildRailGraph, pickNext, sampleEdge, type EdgeSample, type RailGraph,
} from './transit/graph';
import { SYSTEM_IDS, SYSTEM_LABEL, type SystemId } from './transit/lines';
import { lampGeometry, railStock, type RailCarDef } from './transit/stock';
import { buildCatenary } from './transit/wire';

/**
 * The T, running on the surface trackage `Roads` already draws.
 *
 * A train is not a vehicle with a position; it is a *head* moving along a
 * track graph plus a fixed list of cars at arc-length offsets behind it. Each
 * car samples the centreline independently at its own offset, which is what
 * makes a six-car train bend correctly through a curve instead of the cars
 * fanning out like a rigid body would. The offset can reach back past the
 * edge the head is currently on — a 150 m commuter consist regularly spans
 * three or four short OSM ways — so every train keeps a short history of the
 * edges its head has already left, trimmed to whatever length the consist
 * still needs.
 *
 * Everything else follows `Traffic`'s established shape: one graph per
 * system built the same way as the road lane graph, a fixed pool of trains
 * simulated near the camera and recycled beyond it, instanced geometry with
 * baked vertex colour so every line shares one shell material, and lights
 * that divide by `ctx.exposure` so they read correctly whenever the night
 * exposure lifts.
 */

const RECYCLE_HISTORY_MARGIN = 30;

const TRAIN_POOL: Record<SystemId, Record<QualityTier, number>> = {
  green: { low: 4, medium: 6, high: 9, ultra: 12 },
  red: { low: 1, medium: 2, high: 3, ultra: 4 },
  orange: { low: 1, medium: 2, high: 3, ultra: 4 },
  blue: { low: 1, medium: 2, high: 3, ultra: 4 },
  commuter: { low: 1, medium: 2, high: 3, ultra: 4 },
};

/** Worst-case cars of each rolling-stock type a single spawned train can carry, for sizing capacity. */
const MAX_CARS_PER_TRAIN: Record<string, number> = {
  green: 2, red: 6, orange: 6, blue: 4, 'commuter-loco': 1, 'commuter-coach': 6,
};

const SYSTEM_TUNE: Record<SystemId, {
  cruiseMin: number; cruiseMax: number; simRadius: number; recycleMargin: number;
  /** Minimum clearance enforced between two trains of this system at spawn time. */
  minSep: number;
}> = {
  green: { cruiseMin: 8, cruiseMax: 13, simRadius: 550, recycleMargin: 120, minSep: 70 },
  red: { cruiseMin: 13, cruiseMax: 19, simRadius: 750, recycleMargin: 150, minSep: 170 },
  orange: { cruiseMin: 13, cruiseMax: 19, simRadius: 750, recycleMargin: 150, minSep: 170 },
  blue: { cruiseMin: 12, cruiseMax: 17, simRadius: 700, recycleMargin: 140, minSep: 90 },
  commuter: { cruiseMin: 18, cruiseMax: 27, simRadius: 1100, recycleMargin: 200, minSep: 220 },
};

/** Coupler gap between cars, metres — varies a little with how chunky the stock is. */
const GAP: Record<SystemId, number> = { green: 0.34, red: 0.42, orange: 0.42, blue: 0.42, commuter: 0.58 };

interface HistoryLink { edge: number; length: number }

interface Train {
  /** Def index (into `Transit.defs`) for each car, front to back. */
  cars: number[];
  /** Distance from the train's head to the front of each car. */
  frontOffset: number[];
  /** Total length of the consist, nose to tail. */
  totalLen: number;
  edge: number;
  /** Distance travelled along the current head edge. */
  s: number;
  speed: number;
  cruise: number;
  history: HistoryLink[];
  active: boolean;
  /** World position of the head, cached each frame so other trains can spawn clear of it. */
  headX: number;
  headZ: number;
  /** Head heading, cached each frame alongside the position so another train
   *  can tell whether it is closing on this one from behind (same system,
   *  same direction) rather than approaching it head-on. */
  headHX: number;
  headHZ: number;
}

interface SysEntry {
  id: SystemId;
  graph: RailGraph;
  trains: Train[];
  cruiseMin: number;
  cruiseMax: number;
  simRadius: number;
  recycleMargin: number;
  minSep: number;
  spawnCursor: number;
}

const yawOf = (dx: number, dz: number): number => Math.atan2(-dz, dx);

/** Position and heading a distance `offset` behind a train's head, walking into its history if needed. */
function sampleBehind(graph: RailGraph, train: Train, offset: number, out: EdgeSample): void {
  if (offset <= train.s) { sampleEdge(graph.edges[train.edge], train.s - offset, out); return; }
  let remaining = offset - train.s;
  for (const h of train.history) {
    if (remaining <= h.length) { sampleEdge(graph.edges[h.edge], h.length - remaining, out); return; }
    remaining -= h.length;
  }
  const last = train.history[train.history.length - 1];
  sampleEdge(graph.edges[last ? last.edge : train.edge], 0, out);
}

export class Transit implements WorldModule {
  readonly name = 'Transit';

  private root = new THREE.Group();
  private ready = false;

  private defs: RailCarDef[] = [];
  private defIndex: Record<SystemId, number[]> = { green: [], red: [], orange: [], blue: [], commuter: [] };
  private carShell: THREE.InstancedMesh[] = [];
  private carGlass: THREE.InstancedMesh[] = [];
  private carCursor: number[] = [];

  private headLamp: THREE.InstancedMesh | null = null;
  private tailLamp: THREE.InstancedMesh | null = null;
  private headCursor = 0;
  private tailCursor = 0;

  private wireMesh: THREE.Mesh | null = null;
  private poleMesh: THREE.Mesh | null = null;

  private systems: SysEntry[] = [];

  private materials: THREE.Material[] = [];
  private nightLit: THREE.MeshStandardMaterial[] = [];

  async init(ctx: Ctx): Promise<void> {
    this.root.name = 'transit';
    ctx.scene.add(this.root);

    let roads: RoadRecord[] = [];
    try {
      roads = await loadRoads();
    } catch (err) {
      console.warn('[Transit] data unavailable; skipping', err);
      return;
    }

    const graphs = new Map<SystemId, RailGraph>();
    for (const id of SYSTEM_IDS) graphs.set(id, buildRailGraph(roads, id));

    const totalEdges = SYSTEM_IDS.reduce((n, id) => n + graphs.get(id)!.edges.length, 0);
    if (!totalEdges) {
      console.warn('[Transit] no surface rail found');
      return;
    }

    this.buildStock(ctx);
    this.buildLamps(ctx);
    this.buildWire(roads);

    for (const id of SYSTEM_IDS) {
      const graph = graphs.get(id)!;
      const tune = SYSTEM_TUNE[id];
      const poolSize = graph.edges.length ? (TRAIN_POOL[id][ctx.tier] ?? TRAIN_POOL[id].high) : 0;
      const trains: Train[] = [];
      for (let i = 0; i < poolSize; i++) {
        trains.push({
          cars: [], frontOffset: [], totalLen: 0, edge: 0, s: 0, speed: 0, cruise: 0,
          history: [], active: false, headX: 0, headZ: 0, headHX: 1, headHZ: 0,
        });
      }
      this.systems.push({
        id, graph, trains,
        cruiseMin: tune.cruiseMin, cruiseMax: tune.cruiseMax,
        simRadius: tune.simRadius, recycleMargin: tune.recycleMargin, minSep: tune.minSep,
        spawnCursor: 0,
      });
    }

    let trainCount = 0;
    const parts: string[] = [];
    for (const sys of this.systems) {
      trainCount += sys.trains.length;
      parts.push(`${SYSTEM_LABEL[sys.id]} ${sys.trains.length} on ${sys.graph.totalKm.toFixed(1)} km`);
    }
    ctx.stats.railKm = Math.round(this.systems.reduce((n, s) => n + s.graph.totalKm, 0) * 10) / 10;
    ctx.stats.trains = trainCount;
    console.info(`[Transit] ${parts.join(', ')}`);

    this.ready = true;
  }

  /* ------------------------------------------------------------- geometry */

  private buildStock(ctx: Ctx): void {
    this.defs = railStock();
    for (let i = 0; i < this.defs.length; i++) {
      const d = this.defs[i];
      const sys = defSystem(d.key);
      (this.defIndex[sys] ??= []).push(i);
    }

    // Painted steel, not bare metal: a dark, saturated body colour (the
    // green, the purple) read as almost black at anything but a direct
    // specular angle when this carried the same metalness road vehicles use
    // — cars get away with it because their palette is mostly pale. Lower
    // metalness keeps the diffuse vertex colour the dominant signal from any
    // angle, with just enough left for a believable painted-metal sheen.
    const shellMat = new THREE.MeshStandardMaterial({
      name: 'rail:shell', color: 0xffffff, roughness: 0.62, metalness: 0.08,
      vertexColors: true, envMapIntensity: 0.4,
    });
    const glassMat = new THREE.MeshStandardMaterial({
      name: 'rail:glass', color: 0x0c1116, roughness: 0.10, metalness: 0.5,
      envMapIntensity: 1.5, emissive: new THREE.Color(0xffd8a0), emissiveIntensity: 0,
    });
    glassMat.userData.nightPeak = 1.35;
    this.materials.push(shellMat, glassMat);
    this.nightLit.push(glassMat);

    for (let i = 0; i < this.defs.length; i++) {
      const d = this.defs[i];
      const sys = defSystem(d.key);
      const cap = Math.max(1, (TRAIN_POOL[sys][ctx.tier] ?? TRAIN_POOL[sys].high) * carsPerTrainOf(d.key));

      const shell = new THREE.InstancedMesh(d.parts.shell ?? new THREE.BufferGeometry(), shellMat, cap);
      shell.name = `transit:${d.key}:shell`;
      shell.castShadow = true;
      shell.receiveShadow = true;
      shell.frustumCulled = false;
      shell.count = 0;
      this.root.add(shell);
      this.carShell.push(shell);

      const glass = new THREE.InstancedMesh(d.parts.glass ?? new THREE.BufferGeometry(), glassMat, cap);
      glass.name = `transit:${d.key}:glass`;
      glass.castShadow = false;
      glass.receiveShadow = true;
      glass.userData.noShadow = true;
      glass.frustumCulled = false;
      glass.count = 0;
      this.root.add(glass);
      this.carGlass.push(glass);

      this.carCursor.push(0);
    }
  }

  private buildLamps(ctx: Ctx): void {
    const totalTrains = SYSTEM_IDS.reduce(
      (n, id) => n + (TRAIN_POOL[id][ctx.tier] ?? TRAIN_POOL[id].high), 0,
    );
    const geo = lampGeometry();

    const headMat = new THREE.MeshStandardMaterial({
      name: 'rail:headlamp', color: 0x201c14, roughness: 0.4, metalness: 0.1,
      emissive: new THREE.Color(0xfff0cc), emissiveIntensity: 0,
    });
    headMat.userData.nightPeak = 4.0;
    const tailMat = new THREE.MeshStandardMaterial({
      name: 'rail:taillamp', color: 0x1a0a08, roughness: 0.4, metalness: 0.1,
      emissive: new THREE.Color(0xff1206), emissiveIntensity: 0,
    });
    tailMat.userData.nightPeak = 2.8;
    this.materials.push(headMat, tailMat);
    this.nightLit.push(headMat, tailMat);

    const head = new THREE.InstancedMesh(geo, headMat, Math.max(1, totalTrains));
    head.name = 'transit:headlamp';
    head.frustumCulled = false;
    head.castShadow = false;
    head.receiveShadow = false;
    head.userData.noShadow = true;
    head.count = 0;
    this.root.add(head);
    this.headLamp = head;

    const tail = new THREE.InstancedMesh(geo, tailMat, Math.max(1, totalTrains));
    tail.name = 'transit:taillamp';
    tail.frustumCulled = false;
    tail.castShadow = false;
    tail.receiveShadow = false;
    tail.userData.noShadow = true;
    tail.count = 0;
    this.root.add(tail);
    this.tailLamp = tail;
  }

  /**
   * Static overhead contact wire and support poles for the Green Line's
   * surface running — see `transit/wire.ts`. Built once from the raw road
   * records, not per-frame and not per-train, as one merged mesh apiece: the
   * whole network costs two draw calls regardless of route length, and
   * neither mesh ever needs to move or be re-instanced per car the way the
   * rolling stock does.
   */
  private buildWire(roads: RoadRecord[]): void {
    const { wire, poles } = buildCatenary(roads);

    if (wire) {
      const mat = new THREE.MeshStandardMaterial({
        name: 'rail:wire', color: 0x4a3a28, roughness: 0.45, metalness: 0.75,
      });
      this.materials.push(mat);
      const mesh = new THREE.Mesh(wire, mat);
      mesh.name = 'transit:wire';
      mesh.castShadow = false;
      mesh.receiveShadow = false;
      mesh.userData.noShadow = true; // a paper-thin wire casting a shadow reads as noise, not infrastructure
      mesh.frustumCulled = false;
      this.root.add(mesh);
      this.wireMesh = mesh;
    }

    if (poles) {
      const mat = new THREE.MeshStandardMaterial({
        name: 'rail:pole', color: 0x2b2d30, roughness: 0.55, metalness: 0.5,
      });
      this.materials.push(mat);
      const mesh = new THREE.Mesh(poles, mat);
      mesh.name = 'transit:pole';
      mesh.receiveShadow = true;
      mesh.frustumCulled = false;
      this.root.add(mesh);
      this.poleMesh = mesh;
    }
  }

  /* ------------------------------------------------------------- consists */

  private composeConsist(train: Train, id: SystemId): void {
    const idx = this.defIndex[id];
    const cars: number[] = [];
    switch (id) {
      case 'green': {
        const n = Math.random() < 0.55 ? 1 : 2;
        for (let i = 0; i < n; i++) cars.push(idx[0]);
        break;
      }
      case 'red':
      case 'orange':
        for (let i = 0; i < 6; i++) cars.push(idx[0]);
        break;
      case 'blue':
        for (let i = 0; i < 4; i++) cars.push(idx[0]);
        break;
      case 'commuter': {
        const locoIdx = idx.find((i) => this.defs[i].key === 'commuter-loco')!;
        const coachIdx = idx.find((i) => this.defs[i].key === 'commuter-coach')!;
        cars.push(locoIdx);
        const n = 3 + Math.floor(Math.random() * 4);
        for (let i = 0; i < n; i++) cars.push(coachIdx);
        break;
      }
    }
    const gap = GAP[id];
    train.cars = cars;
    train.frontOffset = new Array(cars.length);
    let cum = 0;
    for (let i = 0; i < cars.length; i++) {
      train.frontOffset[i] = cum;
      cum += this.defs[cars[i]].length + gap;
    }
    train.totalLen = cum - gap;
    train.history.length = 0;
  }

  /* ---------------------------------------------------------------- spawn */

  private spawn(train: Train, sys: SysEntry, ctx: Ctx): void {
    const g = sys.graph;
    if (!g.edges.length) { train.active = false; return; }
    const cam = ctx.camera.position;
    const radius = this.simRadiusFor(sys, ctx);
    const minSep2 = sys.minSep * sys.minSep;
    for (let attempt = 0; attempt < 24; attempt++) {
      const ei = (sys.spawnCursor = (sys.spawnCursor + 6151) % g.edges.length);
      const e = g.edges[ei];
      const mid = Math.floor(e.cum.length / 2) * 3;
      const mx = e.pts[mid];
      const mz = e.pts[mid + 2];
      const dx = mx - cam.x;
      const dz = mz - cam.z;
      if (dx * dx + dz * dz > radius * radius) continue;
      // Keep clear of every other live train of this system. Without this, a
      // camera jump that recycles most of a small pool in the same frame —
      // exactly what the QA harness's `setView` does — could respawn several
      // of them onto the same short stretch of track with nothing to notice
      // or separate them afterwards, and they would ride one inside another
      // indefinitely.
      let blocked = false;
      for (const other of sys.trains) {
        if (other === train || !other.active) continue;
        const ox = mx - other.headX;
        const oz = mz - other.headZ;
        if (ox * ox + oz * oz < minSep2) { blocked = true; break; }
      }
      if (blocked) continue;
      this.composeConsist(train, sys.id);
      train.edge = ei;
      train.s = Math.random() * e.length;
      train.cruise = sys.cruiseMin + Math.random() * (sys.cruiseMax - sys.cruiseMin);
      train.speed = train.cruise;
      train.headX = mx;
      train.headZ = mz;
      train.active = true;
      return;
    }
    train.active = false;
  }

  private simRadiusFor(sys: SysEntry, ctx: Ctx): number {
    return sys.simRadius + THREE.MathUtils.clamp(ctx.camera.position.y - 60, 0, 800) * 1.1;
  }

  /* ----------------------------------------------------------- simulation */

  private stepSystem(sys: SysEntry, dt: number, ctx: Ctx): void {
    const g = sys.graph;
    if (!g.edges.length) return;
    const cam = ctx.camera.position;
    const radius = this.simRadiusFor(sys, ctx);
    const recycle = radius + sys.recycleMargin;

    const headSample: EdgeSample = { x: 0, y: 0, z: 0, hx: 1, hy: 0, hz: 0 };
    const carSample: EdgeSample = { x: 0, y: 0, z: 0, hx: 1, hy: 0, hz: 0 };
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const tilt = new THREE.Quaternion();
    const euler = new THREE.Euler();
    const up = new THREE.Vector3(0, 1, 0);
    const pos = new THREE.Vector3();
    const one = new THREE.Vector3(1, 1, 1);

    for (const train of sys.trains) {
      if (!train.active) { this.spawn(train, sys, ctx); if (!train.active) continue; }

      let e = g.edges[train.edge];

      // Ease toward cruise, slowing a little through a sharply bent edge —
      // there is no separate "curve" tag, but an edge that bends a lot
      // between its own start and end heading is a curve worth slowing for.
      const bend = 1 - (e.sx * e.ex + e.sz * e.ez);
      let vLimit = train.cruise * THREE.MathUtils.clamp(1 - 0.4 * Math.min(bend, 1.4), 0.45, 1);

      // Keep a following gap. Spawning already refuses to place a train
      // within `minSep` of another, but that only guards the moment it
      // appears -- nothing since stopped a faster train riding up on a
      // slower one it was never spawned near, which is how two same-
      // direction cars ended up nearly nose to tail. A cheap O(pool) scan
      // against the (last frame's) head of every other active train in this
      // system is enough at these pool sizes (a dozen at most).
      const followMin = train.totalLen + 14;
      let followGap = Infinity;
      for (const other of sys.trains) {
        if (other === train || !other.active) continue;
        const dx = other.headX - train.headX;
        const dz = other.headZ - train.headZ;
        // Ahead of me, and heading the same way I am -- a train coming the
        // other way is the overlap fix's job, not a following distance.
        if (dx * train.headHX + dz * train.headHZ <= 0) continue;
        if (other.headHX * train.headHX + other.headHZ * train.headHZ < 0.5) continue;
        const gap = Math.hypot(dx, dz);
        if (gap < followGap) followGap = gap;
      }
      if (followGap < followMin) {
        const t = THREE.MathUtils.clamp(followGap / followMin, 0, 1);
        vLimit = Math.min(vLimit, train.cruise * t * t);
      }

      const accel = THREE.MathUtils.clamp((vLimit - train.speed) * 1.1, -1.8, 1.1);
      train.speed = Math.max(0, train.speed + accel * dt);
      train.s += train.speed * dt;

      while (train.s >= e.length) {
        train.history.unshift({ edge: train.edge, length: e.length });
        let sum = 0;
        let cut = train.history.length - 1;
        for (let k = 0; k < train.history.length; k++) {
          sum += train.history[k].length;
          if (sum >= train.totalLen + RECYCLE_HISTORY_MARGIN) { cut = k; break; }
        }
        train.history.length = cut + 1;

        const next = pickNext(g, train.edge);
        if (next < 0) { train.active = false; break; }
        train.s -= e.length;
        train.edge = next;
        e = g.edges[train.edge];
      }
      if (!train.active) continue;

      sampleEdge(e, train.s, headSample);
      train.headX = headSample.x;
      train.headZ = headSample.z;
      train.headHX = headSample.hx;
      train.headHZ = headSample.hz;
      const hdx = headSample.x - cam.x;
      const hdz = headSample.z - cam.z;
      if (hdx * hdx + hdz * hdz > recycle * recycle) { train.active = false; continue; }

      for (let i = 0; i < train.cars.length; i++) {
        const di = train.cars[i];
        const cursor = this.carCursor[di];
        const shell = this.carShell[di];
        if (cursor >= shell.instanceMatrix.count) continue;

        const centerOffset = train.frontOffset[i] + this.defs[di].length / 2;
        sampleBehind(g, train, centerOffset, carSample);
        this.composeMatrix(carSample, m, q, tilt, euler, up, pos, one);
        shell.setMatrixAt(cursor, m);
        this.carGlass[di].setMatrixAt(cursor, m);
        this.carCursor[di] = cursor + 1;
      }

      if (this.headLamp && this.headCursor < this.headLamp.instanceMatrix.count) {
        const lampY = this.defs[train.cars[0]].lampY;
        this.composeMatrix(headSample, m, q, tilt, euler, up, pos, one, lampY);
        this.headLamp.setMatrixAt(this.headCursor++, m);
      }
      if (this.tailLamp && this.tailCursor < this.tailLamp.instanceMatrix.count) {
        sampleBehind(g, train, train.totalLen, carSample);
        const lampY = this.defs[train.cars[train.cars.length - 1]].lampY;
        this.composeMatrix(carSample, m, q, tilt, euler, up, pos, one, lampY);
        this.tailLamp.setMatrixAt(this.tailCursor++, m);
      }
    }
  }

  private composeMatrix(
    s: EdgeSample, m: THREE.Matrix4, q: THREE.Quaternion, tilt: THREE.Quaternion,
    euler: THREE.Euler, up: THREE.Vector3, pos: THREE.Vector3, one: THREE.Vector3,
    lift = 0,
  ): void {
    pos.set(s.x, s.y + lift, s.z);
    q.setFromAxisAngle(up, yawOf(s.hx, s.hz));
    euler.set(0, 0, Math.asin(THREE.MathUtils.clamp(s.hy, -1, 1)), 'XYZ');
    tilt.setFromEuler(euler);
    q.multiply(tilt);
    m.compose(pos, q, one);
  }

  /* --------------------------------------------------------------- frame */

  update(dt: number, ctx: Ctx): void {
    if (!this.ready) return;

    // Same civil-twilight curve and exposure compensation as every other
    // emissive in the city — see `Ctx.exposure`.
    const elev = ctx.sun?.elevation ?? 0.5;
    const t = THREE.MathUtils.clamp((0.16 - elev) / 0.22, 0, 1);
    const night = t * t * (3 - 2 * t);
    const comp = 2.5 / Math.max(ctx.exposure || 2.5, 0.1);
    for (const m of this.nightLit) {
      m.emissiveIntensity = night * comp * ((m.userData.nightPeak as number) ?? 1);
    }

    for (let i = 0; i < this.carCursor.length; i++) this.carCursor[i] = 0;
    this.headCursor = 0;
    this.tailCursor = 0;

    for (const sys of this.systems) this.stepSystem(sys, dt, ctx);

    for (let i = 0; i < this.defs.length; i++) {
      this.carShell[i].count = this.carCursor[i];
      this.carShell[i].instanceMatrix.needsUpdate = true;
      this.carGlass[i].count = this.carCursor[i];
      this.carGlass[i].instanceMatrix.needsUpdate = true;
    }
    if (this.headLamp) { this.headLamp.count = this.headCursor; this.headLamp.instanceMatrix.needsUpdate = true; }
    if (this.tailLamp) { this.tailLamp.count = this.tailCursor; this.tailLamp.instanceMatrix.needsUpdate = true; }

    ctx.stats.railCarsDrawn = this.carCursor.reduce((a, b) => a + b, 0);
  }

  dispose(ctx: Ctx): void {
    ctx.scene.remove(this.root);
    this.root.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (mesh.isMesh) mesh.geometry?.dispose();
    });
    for (const m of this.materials) m.dispose();
    this.materials.length = 0;
    this.systems.length = 0;
  }
}

function defSystem(key: string): SystemId {
  if (key.startsWith('commuter')) return 'commuter';
  return key as SystemId;
}

function carsPerTrainOf(key: string): number {
  return MAX_CARS_PER_TRAIN[key] ?? 1;
}
