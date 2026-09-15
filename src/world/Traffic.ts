import * as THREE from 'three';
import type { Ctx, WorldModule } from '../core/Context';
import type { AreaRecord, PropSet, RoadRecord } from '../core/types';
import { loadAreas, loadProps, loadRoads } from '../core/data';
import { buildLaneGraph, sampleEdge, LANE_W, type LaneGraph } from './traffic/graph';
import {
  vehicleTypes, pedestrianGeometry, CAR_COLORS, CLOTHES,
  WHEEL_VERT_PARS, WHEEL_VERT_POS, WHEEL_VERT_NRM, WALK_VERT_PARS, WALK_VERT_POS,
  type Part, type VehicleDef,
} from './traffic/vehicles';
import {
  vesselTypes, flagGeometry, flagTexture, wakeGeometry, wakeTexture,
  ROW_VERT_PARS, ROW_VERT_POS, type VesselDef, type VesselPart,
} from './traffic/vessels';
import { AirTraffic } from './traffic/aircraft';

/**
 * Everything in the city that moves: road traffic, people, boats, aircraft
 * and flags.
 *
 * Simulating 1,262 km of street would be pointless — you can only see a few
 * hundred metres of it. Instead a fixed pool of vehicles is kept alive near
 * the camera: each one drives its edge, picks a new one at the junction, and
 * when it falls too far behind it is recycled onto a road just outside the
 * view. The pool size is constant, so cost does not depend on how big the
 * road network is. Boats work the same way; aircraft do not, because six of
 * them are visible from the whole city at once.
 *
 * Three things here are worth knowing before changing anything:
 *
 *   *Heading.* The world is +X east, +Y up, +Z south — a left-handed
 *   geographic frame sitting inside three's right-handed one. Every model is
 *   authored +X forward, so the yaw that points it along a direction (dx,dz)
 *   is `atan2(-dz, dx)`, and the right-hand side of the road is `(-dz, dx)`.
 *   Both were inverted here once, which put every car, pedestrian and boat
 *   broadside to its own direction of travel and every vehicle in the
 *   left-hand lane.
 *
 *   *Animation lives in the vertex stage.* Wheels roll and steer, limbs swing,
 *   oars sweep and rotors turn from per-instance attributes. The CPU writes
 *   one matrix and two floats per object per frame and nothing else.
 *
 *   *Lights are display-referred.* Head, tail, brake and position lamps all
 *   divide by `ctx.exposure` — the exposure the frame is actually presented
 *   at, not the sky's artistic value — or they clip to white blocks at night.
 */

/** Vehicles are simulated within this radius of the camera; beyond it they recycle. */
const SIM_RADIUS = 420;
/** …widened when the camera climbs, so a rooftop view is not an empty grid. */
const SIM_ALTITUDE_GAIN = 0.9;
const RECYCLE_MARGIN = 100;

const POOL: Record<string, number> = { low: 120, medium: 300, high: 650, ultra: 1000 };
const WALKERS: Record<string, number> = { low: 60, medium: 180, high: 400, ultra: 650 };
/** People are only legible close in, so they live in a tighter bubble. */
const WALK_RADIUS = 170;
const WALK_RECYCLE = 220;
const BOATS: Record<string, number> = { low: 10, medium: 22, high: 38, ultra: 58 };
/** Boats are large and read from much further out than a car. */
const BOAT_RADIUS = 1500;

/** Intelligent-driver-model constants: comfortable accel/brake, gap, headway. */
const ACC = 1.7;
const DEC = 2.6;
const GAP0 = 2.4;
const HEADWAY = 1.25;
/** Signal cycle, seconds. Two phases with a short all-red between them. */
const SIGNAL_CYCLE = 20;

interface Car {
  type: number;
  edge: number;
  /** Distance along the edge, metres. */
  s: number;
  lane: number;
  speed: number;
  /** Free-flow speed for this car on this edge. */
  cruise: number;
  colour: number;
  active: boolean;
  /** Successor edge, chosen on arrival so the junction can be approached knowingly. */
  next: number;
  /** Smoothed yaw, so a car steers through a corner instead of snapping to it. */
  yaw: number;
  /** Accumulated wheel angle, radians. */
  roll: number;
  /** Front-wheel steer angle, radians. */
  steer: number;
  /** Tail-lamp brightness, 0..1. */
  brake: number;
  /** Body roll into the corner and pitch under braking. */
  lean: number;
  pitch: number;
  /** Seconds spent stationary, so a gridlock eventually breaks itself. */
  stuck: number;
}

interface Walker {
  edge: number;
  s: number;
  /** Offset to the right of the path centreline, so streams pass correctly. */
  side: number;
  /** Personal space within the stream, added to the kerb offset. */
  lane: number;
  speed: number;
  /** Speed this walker wants; they slow for the person in front. */
  cruise: number;
  colour: number;
  /** Accumulated stride phase, so the walk cycle matches the ground speed. */
  phase: number;
  yaw: number;
  /** Height and build multipliers: a crowd of clones reads as a crowd of clones. */
  tall: number;
  build: number;
  /** Seconds left standing still. */
  idle: number;
  active: boolean;
}

interface Boat {
  type: number;
  x: number; z: number;
  /** Yaw in the same convention as everything else: atan2(-dz, dx). */
  yaw: number;
  /** Heading it is steering toward. */
  want: number;
  speed: number;
  colour: number;
  /** Stroke phase for the rowing boats. */
  stroke: number;
  /** Seconds until the next course check; staggered so the cost spreads. */
  recheck: number;
}

interface Bucket {
  mesh: THREE.InstancedMesh;
  part: Part | VesselPart;
}

/** Yaw that points a +X-forward model along (dx, dz). See the module note. */
const yawOf = (dx: number, dz: number): number => Math.atan2(-dz, dx);

export class Traffic implements WorldModule {
  readonly name = 'Traffic';

  private root = new THREE.Group();
  private graph: LaneGraph | null = null;

  private defs: VehicleDef[] = [];
  private cars: Car[] = [];
  /** Per vehicle type, per part: the instanced mesh to write into. */
  private carMeshes: Bucket[][] = [];
  private typeOrder: number[] = [];
  /** Per type: the instanced attributes the shader animates. */
  private carRoll: THREE.InstancedBufferAttribute[] = [];
  private carSteer: THREE.InstancedBufferAttribute[] = [];
  private carBrake: THREE.InstancedBufferAttribute[] = [];

  /** Edge start/end unit headings, [sx,sz,ex,ez] per edge; junction choice needs them. */
  private edgeDir: Float32Array = new Float32Array(0);
  /** 1 where the approach to a node runs more east-west than north-south. */
  private edgeAxis: Uint8Array = new Uint8Array(0);
  /** Nodes carrying a mapped traffic signal. */
  private signal: Uint8Array = new Uint8Array(0);
  /** Scratch for the car-following pass; reused so the frame allocates nothing. */
  private order: number[] = [];
  private sortKey: Float64Array = new Float64Array(0);
  private claimDist = new Map<number, number>();
  private claimCar = new Map<number, number>();
  private leaderOf = new Map<number, number>();
  private firstOn = new Map<number, number>();

  private vdefs: VesselDef[] = [];
  private boats: Boat[] = [];
  private boatMeshes: Bucket[][] = [];
  private boatStroke: THREE.InstancedBufferAttribute[] = [];
  private wakeMesh: THREE.InstancedMesh | null = null;
  private wakeFade: THREE.InstancedBufferAttribute | null = null;
  /** Sampled water cells boats are allowed to occupy: [x,z,riverFlag]. */
  private waterCells: Float32Array = new Float32Array(0);
  /** Scratch for the camera's forward vector; boats spawn out of shot. */
  private camFwd = new THREE.Vector3();
  /** Coarse bucket index over `waterCells`, so "am I still afloat?" is O(1). */
  private cellGrid = new Map<number, number[]>();

  private walkGraph: LaneGraph | null = null;
  private walkers: Walker[] = [];
  private walkMesh: THREE.InstancedMesh | null = null;
  private walkPhase: THREE.InstancedBufferAttribute | null = null;
  private walkSwing: THREE.InstancedBufferAttribute | null = null;
  private walkSpawn = 0;
  /** Metres from each walk edge's centreline to the footway beside it. */
  private walkKerb: Float32Array = new Float32Array(0);
  /** Scratch for the pedestrian queueing pass; allocated once. */
  private walkOrder: number[] = [];
  private walkKey: Float64Array = new Float64Array(0);

  private air = new AirTraffic();

  private flagMesh: THREE.InstancedMesh | null = null;
  private flagUniforms = { uTime: { value: 0 }, uWind: { value: new THREE.Vector2(0.72, -0.69) } };
  private lampUniforms = { uNight: { value: 0 }, uBrake: { value: 0 } };

  private materials: THREE.Material[] = [];
  private nightLit: THREE.MeshStandardMaterial[] = [];
  private time = 0;
  private spawnCursor = 0;

  async init(ctx: Ctx): Promise<void> {
    this.root.name = 'traffic';
    ctx.scene.add(this.root);

    let roads: RoadRecord[] = [];
    let areas: AreaRecord[] = [];
    let props: PropSet[] = [];
    try {
      [roads, areas, props] = await Promise.all([loadRoads(), loadAreas(), loadProps()]);
    } catch (err) {
      console.warn('[Traffic] data unavailable; skipping', err);
      return;
    }

    this.graph = buildLaneGraph(roads);
    if (!this.graph.edges.length) {
      console.warn('[Traffic] no driveable edges');
      return;
    }

    this.indexNetwork(props);
    this.buildVehicles(ctx);
    this.buildWalkers(ctx, roads);
    this.buildWaterCells(areas);
    this.buildVessels(ctx);
    this.air.build(ctx, this.root);
    this.buildFlags(ctx, props);

    ctx.stats.trafficEdges = this.graph.edges.length;
    ctx.stats.vehicles = this.cars.length;
    ctx.stats.boats = this.boats.length;
    ctx.stats.pedestrians = this.walkers.length;
    ctx.stats.aircraft = this.air.count;
    let signals = 0;
    for (const s of this.signal) signals += s;
    console.info(
      `[Traffic] ${this.graph.edges.length} lane edges over ${this.graph.totalKm.toFixed(0)} km, ` +
      `${signals} signalised junctions, ${this.cars.length} vehicles, ` +
      `${this.walkers.length} pedestrians, ${this.boats.length} vessels, ` +
      `${this.air.count} aircraft, ${this.flagMesh?.count ?? 0} flags`,
    );

    ctx.on('quality-changed', () => this.resizePool(ctx));
  }

  /**
   * Precompute what the driving model needs from the graph: the heading at
   * each end of every edge (for choosing a plausible successor and for the
   * signal phase), and which junctions are signalised.
   */
  private indexNetwork(props: PropSet[]): void {
    const g = this.graph!;
    const n = g.edges.length;
    this.edgeDir = new Float32Array(n * 4);
    this.edgeAxis = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
      const e = g.edges[i];
      const m = e.pts.length / 3;
      const sx = e.pts[3] - e.pts[0];
      const sz = e.pts[5] - e.pts[2];
      const ex = e.pts[(m - 1) * 3] - e.pts[(m - 2) * 3];
      const ez = e.pts[(m - 1) * 3 + 2] - e.pts[(m - 2) * 3 + 2];
      const si = 1 / Math.max(Math.hypot(sx, sz), 1e-4);
      const ei = 1 / Math.max(Math.hypot(ex, ez), 1e-4);
      this.edgeDir[i * 4] = sx * si;
      this.edgeDir[i * 4 + 1] = sz * si;
      this.edgeDir[i * 4 + 2] = ex * ei;
      this.edgeDir[i * 4 + 3] = ez * ei;
      this.edgeAxis[i] = Math.abs(ex) >= Math.abs(ez) ? 1 : 0;
    }

    // Snap mapped signals onto graph nodes through a coarse spatial hash.
    const nodes = g.nodes;
    const count = g.out.length;
    this.signal = new Uint8Array(count);
    const CELL = 30;
    const hash = new Map<number, number[]>();
    for (let i = 0; i < count; i++) {
      const k = Math.floor(nodes[i * 3] / CELL) * 65536 + Math.floor(nodes[i * 3 + 2] / CELL);
      const b = hash.get(k);
      if (b) b.push(i); else hash.set(k, [i]);
    }
    for (const set of props) {
      if (set.kind !== 'traffic_signal') continue;
      for (let p = 0; p < set.positions.length; p += 3) {
        const x = set.positions[p];
        const z = set.positions[p + 2];
        const gx = Math.floor(x / CELL);
        const gz = Math.floor(z / CELL);
        let best = -1;
        let bestD = 20 * 20;
        for (let i = -1; i <= 1; i++) {
          for (let j = -1; j <= 1; j++) {
            const b = hash.get((gx + i) * 65536 + (gz + j));
            if (!b) continue;
            for (const ni of b) {
              const dx = nodes[ni * 3] - x;
              const dz = nodes[ni * 3 + 2] - z;
              const d = dx * dx + dz * dz;
              // Only junctions: a signal snapped to a mid-block node would
              // stop a whole street for nothing.
              if (d < bestD && g.out[ni].length >= 2) { bestD = d; best = ni; }
            }
          }
        }
        if (best >= 0) this.signal[best] = 1;
      }
    }
  }

  /* --------------------------------------------------------------- traffic */

  private buildVehicles(ctx: Ctx): void {
    this.defs = vehicleTypes();
    const pool = POOL[ctx.tier] ?? 650;

    // Allocate instance capacity in proportion to each type's share of the mix.
    const total = this.defs.reduce((n, d) => n + d.weight, 0);
    for (let t = 0; t < this.defs.length; t++) {
      const d = this.defs[t];
      const cap = Math.max(4, Math.round((pool * d.weight) / total));
      const buckets: Bucket[] = [];
      const roll = new THREE.InstancedBufferAttribute(new Float32Array(cap), 1);
      const steer = new THREE.InstancedBufferAttribute(new Float32Array(cap), 1);
      const brake = new THREE.InstancedBufferAttribute(new Float32Array(cap), 1);
      this.carRoll.push(roll);
      this.carSteer.push(steer);
      this.carBrake.push(brake);
      for (const [part, geo] of Object.entries(d.parts) as [Part, THREE.BufferGeometry | null][]) {
        if (!geo) continue;
        if (part === 'shell') {
          geo.setAttribute('aRoll', roll);
          geo.setAttribute('aSteer', steer);
        } else if (part === 'light') {
          geo.setAttribute('aBrake', brake);
        }
        const mesh = new THREE.InstancedMesh(geo, this.carMaterial(part, d.color), cap);
        mesh.name = `traffic:${d.name}:${part}`;
        // Only the shell casts: glass and lights add three shadow-cascade
        // draws each for shadows you would never see. `noShadow` is the only
        // channel the scene-shading sweep respects — without it the sweep
        // turns casting back on for every part.
        mesh.castShadow = part === 'shell';
        mesh.receiveShadow = true;
        mesh.userData.noShadow = part !== 'shell';
        mesh.frustumCulled = false;
        mesh.count = 0;
        // Per-instance body colour; the lights and glass ignore it.
        if (part === 'shell' && !d.color) {
          mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(cap * 3), 3);
        }
        this.root.add(mesh);
        buckets.push({ mesh, part });
      }
      this.carMeshes.push(buckets);
      for (let i = 0; i < cap; i++) this.typeOrder.push(t);
    }

    for (let i = 0; i < this.typeOrder.length; i++) {
      this.cars.push({
        type: this.typeOrder[i], edge: -1, s: 0, lane: 0, speed: 0, cruise: 0,
        colour: 0, active: false, next: -1, yaw: 0, roll: 0, steer: 0,
        brake: 0, lean: 0, pitch: 0, stuck: 0,
      });
    }
    this.order = new Array(this.cars.length).fill(0).map((_, i) => i);
    this.sortKey = new Float64Array(this.cars.length);
  }

  private carMaterial(part: Part, fixed?: number): THREE.Material {
    const mk = (o: THREE.MeshStandardMaterialParameters): THREE.MeshStandardMaterial => {
      const m = new THREE.MeshStandardMaterial(o);
      this.materials.push(m);
      return m;
    };
    switch (part) {
      case 'glass':
        return mk({ name: 'car:glass', color: 0x0d1318, roughness: 0.08, metalness: 0.55,
          envMapIntensity: 1.6 });
      case 'light': {
        // One mesh for both ends. `aTail` splits them in the fragment stage so
        // headlamps read warm-white, tail lamps red, and the reds flare under
        // braking — which is most of what a queue of traffic looks like.
        const m = mk({ name: 'car:light', color: 0x2a1c18, roughness: 0.24, metalness: 0.2,
          emissive: new THREE.Color(0xffffff), emissiveIntensity: 1 });
        m.onBeforeCompile = (sh) => {
          sh.uniforms.uNight = this.lampUniforms.uNight;
          sh.uniforms.uBrake = this.lampUniforms.uBrake;
          sh.vertexShader = sh.vertexShader
            .replace('#include <common>',
              '#include <common>\nattribute float aTail;\nattribute float aBrake;\nvarying float vTail;\nvarying float vBrakeAmt;')
            .replace('#include <begin_vertex>',
              '#include <begin_vertex>\nvTail = aTail; vBrakeAmt = aBrake;');
          sh.fragmentShader = sh.fragmentShader
            .replace('#include <common>',
              '#include <common>\nuniform float uNight;\nuniform float uBrake;\nvarying float vTail;\nvarying float vBrakeAmt;')
            .replace('#include <emissivemap_fragment>', /* glsl */ `
              #include <emissivemap_fragment>
              vec3 bhHead = vec3(1.0, 0.80, 0.58) * uNight;
              vec3 bhTail = vec3(1.0, 0.055, 0.02)
                          * (uNight * 0.42 + vBrakeAmt * uBrake);
              totalEmissiveRadiance = mix(bhHead, bhTail, vTail);
            `);
        };
        m.customProgramCacheKey = () => 'car-lamp';
        return m;
      }
      default:
        // Painted bodywork, with trim and tyres baked dark into the vertex
        // colour so the per-instance tint only reaches the panels. The wheels
        // roll and steer from `aRoll`/`aSteer`.
        {
          const m = mk({
            name: 'car:shell',
            color: fixed ?? 0xffffff,
            roughness: 0.28, metalness: 0.35, envMapIntensity: 1.3,
            vertexColors: true,
          });
          m.onBeforeCompile = (sh) => {
            sh.vertexShader = sh.vertexShader
              .replace('#include <common>', `#include <common>\n${WHEEL_VERT_PARS}`)
              .replace('#include <beginnormal_vertex>', `#include <beginnormal_vertex>\n${WHEEL_VERT_NRM}`)
              .replace('#include <begin_vertex>', `#include <begin_vertex>\n${WHEEL_VERT_POS}`);
          };
          m.customProgramCacheKey = () => 'car-shell';
          return m;
        }
    }
  }

  /** How far out vehicles live. Widens with altitude so rooftop views fill. */
  private simRadius(ctx: Ctx): number {
    return SIM_RADIUS + THREE.MathUtils.clamp(ctx.camera.position.y - 60, 0, 340) * SIM_ALTITUDE_GAIN;
  }

  /** Put a car on a road just outside the camera's view. */
  private spawn(car: Car, ctx: Ctx, radius: number): void {
    const g = this.graph!;
    const cam = ctx.camera.position;
    // Rejection-sample a handful of edges rather than searching: the network
    // is dense enough that a few tries almost always lands one in range.
    for (let attempt = 0; attempt < 16; attempt++) {
      const ei = (this.spawnCursor = (this.spawnCursor + 7919) % g.edges.length);
      const e = g.edges[ei];
      const mid = Math.floor(e.cum.length / 2) * 3;
      const dx = e.pts[mid] - cam.x;
      const dz = e.pts[mid + 2] - cam.z;
      if (dx * dx + dz * dz > radius * radius) continue;
      car.edge = ei;
      car.s = Math.random() * e.length;
      car.lane = Math.floor(Math.random() * e.lanes);
      car.cruise = e.speed * (0.78 + Math.random() * 0.34);
      car.speed = car.cruise;
      car.colour = CAR_COLORS[(Math.random() * CAR_COLORS.length) | 0];
      car.next = this.pickNext(ei);
      car.yaw = yawOf(this.edgeDir[ei * 4], this.edgeDir[ei * 4 + 1]);
      car.roll = Math.random() * 6.283;
      car.steer = 0;
      car.brake = 0;
      car.lean = 0;
      car.pitch = 0;
      car.stuck = 0;
      car.active = true;
      return;
    }
    car.active = false;
  }

  /**
   * Which way out of a junction. Straight on is preferred, a U-turn back down
   * the edge you came in on is avoided unless it is the only exit, and a
   * viaduct never hands off to the street beneath it.
   */
  private pickNext(edge: number): number {
    const g = this.graph!;
    const e = g.edges[edge];
    const outs = g.out[e.to];
    if (!outs || !outs.length) return -1;
    if (outs.length === 1) return outs[0];
    const ex = this.edgeDir[edge * 4 + 2];
    const ez = this.edgeDir[edge * 4 + 3];
    let best = outs[0];
    let bestScore = -Infinity;
    for (let i = 0; i < outs.length; i++) {
      const o = outs[i];
      const dot = ex * this.edgeDir[o * 4] + ez * this.edgeDir[o * 4 + 1];
      let score = dot * 1.4 + Math.random() * 0.55;
      if (g.edges[o].layer === e.layer) score += 0.8;
      if (dot < -0.72) score -= 4;                       // a U-turn
      if (g.edges[o].cls === e.cls) score += 0.25;
      if (score > bestScore) { bestScore = score; best = o; }
    }
    return best;
  }

  /** Signal phase. Two alternating axes, offset per node so a grid ripples. */
  private green(node: number, axis: number): boolean {
    const ph = ((this.time + (node % 89) * 0.23) % SIGNAL_CYCLE) / SIGNAL_CYCLE;
    return axis === 1 ? ph > 0.5 && ph < 0.95 : ph < 0.45;
  }

  /**
   * Intelligent-driver-model acceleration toward a leader `gap` metres ahead
   * closing at `dv`. This is what produces queues, brake lights and the
   * stop-and-go you get behind a bus, out of four lines of arithmetic.
   */
  private static follow(v: number, v0: number, gap: number, dv: number): number {
    const star = GAP0 + Math.max(0, v * HEADWAY + (v * dv) / (2 * Math.sqrt(ACC * DEC)));
    const free = 1 - Math.pow(v / Math.max(v0, 0.6), 4);
    const near = gap > 0.05 ? Math.pow(star / gap, 2) : 900;
    return ACC * (free - near);
  }

  private stepCars(dt: number, ctx: Ctx): void {
    const g = this.graph!;
    const cam = ctx.camera.position;
    const radius = this.simRadius(ctx);
    const recycle = radius + RECYCLE_MARGIN;
    const p = { x: 0, y: 0, z: 0, hx: 1, hy: 0, hz: 0 };
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const tilt = new THREE.Quaternion();
    const euler = new THREE.Euler();
    const up = new THREE.Vector3(0, 1, 0);
    const pos = new THREE.Vector3();
    const one = new THREE.Vector3(1, 1, 1);
    const col = new THREE.Color();

    // ---- pass one: spawn, and index who is where ------------------------
    this.claimDist.clear();
    this.claimCar.clear();
    this.order.length = 0;
    for (let i = 0; i < this.cars.length; i++) {
      const car = this.cars[i];
      if (!car.active) { this.spawn(car, ctx, radius); if (!car.active) continue; }
      const e = g.edges[car.edge];
      // One key per car: lane identity in the high digits, distance along the
      // edge in the low ones, so a single sort puts every queue in order.
      this.sortKey[i] = (car.edge * 8 + car.lane) * 1e5 + Math.min(car.s, 99999);
      this.order.push(i);
      // Claim the junction ahead for whichever car is closest to it.
      const d = e.length - car.s;
      if (d < 22) {
        const held = this.claimDist.get(e.to);
        if (held === undefined || d < held) {
          this.claimDist.set(e.to, d);
          this.claimCar.set(e.to, i);
        }
      }
    }
    const slice = this.order;
    slice.sort((a, b) => this.sortKey[a] - this.sortKey[b]);

    // Leader lookup: the next car in the sorted run with the same edge+lane,
    // plus the hindmost car on each lane, for seeing across a junction.
    const leaderOf = this.leaderOf;
    const firstOn = this.firstOn;
    leaderOf.clear();
    firstOn.clear();
    for (let k = slice.length - 1; k >= 0; k--) {
      const a = slice[k];
      const key = Math.floor(this.sortKey[a] / 1e5);
      if (k < slice.length - 1) {
        const b = slice[k + 1];
        if (key === Math.floor(this.sortKey[b] / 1e5)) leaderOf.set(a, b);
      }
      firstOn.set(key, a);
    }

    // ---- pass two: drive -----------------------------------------------
    const cursor = new Array(this.defs.length).fill(0);
    for (let k = 0; k < slice.length; k++) {
      const i = slice[k];
      const car = this.cars[i];
      const e = g.edges[car.edge];
      const def = this.defs[car.type];
      const dNode = e.length - car.s;

      // Speed limit through the junction, from how sharp the turn is.
      let vJunction = car.cruise;
      if (car.next >= 0) {
        const dot = this.edgeDir[car.edge * 4 + 2] * this.edgeDir[car.next * 4]
                  + this.edgeDir[car.edge * 4 + 3] * this.edgeDir[car.next * 4 + 1];
        const turn = Math.acos(THREE.MathUtils.clamp(dot, -1, 1));
        vJunction = Math.max(3.2, car.cruise * (1 - 0.74 * Math.min(1, turn / 1.6)));
      }
      const v0 = Math.min(car.cruise, vJunction + Math.max(0, dNode - 5) * 0.6);

      let accel = Traffic.follow(car.speed, v0, 1e4, 0);

      // The car in front on this lane.
      const lead = leaderOf.get(i);
      if (lead !== undefined) {
        const lc = this.cars[lead];
        const gap = lc.s - car.s - (def.length + this.defs[lc.type].length) * 0.5;
        accel = Math.min(accel, Traffic.follow(car.speed, v0, Math.max(gap, 0.05), car.speed - lc.speed));
      } else if (car.next >= 0 && dNode < 70) {
        // Look across the junction so a queue that has spilled over is seen.
        const ne = g.edges[car.next];
        const ahead = firstOn.get(car.next * 8 + Math.min(car.lane, ne.lanes - 1));
        if (ahead !== undefined) {
          const ac = this.cars[ahead];
          const gap = dNode + ac.s - (def.length + this.defs[ac.type].length) * 0.5;
          accel = Math.min(accel, Traffic.follow(car.speed, v0, Math.max(gap, 0.05), car.speed - ac.speed));
        }
      }

      // Red light, or give way to whoever claimed the junction first.
      const dStop = Math.max(dNode - 2.6, 0.05);
      let hold = false;
      if (dNode < 55 && this.signal[e.to] && !this.green(e.to, this.edgeAxis[car.edge])) hold = true;
      else if (dNode < 20 && car.stuck < 7) {
        const owner = this.claimCar.get(e.to);
        const ownerD = this.claimDist.get(e.to);
        if (owner !== undefined && owner !== i && ownerD !== undefined && ownerD < dNode - 1.5) hold = true;
      }
      if (hold) {
        accel = Math.min(accel, Traffic.follow(car.speed, v0, dStop, car.speed));
      }

      accel = THREE.MathUtils.clamp(accel, -7.5, ACC);
      car.speed = Math.max(0, car.speed + accel * dt);
      car.stuck = car.speed < 0.45 ? car.stuck + dt : 0;
      if (car.stuck > 12) car.stuck = 0;
      car.s += car.speed * dt;

      // Brake lamps: on under real deceleration, and held briefly at a stop.
      const wantBrake = accel < -0.55 ? 1 : (car.speed < 0.5 ? 1 : 0);
      car.brake += (wantBrake - car.brake) * Math.min(1, dt * 11);

      if (car.s >= e.length) {
        if (car.next < 0) { car.active = false; continue; }
        car.s -= e.length;
        car.edge = car.next;
        const ne = g.edges[car.edge];
        car.lane = Math.min(car.lane, ne.lanes - 1);
        car.cruise = ne.speed * (0.78 + Math.random() * 0.34);
        car.next = this.pickNext(car.edge);
        continue;
      }

      sampleEdge(e, car.s, p);

      const dx = p.x - cam.x;
      const dz = p.z - cam.z;
      if (dx * dx + dz * dz > recycle * recycle) { car.active = false; continue; }

      const t = car.type;
      const buckets = this.carMeshes[t];
      const slot = cursor[t];
      if (slot >= buckets[0].mesh.instanceMatrix.count) continue;
      cursor[t] = slot + 1;

      // Steer toward the path heading rather than snapping to it, with a rate
      // ceiling from a ~5.5 m minimum turning radius.
      const target = yawOf(p.hx, p.hz);
      let dy = target - car.yaw;
      if (dy > Math.PI) dy -= Math.PI * 2;
      else if (dy < -Math.PI) dy += Math.PI * 2;
      const cap = Math.max(0.45, car.speed / 5.5) * dt;
      const turn = THREE.MathUtils.clamp(dy * Math.min(1, dt * 7), -cap, cap);
      car.yaw += turn;
      const rate = turn / Math.max(dt, 1e-4);

      // Ackermann steer angle, body lean into the corner, pitch under braking,
      // and the wheels rolling at the speed the car is actually doing.
      const wantSteer = Math.atan((def.wheelbase * rate) / Math.max(car.speed, 1.8));
      car.steer += (THREE.MathUtils.clamp(wantSteer, -0.55, 0.55) - car.steer) * Math.min(1, dt * 9);
      car.lean += (THREE.MathUtils.clamp(rate * car.speed * 0.035, -0.075, 0.075) - car.lean)
                * Math.min(1, dt * 5);
      car.pitch += (THREE.MathUtils.clamp(accel * 0.0075, -0.030, 0.020) - car.pitch)
                 * Math.min(1, dt * 6);
      car.roll = (car.roll + (car.speed * dt) / def.wheelR) % (Math.PI * 2);

      // Right-hand traffic: offset to the right of the centreline, which in
      // this frame is (-hz, hx).
      const off = (car.lane + 0.5) * LANE_W;
      pos.set(p.x - p.hz * off, p.y, p.z + p.hx * off);
      q.setFromAxisAngle(up, car.yaw);
      // Road gradient plus the body's own pitch, applied in the car's frame.
      euler.set(car.lean, 0, car.pitch + Math.asin(THREE.MathUtils.clamp(p.hy, -1, 1)), 'XYZ');
      tilt.setFromEuler(euler);
      q.multiply(tilt);
      m.compose(pos, q, one);

      for (const b of buckets) {
        b.mesh.setMatrixAt(slot, m);
        if (b.part === 'shell' && b.mesh.instanceColor) {
          col.setHex(car.colour).convertSRGBToLinear();
          b.mesh.instanceColor.setXYZ(slot, col.r, col.g, col.b);
        }
      }
      this.carRoll[t].setX(slot, car.roll);
      this.carSteer[t].setX(slot, car.steer);
      this.carBrake[t].setX(slot, car.brake);
    }

    for (let t = 0; t < this.carMeshes.length; t++) {
      for (const b of this.carMeshes[t]) {
        b.mesh.count = cursor[t];
        b.mesh.instanceMatrix.needsUpdate = true;
        if (b.mesh.instanceColor) b.mesh.instanceColor.needsUpdate = true;
      }
      this.carRoll[t].needsUpdate = true;
      this.carSteer[t].needsUpdate = true;
      this.carBrake[t].needsUpdate = true;
    }
    ctx.stats.vehiclesDrawn = cursor.reduce((a, b) => a + b, 0);
  }

  /* ------------------------------------------------------------- walkers */

  /**
   * People on the footway network. One instanced mesh for the lot: the walk
   * cycle is a per-instance phase the vertex shader swings the limbs by, so
   * nothing about the animation touches the CPU.
   */
  private buildWalkers(ctx: Ctx, roads: RoadRecord[]): void {
    this.walkGraph = buildLaneGraph(roads, 'walk');
    if (!this.walkGraph.edges.length) return;

    // Where the footway is, relative to each way's centreline. A mapped
    // footway *is* the pavement, so its own centreline is right; a residential
    // street or a service road is the carriageway, and people walking "along"
    // one belong beyond the kerb. Without this a third of the crowd strolled
    // down the middle of the road, through the traffic.
    const wg = this.walkGraph;
    this.walkKerb = new Float32Array(wg.edges.length);
    for (let i = 0; i < wg.edges.length; i++) {
      const e = wg.edges[i];
      const onFoot = e.cls === 'footway' || e.cls === 'pedestrian' || e.cls === 'cycleway';
      this.walkKerb[i] = onFoot ? 0 : Math.max(2.0, e.width * 0.5 + 0.85);
    }

    const n = WALKERS[ctx.tier] ?? 400;
    const geo = pedestrianGeometry();
    const phase = new THREE.InstancedBufferAttribute(new Float32Array(n), 1);
    const swing = new THREE.InstancedBufferAttribute(new Float32Array(n).fill(1), 1);
    geo.setAttribute('aPhase', phase);
    geo.setAttribute('aSwing', swing);
    this.walkPhase = phase;
    this.walkSwing = swing;

    const mat = new THREE.MeshStandardMaterial({
      name: 'pedestrian', roughness: 0.82, metalness: 0, vertexColors: true,
    });
    mat.onBeforeCompile = (sh) => {
      sh.vertexShader = sh.vertexShader
        .replace('#include <common>', `#include <common>\n${WALK_VERT_PARS}`)
        .replace('#include <begin_vertex>', `#include <begin_vertex>\n${WALK_VERT_POS}`);
    };
    mat.customProgramCacheKey = () => 'pedestrian';
    this.materials.push(mat);

    const mesh = new THREE.InstancedMesh(geo, mat, n);
    mesh.name = 'pedestrians';
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.frustumCulled = false;
    mesh.count = 0;
    mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(n * 3), 3);
    this.root.add(mesh);
    this.walkMesh = mesh;

    for (let i = 0; i < n; i++) {
      this.walkers.push({
        edge: -1, s: 0, side: 0, lane: 0.6, speed: 1.4, cruise: 1.4,
        colour: 0, phase: 0, yaw: 0, tall: 1, build: 1, idle: 0, active: false,
      });
    }
    this.walkOrder = new Array(this.walkers.length).fill(0).map((_, i) => i);
    this.walkKey = new Float64Array(this.walkers.length);
  }

  private spawnWalker(w: Walker, ctx: Ctx): void {
    const g = this.walkGraph!;
    const cam = ctx.camera.position;
    for (let a = 0; a < 14; a++) {
      const ei = (this.walkSpawn = (this.walkSpawn + 5171) % g.edges.length);
      const e = g.edges[ei];
      const mid = Math.floor(e.cum.length / 2) * 3;
      if (Math.hypot(e.pts[mid] - cam.x, e.pts[mid + 2] - cam.z) > WALK_RADIUS) continue;
      w.edge = ei;
      w.s = Math.random() * e.length;
      // Everyone keeps to the right of the path, so the two directions of
      // travel separate into streams instead of walking through each other.
      // The graph carries both directions of every way, so "right" puts the
      // two streams on opposite pavements of a street without any extra state.
      w.lane = 0.35 + Math.random() * 0.75;
      w.side = this.walkKerb[ei] + w.lane;
      w.cruise = 1.05 + Math.random() * 0.62;
      // A tenth of the crowd is stood still: waiting at a kerb, or talking.
      w.idle = Math.random() < 0.11 ? 2 + Math.random() * 12 : 0;
      w.speed = w.idle > 0 ? 0 : w.cruise;
      w.colour = CLOTHES[(Math.random() * CLOTHES.length) | 0];
      w.phase = Math.random() * 6.283;
      w.tall = 0.90 + Math.random() * 0.17;
      w.build = 0.90 + Math.random() * 0.20;
      w.yaw = yawOf(g.edges[ei].pts[3] - g.edges[ei].pts[0], g.edges[ei].pts[5] - g.edges[ei].pts[2]);
      w.active = true;
      return;
    }
    w.active = false;
  }

  private stepWalkers(dt: number, ctx: Ctx): void {
    const mesh = this.walkMesh;
    const g = this.walkGraph;
    if (!mesh || !g) return;

    const cam = ctx.camera.position;
    const p = { x: 0, y: 0, z: 0, hx: 1, hy: 0, hz: 0 };
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const up = new THREE.Vector3(0, 1, 0);
    const pos = new THREE.Vector3();
    const scale = new THREE.Vector3(1, 1, 1);
    const col = new THREE.Color();
    const phaseArr = this.walkPhase!.array as Float32Array;
    const swingArr = this.walkSwing!.array as Float32Array;
    let slot = 0;
    const cap = mesh.instanceMatrix.count;

    // ---- who is behind whom ---------------------------------------------
    // Same trick as the traffic: one key per walker with the edge in the high
    // digits and the distance along it in the low ones, so a single sort puts
    // every stream in order and the person in front is the next entry. Without
    // it a crowd on a narrow pavement walks straight through itself.
    const order = this.walkOrder;
    order.length = 0;
    for (let i = 0; i < this.walkers.length; i++) {
      const w = this.walkers[i];
      if (!w.active) { this.spawnWalker(w, ctx); if (!w.active) continue; }
      this.walkKey[i] = w.edge * 1e5 + Math.min(w.s, 99999);
      order.push(i);
    }
    order.sort((a, b) => this.walkKey[a] - this.walkKey[b]);

    for (let k = 0; k < order.length; k++) {
      const w = this.walkers[order[k]];
      const e = g.edges[w.edge];

      // The person ahead in this stream. Anyone closer than a stride and in
      // the same part of the pavement gets followed rather than walked into;
      // slightly overlapping streams also push apart sideways.
      let block = 1;
      if (k + 1 < order.length) {
        const lead = this.walkers[order[k + 1]];
        if (lead.edge === w.edge) {
          const gap = lead.s - w.s;
          const across = Math.abs(lead.side - w.side);
          if (gap < 1.55 && across < 0.62) {
            block = THREE.MathUtils.clamp((gap - 0.42) / 1.13, 0, 1);
            const push = (w.side <= lead.side ? -1 : 1) * (0.62 - across) * dt * 1.6;
            w.lane = THREE.MathUtils.clamp(w.lane + push, 0.2, 1.5);
          }
        }
      }
      const want = w.idle > 0 ? 0 : w.cruise * (0.25 + 0.75 * block);

      if (w.idle > 0) {
        w.idle -= dt;
        w.speed += (0 - w.speed) * Math.min(1, dt * 3);
        if (w.idle <= 0) w.idle = 0;
      } else {
        // Slowing for someone in front is quicker than picking the pace back up.
        w.speed += (want - w.speed) * Math.min(1, dt * (want < w.speed ? 6 : 2.2));
        w.s += w.speed * dt;
      }
      // A 0.85 m half-stride; two steps per cycle, so the feet do not skate.
      w.phase += (Math.max(w.speed, 0.04) / 0.85) * dt * Math.PI;

      if (w.s >= e.length) {
        const outs = g.out[e.to];
        if (!outs || !outs.length) { w.active = false; continue; }
        w.s -= e.length;
        w.edge = outs[(Math.random() * outs.length) | 0];
        // Pause at a junction now and then: it reads as waiting to cross.
        if (Math.random() < 0.13) w.idle = 1.5 + Math.random() * 7;
        continue;
      }
      // Step across to the footway rather than snapping to it: leaving a
      // pavement for a shared surface can move the kerb several metres.
      const sideWant = this.walkKerb[w.edge] + w.lane;
      w.side += THREE.MathUtils.clamp(sideWant - w.side, -2.2 * dt, 2.2 * dt);
      sampleEdge(e, w.s, p);
      if (Math.hypot(p.x - cam.x, p.z - cam.z) > WALK_RECYCLE) { w.active = false; continue; }
      if (slot >= cap) continue;

      const target = yawOf(p.hx, p.hz);
      let dy = target - w.yaw;
      if (dy > Math.PI) dy -= Math.PI * 2;
      else if (dy < -Math.PI) dy += Math.PI * 2;
      w.yaw += THREE.MathUtils.clamp(dy * Math.min(1, dt * 4), -3.0 * dt, 3.0 * dt);

      pos.set(p.x - p.hz * w.side, p.y, p.z + p.hx * w.side);
      q.setFromAxisAngle(up, w.yaw);
      scale.set(w.build, w.tall, w.build);
      m.compose(pos, q, scale);
      mesh.setMatrixAt(slot, m);
      col.setHex(w.colour).convertSRGBToLinear();
      mesh.instanceColor!.setXYZ(slot, col.r, col.g, col.b);
      phaseArr[slot] = w.phase;
      // Arms and legs swing in proportion to the pace; a standing figure only
      // sways. Clamped low rather than to zero so nobody is a statue.
      swingArr[slot] = 0.10 + 0.78 * Math.min(1, w.speed / 1.45);
      slot++;
    }

    mesh.count = slot;
    mesh.instanceMatrix.needsUpdate = true;
    mesh.instanceColor!.needsUpdate = true;
    this.walkPhase!.needsUpdate = true;
    this.walkSwing!.needsUpdate = true;
    ctx.stats.pedestriansDrawn = slot;
  }

  /* ---------------------------------------------------------------- water */

  /**
   * Sample points inside the big water bodies so boats have somewhere legal
   * to be, tagged river or harbour so a rowing eight never appears in the
   * shipping channel.
   */
  private buildWaterCells(areas: AreaRecord[]): void {
    const cells: number[] = [];
    for (const a of areas) {
      if (a.kind !== 'water' && a.kind !== 'river') continue;
      let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
      for (let i = 0; i < a.outline.length; i += 2) {
        minX = Math.min(minX, a.outline[i]); maxX = Math.max(maxX, a.outline[i]);
        minZ = Math.min(minZ, a.outline[i + 1]); maxZ = Math.max(maxZ, a.outline[i + 1]);
      }
      const w = maxX - minX;
      const h = maxZ - minZ;
      if (w < 120 || h < 120) continue;
      const river = a.kind === 'river' ? 1 : 0;
      const step = 90;
      for (let x = minX + step; x < maxX; x += step) {
        for (let z = minZ + step; z < maxZ; z += step) {
          if (!pointInRing(a.outline, x, z)) continue;
          // Keep clear of the banks so nothing runs aground.
          if (distToRing(a.outline, x, z) < 45) continue;
          cells.push(x, z, river);
        }
      }
    }
    this.waterCells = Float32Array.from(cells);

    // Index them: checking a boat against every cell in the harbour each
    // frame was costing more than drawing the boats.
    this.cellGrid.clear();
    for (let i = 0; i < this.waterCells.length; i += 3) {
      const k = cellKey(this.waterCells[i], this.waterCells[i + 1]);
      const b = this.cellGrid.get(k);
      if (b) b.push(i);
      else this.cellGrid.set(k, [i]);
    }
  }

  private buildVessels(ctx: Ctx): void {
    if (!this.waterCells.length) return;
    this.vdefs = vesselTypes();
    const want = BOATS[ctx.tier] ?? 38;
    const total = this.vdefs.reduce((n, d) => n + d.weight, 0);

    for (let t = 0; t < this.vdefs.length; t++) {
      const d = this.vdefs[t];
      const cap = Math.max(1, Math.round((want * d.weight) / total));
      const buckets: Bucket[] = [];
      const stroke = new THREE.InstancedBufferAttribute(new Float32Array(cap), 1);
      this.boatStroke.push(stroke);
      for (const [part, geo] of Object.entries(d.parts) as [VesselPart, THREE.BufferGeometry][]) {
        if (part === 'oar') geo.setAttribute('aStroke', stroke);
        const mesh = new THREE.InstancedMesh(geo, this.vesselMaterial(part, d.hullColor), cap);
        mesh.name = `vessel:${d.name}:${part}`;
        // As with the cars, only the main mass casts; the glass and rigging
        // would cost three extra cascade draws each for nothing.
        const casts = part === 'hull' || part === 'house';
        mesh.castShadow = casts;
        mesh.receiveShadow = true;
        mesh.userData.noShadow = !casts;
        mesh.frustumCulled = false;
        mesh.count = 0;
        this.root.add(mesh);
        buckets.push({ mesh, part });
      }
      this.boatMeshes.push(buckets);

      for (let i = 0; i < cap; i++) {
        const b: Boat = {
          type: t, x: 0, z: 0, yaw: 0, want: 0, speed: d.speed,
          colour: d.hullColor, stroke: Math.random() * 6.283, recheck: Math.random(),
        };
        this.boats.push(b);
      }
    }

    // One quad per vessel carries the wake, all of them in one draw call.
    const geo = wakeGeometry();
    const fade = new THREE.InstancedBufferAttribute(new Float32Array(this.boats.length), 1);
    geo.setAttribute('aFade', fade);
    const tex = wakeTexture();
    const mat = new THREE.MeshBasicMaterial({
      name: 'wake', map: tex, transparent: true, depthWrite: false,
      side: THREE.DoubleSide, opacity: 0.88, toneMapped: true,
    });
    mat.onBeforeCompile = (sh) => {
      sh.vertexShader = sh.vertexShader
        .replace('#include <common>', '#include <common>\nattribute float aFade;\nvarying float vFade;')
        .replace('#include <begin_vertex>', '#include <begin_vertex>\nvFade = aFade;');
      sh.fragmentShader = sh.fragmentShader
        .replace('#include <common>', '#include <common>\nvarying float vFade;')
        .replace('#include <map_fragment>', '#include <map_fragment>\ndiffuseColor.a *= vFade;');
    };
    mat.customProgramCacheKey = () => 'wake';
    this.materials.push(mat);
    const wake = new THREE.InstancedMesh(geo, mat, this.boats.length);
    wake.name = 'wakes';
    wake.frustumCulled = false;
    wake.castShadow = false;
    wake.receiveShadow = false;
    wake.userData.noShadow = true;
    wake.renderOrder = 3;
    wake.count = 0;
    this.root.add(wake);
    this.wakeMesh = wake;
    this.wakeFade = fade;

    for (const b of this.boats) this.placeBoat(b, ctx);
  }

  private vesselMaterial(part: VesselPart, hull: number): THREE.Material {
    const mk = (o: THREE.MeshStandardMaterialParameters): THREE.MeshStandardMaterial => {
      const m = new THREE.MeshStandardMaterial(o);
      this.materials.push(m);
      return m;
    };
    switch (part) {
      case 'house': return mk({ name: 'boat:house', color: 0xeeece4, roughness: 0.6, metalness: 0.05 });
      case 'glass': return mk({ name: 'boat:glass', color: 0x14202a, roughness: 0.12, metalness: 0.5 });
      case 'sail':  return mk({ name: 'boat:sail', color: 0xf6f5ef, roughness: 0.78, metalness: 0,
        side: THREE.DoubleSide });
      case 'oar': {
        // The rowing rig: oars sweep about their gates, blades feather out of
        // the water, and the crew slides. All of it in the vertex stage.
        const m = mk({ name: 'boat:oar', color: 0xdedbd2, roughness: 0.5, metalness: 0.05 });
        m.onBeforeCompile = (sh) => {
          sh.vertexShader = sh.vertexShader
            .replace('#include <common>', `#include <common>\n${ROW_VERT_PARS}`)
            .replace('#include <begin_vertex>', `#include <begin_vertex>\n${ROW_VERT_POS}`);
        };
        m.customProgramCacheKey = () => 'boat-oar';
        return m;
      }
      case 'dark':  return mk({ name: 'boat:dark', color: 0x2a2c30, roughness: 0.55, metalness: 0.4 });
      default:      return mk({ name: 'boat:hull', color: hull, roughness: 0.38, metalness: 0.15,
        envMapIntensity: 1.2 });
    }
  }

  /** How far out boats live. Scaled with altitude: from 2 km up you see the lot. */
  private boatRadius(ctx: Ctx): number {
    return BOAT_RADIUS + THREE.MathUtils.clamp(ctx.camera.position.y, 0, 2600) * 1.45;
  }

  /**
   * Drop a boat on a legal water cell of the right kind, near enough the
   * camera to be worth drawing, and pointed somewhere it can actually go.
   *
   * How close it may appear scales with how big it is. A hole of a fixed
   * fraction of the sim radius around the camera — which is what used to keep
   * anything from popping into view — meant nothing ever floated within four
   * hundred metres, and the Charles, which has more rowing traffic than any
   * river in the world, read as an empty sheet of water in every shot. A
   * seventeen-metre shell appearing two hundred metres off is barely
   * noticeable; a container ship doing it is not, so a ship keeps its hole.
   * Either way a cell behind the camera is always fair game, because nobody
   * can see it arrive.
   */
  private placeBoat(b: Boat, ctx: Ctx): void {
    const n = this.waterCells.length / 3;
    if (!n) return;
    const def = this.vdefs[b.type];
    const want = def.water;
    const cam = ctx.camera.position;
    const radius = this.boatRadius(ctx);
    const inner = THREE.MathUtils.clamp(def.length * 13, 150, radius * 0.5);
    ctx.camera.getWorldDirection(this.camFwd);
    const fx = this.camFwd.x;
    const fz = this.camFwd.z;
    let fallback = -1;
    for (let i = 0; i < 90; i++) {
      const k = (Math.random() * n) | 0;
      const river = this.waterCells[k * 3 + 2] > 0.5;
      if (want === 'river' && !river) continue;
      if (want === 'harbour' && river) continue;
      if (fallback < 0) fallback = k;
      const dx = this.waterCells[k * 3] - cam.x;
      const dz = this.waterCells[k * 3 + 1] - cam.z;
      const d = Math.hypot(dx, dz);
      if (d > radius) continue;
      if (d < inner && (dx * fx + dz * fz) > -0.2 * d) continue;
      this.setBoat(b, k);
      return;
    }
    if (fallback >= 0) this.setBoat(b, fallback);
  }

  private setBoat(b: Boat, cell: number): void {
    b.x = this.waterCells[cell * 3];
    b.z = this.waterCells[cell * 3 + 1];
    b.speed = this.vdefs[b.type].speed * (0.7 + Math.random() * 0.5);
    b.yaw = this.clearHeading(b, Math.random() * Math.PI * 2);
    b.want = b.yaw;
    b.recheck = Math.random() * 0.8;
  }

  /**
   * Pick the heading nearest `from` with open water ahead. Boats used to be
   * given a random course and teleported somewhere else when they ran out of
   * river; probing the water field instead makes them follow the channel,
   * which is what the Charles and the shipping lane actually look like.
   */
  private clearHeading(b: Boat, from: number): number {
    const len = this.vdefs[b.type].length;
    const reach = Math.max(120, len * 4);
    for (const spread of [0, 0.35, 0.7, 1.05, 1.4, 1.75, 2.1, 2.6, 3.14]) {
      for (const sign of spread === 0 ? [1] : [1, -1]) {
        const a = from + spread * sign;
        const dx = Math.cos(a);
        const dz = -Math.sin(a);
        if (this.afloat(b.x + dx * reach, b.z + dz * reach)
          && this.afloat(b.x + dx * reach * 0.55, b.z + dz * reach * 0.55)) return a;
      }
    }
    return from + Math.PI;
  }

  private stepBoats(dt: number, ctx: Ctx): void {
    if (!this.boats.length) return;
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const e = new THREE.Euler();
    const pos = new THREE.Vector3();
    const one = new THREE.Vector3(1, 1, 1);
    const wscale = new THREE.Vector3(1, 1, 1);
    const up = new THREE.Vector3(0, 1, 0);
    const cursor = new Array(this.vdefs.length).fill(0);
    const cam = ctx.camera.position;
    const radius = this.boatRadius(ctx);
    const recycle = radius * 1.35;
    const fade = this.wakeFade;
    let wslot = 0;

    for (const b of this.boats) {
      const def = this.vdefs[b.type];

      // Course keeping: re-probe every second or so, staggered across the fleet.
      b.recheck -= dt;
      if (b.recheck <= 0) {
        b.recheck = 0.7 + Math.random() * 0.8;
        b.want = this.clearHeading(b, b.yaw + (Math.random() - 0.5) * 0.12);
      }
      let dy = b.want - b.yaw;
      if (dy > Math.PI) dy -= Math.PI * 2;
      else if (dy < -Math.PI) dy += Math.PI * 2;
      // A hull turns slowly, and a big one turns much more slowly than a skiff.
      const rate = Math.min(0.55, 6.5 / def.length);
      b.yaw += THREE.MathUtils.clamp(dy, -rate * dt, rate * dt);

      const dirX = Math.cos(b.yaw);
      const dirZ = -Math.sin(b.yaw);
      b.x += dirX * b.speed * dt;
      b.z += dirZ * b.speed * dt;
      b.stroke += dt * (2.0 + b.speed * 0.28);

      // Off navigable water, or too far to be worth drawing: put it back.
      const dcx = b.x - cam.x;
      const dcz = b.z - cam.z;
      if (!this.afloat(b.x, b.z) || dcx * dcx + dcz * dcz > recycle * recycle) {
        this.placeBoat(b, ctx);
        continue;
      }

      const t = b.type;
      const buckets = this.boatMeshes[t];
      const slot = cursor[t];
      if (slot >= buckets[0].mesh.instanceMatrix.count) continue;
      cursor[t] = slot + 1;

      // Ride the swell: a slow pitch and roll scaled to the hull's length, so
      // a rowing shell bobs and a container ship barely moves.
      const scale = Math.min(20 / def.length, 1);
      const ph = this.time * 0.9 + b.x * 0.02;
      pos.set(b.x, Math.sin(ph) * 0.09 * scale, b.z);
      e.set(Math.cos(ph * 1.1) * 0.035 * scale, b.yaw, Math.sin(ph * 0.8) * 0.02 * scale, 'YXZ');
      q.setFromEuler(e);
      m.compose(pos, q, one);
      for (const bk of buckets) bk.mesh.setMatrixAt(slot, m);
      this.boatStroke[t].setX(slot, b.stroke);

      // The wake, laid from the bow aft along the track.
      if (this.wakeMesh && fade && wslot < this.wakeMesh.instanceMatrix.count) {
        const half = def.length * 0.5;
        pos.set(b.x + dirX * half, 0.34, b.z + dirZ * half);
        q.setFromAxisAngle(up, b.yaw);
        wscale.set(def.wake[0] * def.length, 1, def.wake[1] * def.length * 2);
        m.compose(pos, q, wscale);
        this.wakeMesh.setMatrixAt(wslot, m);
        fade.setX(wslot, THREE.MathUtils.clamp(b.speed / Math.max(def.speed, 0.5), 0, 1.2) * 0.9);
        wslot++;
      }
    }

    for (let t = 0; t < this.boatMeshes.length; t++) {
      for (const bk of this.boatMeshes[t]) {
        bk.mesh.count = cursor[t];
        bk.mesh.instanceMatrix.needsUpdate = true;
      }
      this.boatStroke[t].needsUpdate = true;
    }
    if (this.wakeMesh && fade) {
      this.wakeMesh.count = wslot;
      this.wakeMesh.instanceMatrix.needsUpdate = true;
      fade.needsUpdate = true;
    }
    ctx.stats.boatsDrawn = cursor.reduce((a, b) => a + b, 0);
  }

  /**
   * True when a sampled water cell lies close enough to this point to call it
   * navigable. The cells are on a 90 m lattice, so 66 m is the smallest radius
   * whose discs still cover the lattice diagonally — any larger and boats sail
   * up to a hundred metres inland before anything notices.
   */
  private afloat(x: number, z: number): boolean {
    const gx = Math.floor(x / CELL_BUCKET);
    const gz = Math.floor(z / CELL_BUCKET);
    for (let i = -1; i <= 1; i++) {
      for (let j = -1; j <= 1; j++) {
        const b = this.cellGrid.get((gx + i) * 65536 + (gz + j));
        if (!b) continue;
        for (const o of b) {
          const dx = this.waterCells[o] - x;
          const dz = this.waterCells[o + 1] - z;
          if (dx * dx + dz * dz < 66 * 66) return true;
        }
      }
    }
    return false;
  }

  /* ---------------------------------------------------------------- flags */

  /**
   * Flags fly from the mapped flagpoles, and from a handful of civic roofs.
   * The wave is a vertex shader: amplitude rises along the fly so the hoist
   * stays pinned to the pole.
   */
  private buildFlags(ctx: Ctx, props: PropSet[]): void {
    const sites: number[] = [];
    for (const set of props) {
      if (set.kind !== 'flagpole') continue;
      for (let i = 0; i < set.positions.length; i += 3) {
        sites.push(set.positions[i], set.positions[i + 1], set.positions[i + 2]);
      }
    }
    if (!sites.length) return;

    const tex = flagTexture();
    const hoist = 1.55;
    const geo = flagGeometry(hoist);
    const mat = new THREE.MeshStandardMaterial({
      name: 'flag', map: tex, side: THREE.DoubleSide,
      roughness: 0.82, metalness: 0,
    });
    mat.onBeforeCompile = (sh) => {
      sh.uniforms.uTime = this.flagUniforms.uTime;
      sh.uniforms.uWind = this.flagUniforms.uWind;
      sh.vertexShader = sh.vertexShader
        .replace('#include <common>', `#include <common>\nuniform float uTime;\nuniform vec2 uWind;`)
        .replace('#include <begin_vertex>', /* glsl */ `
          #include <begin_vertex>
          // Distance along the fly, 0 at the hoist. Amplitude grows with it so
          // the edge nearest the pole stays still.
          float fly = clamp(transformed.x / ${(hoist * 1.9).toFixed(3)}, 0.0, 1.0);
          float amp = fly * fly * 0.42;
          vec3 io = (modelMatrix * instanceMatrix * vec4(0.0,0.0,0.0,1.0)).xyz;
          float ph = uTime * 4.2 + io.x * 0.3 + io.z * 0.21;
          transformed.z += sin(ph - fly * 7.0) * amp
                         + sin(ph * 1.7 - fly * 11.0) * amp * 0.35;
          transformed.y += cos(ph * 1.3 - fly * 6.0) * amp * 0.22;
          // Let the fly droop slightly when it is not fully extended.
          transformed.x -= fly * amp * 0.30;
        `);
    };
    mat.customProgramCacheKey = () => 'flag';
    this.materials.push(mat);

    const n = sites.length / 3;
    const mesh = new THREE.InstancedMesh(geo, mat, n);
    mesh.name = 'flags';
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.frustumCulled = false;
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const up = new THREE.Vector3(0, 1, 0);
    const pos = new THREE.Vector3();
    const one = new THREE.Vector3(1, 1, 1);
    // The pole model in props/kinds.ts is 11 m with the truck at the top.
    for (let i = 0; i < n; i++) {
      pos.set(sites[i * 3], sites[i * 3 + 1] + 10.1, sites[i * 3 + 2]);
      // Flags stream downwind; the prevailing wind here is from the WNW.
      q.setFromAxisAngle(up, yawOf(this.flagUniforms.uWind.value.x, this.flagUniforms.uWind.value.y));
      m.compose(pos, q, one);
      mesh.setMatrixAt(i, m);
    }
    mesh.instanceMatrix.needsUpdate = true;
    this.root.add(mesh);
    this.flagMesh = mesh;
    void ctx;
  }

  /* --------------------------------------------------------------- frame */

  private resizePool(ctx: Ctx): void {
    void ctx; // pools are allocated at init; a tier change keeps the capacity
  }

  update(dt: number, ctx: Ctx): void {
    if (!this.graph) return;
    this.time += dt;
    this.flagUniforms.uTime.value = this.time;

    // Headlights, tail lights and brake lights on the same civil-twilight
    // curve as the rest of the city, with the same exposure compensation.
    // Brake lamps stay bright in daylight — they are the one signal you read
    // on a sunlit street — but still divide by the presented exposure.
    const e = ctx.sun?.elevation ?? 0.5;
    const t = THREE.MathUtils.clamp((0.16 - e) / 0.22, 0, 1);
    const comp = 2.5 / Math.max(ctx.exposure || 2.5, 0.1);
    this.lampUniforms.uNight.value = t * t * (3 - 2 * t) * comp * 4.2;
    this.lampUniforms.uBrake.value = (1.9 + 3.4 * t) * comp;
    for (const m of this.nightLit) {
      m.emissiveIntensity = t * t * (3 - 2 * t) * comp * ((m.userData.nightPeak as number) ?? 1);
    }

    this.stepCars(dt, ctx);
    this.stepWalkers(dt, ctx);
    this.stepBoats(dt, ctx);
    this.air.step(dt, ctx);
  }

  dispose(ctx: Ctx): void {
    ctx.scene.remove(this.root);
    this.root.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.isMesh) m.geometry?.dispose();
    });
    for (const m of this.materials) m.dispose();
    this.materials.length = 0;
    this.air.dispose();
  }
}

/* ------------------------------------------------------------- geometry */

function pointInRing(r: number[], x: number, z: number): boolean {
  let inside = false;
  for (let i = 0, j = r.length - 2; i < r.length; j = i, i += 2) {
    const xi = r[i], zi = r[i + 1], xj = r[j], zj = r[j + 1];
    if ((zi > z) !== (zj > z) && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
  }
  return inside;
}

function distToRing(r: number[], x: number, z: number): number {
  let best = Infinity;
  for (let i = 0, j = r.length - 2; i < r.length; j = i, i += 2) {
    const ax = r[j], az = r[j + 1], bx = r[i], bz = r[i + 1];
    const dx = bx - ax, dz = bz - az;
    const len2 = dx * dx + dz * dz;
    const t = len2 > 0 ? Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / len2)) : 0;
    const px = ax + dx * t, pz = az + dz * t;
    const d = Math.hypot(x - px, z - pz);
    if (d < best) best = d;
  }
  return best;
}

const CELL_BUCKET = 180;
const cellKey = (x: number, z: number): number =>
  Math.floor(x / CELL_BUCKET) * 65536 + Math.floor(z / CELL_BUCKET);
