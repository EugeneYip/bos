import * as THREE from 'three';
import type { Ctx, WorldModule } from '../core/Context';
import type { AreaRecord, PropSet, RoadRecord } from '../core/types';
import { loadAreas, loadProps, loadRoads } from '../core/data';
import { buildLaneGraph, sampleEdge, LANE_W, type LaneGraph } from './traffic/graph';
import { vehicleTypes, pedestrianGeometry, CAR_COLORS, CLOTHES, type Part, type VehicleDef } from './traffic/vehicles';
import { vesselTypes, flagGeometry, flagTexture, type VesselDef, type VesselPart } from './traffic/vessels';

/**
 * Everything in the city that moves: road traffic, boats, and flags.
 *
 * Simulating 1,262 km of street would be pointless — you can only see a few
 * hundred metres of it. Instead a fixed pool of vehicles is kept alive near
 * the camera: each one drives its edge, picks a new one at the junction, and
 * when it falls too far behind it is recycled onto a road just outside the
 * view. The pool size is constant, so cost does not depend on how big the
 * road network is.
 */

/** Vehicles are simulated within this radius; beyond it they are recycled. */
const SIM_RADIUS = 420;
const RECYCLE_RADIUS = 520;

const POOL: Record<string, number> = { low: 120, medium: 300, high: 650, ultra: 1000 };
const WALKERS: Record<string, number> = { low: 60, medium: 180, high: 400, ultra: 650 };
/** People are only legible close in, so they live in a tighter bubble. */
const WALK_RADIUS = 170;
const WALK_RECYCLE = 220;
const BOATS: Record<string, number> = { low: 8, medium: 18, high: 34, ultra: 52 };

interface Car {
  type: number;
  edge: number;
  /** Distance along the edge, metres. */
  s: number;
  lane: number;
  speed: number;
  /** Target speed, so braking and acceleration are not instant. */
  cruise: number;
  colour: number;
  active: boolean;
}

interface Walker {
  edge: number;
  s: number;
  /** Which side of the path, so two people do not occupy the same line. */
  side: number;
  speed: number;
  colour: number;
  /** Accumulated stride phase, so the walk cycle matches the ground speed. */
  phase: number;
  active: boolean;
}

interface Boat {
  type: number;
  x: number; z: number;
  heading: number;
  speed: number;
  /** Turn rate, radians/s; boats wander rather than follow a graph. */
  turn: number;
  colour: number;
}

interface Bucket {
  mesh: THREE.InstancedMesh;
  part: Part | VesselPart;
}

export class Traffic implements WorldModule {
  readonly name = 'Traffic';

  private root = new THREE.Group();
  private graph: LaneGraph | null = null;

  private defs: VehicleDef[] = [];
  private cars: Car[] = [];
  /** Per vehicle type, per part: the instanced mesh to write into. */
  private carMeshes: Bucket[][] = [];
  private typeOrder: number[] = [];

  private vdefs: VesselDef[] = [];
  private boats: Boat[] = [];
  private boatMeshes: Bucket[][] = [];
  /** Sampled water cells boats are allowed to occupy: [x,z,riverFlag]. */
  private waterCells: Float32Array = new Float32Array(0);
  /** Coarse bucket index over `waterCells`, so "am I still afloat?" is O(1). */
  private cellGrid = new Map<number, number[]>();

  private walkGraph: LaneGraph | null = null;
  private walkers: Walker[] = [];
  private walkMesh: THREE.InstancedMesh | null = null;
  private walkPhase: THREE.InstancedBufferAttribute | null = null;
  private walkSpawn = 0;

  private flagMesh: THREE.InstancedMesh | null = null;
  private flagUniforms = { uTime: { value: 0 }, uWind: { value: new THREE.Vector2(0.72, -0.69) } };

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

    this.buildVehicles(ctx);
    this.buildWalkers(ctx, roads);
    this.buildWaterCells(areas);
    this.buildVessels(ctx);
    this.buildFlags(ctx, props);

    ctx.stats.trafficEdges = this.graph.edges.length;
    ctx.stats.vehicles = this.cars.length;
    ctx.stats.boats = this.boats.length;
    ctx.stats.pedestrians = this.walkers.length;
    console.info(
      `[Traffic] ${this.graph.edges.length} lane edges over ${this.graph.totalKm.toFixed(0)} km, ` +
      `${this.cars.length} vehicles, ${this.walkers.length} pedestrians, ` +
      `${this.boats.length} vessels, ${this.flagMesh?.count ?? 0} flags`,
    );

    ctx.on('quality-changed', () => this.resizePool(ctx));
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
      for (const [part, geo] of Object.entries(d.parts) as [Part, THREE.BufferGeometry | null][]) {
        if (!geo) continue;
        const mesh = new THREE.InstancedMesh(geo, this.carMaterial(ctx, part, d.color), cap);
        mesh.name = `traffic:${d.name}:${part}`;
        // Only the shell casts: glass and lights add four shadow-cascade
        // draws each for shadows you would never see.
        mesh.castShadow = part === 'shell';
        mesh.receiveShadow = true;
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
        type: this.typeOrder[i], edge: -1, s: 0, lane: 0,
        speed: 0, cruise: 0, colour: 0, active: false,
      });
    }
  }

  private carMaterial(ctx: Ctx, part: Part, fixed?: number): THREE.Material {
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
        // One material for both ends: headlamps read warm-white and tail
        // lamps red because the geometry carries the tint, and at the size a
        // car occupies on screen that is the whole effect.
        const m = mk({ name: 'car:light', color: 0x2a1c18, roughness: 0.24, metalness: 0.2,
          emissive: new THREE.Color(0xffc891), emissiveIntensity: 0 });
        m.userData.nightPeak = 4.2;
        this.nightLit.push(m);
        return m;
      }
      default:
        // Painted bodywork, with trim and tyres baked dark into the vertex
        // colour so the per-instance tint only reaches the panels.
        return mk({
          name: 'car:shell',
          color: fixed ?? 0xffffff,
          roughness: 0.28, metalness: 0.35, envMapIntensity: 1.3,
          vertexColors: true,
        });
    }
  }

  /** Put a car on a road just outside the camera's view. */
  private spawn(car: Car, ctx: Ctx): void {
    const g = this.graph!;
    const cam = ctx.camera.position;
    // Rejection-sample a handful of edges rather than searching: the network
    // is dense enough that a few tries almost always lands one in range.
    for (let attempt = 0; attempt < 12; attempt++) {
      const ei = (this.spawnCursor = (this.spawnCursor + 7919) % g.edges.length);
      const e = g.edges[ei];
      const mid = Math.floor(e.cum.length / 2) * 3;
      const dx = e.pts[mid] - cam.x;
      const dz = e.pts[mid + 2] - cam.z;
      const d = Math.hypot(dx, dz);
      if (d > SIM_RADIUS) continue;
      car.edge = ei;
      car.s = Math.random() * e.length;
      car.lane = Math.floor(Math.random() * e.lanes);
      car.cruise = e.speed * (0.78 + Math.random() * 0.34);
      car.speed = car.cruise;
      car.colour = CAR_COLORS[(Math.random() * CAR_COLORS.length) | 0];
      car.active = true;
      return;
    }
    car.active = false;
  }

  private stepCars(dt: number, ctx: Ctx): void {
    const g = this.graph!;
    const cam = ctx.camera.position;
    const p = { x: 0, y: 0, z: 0, hx: 1, hz: 0 };
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const up = new THREE.Vector3(0, 1, 0);
    const pos = new THREE.Vector3();
    const one = new THREE.Vector3(1, 1, 1);
    const col = new THREE.Color();

    // Reset per-type write cursors.
    const cursor = new Array(this.defs.length).fill(0);

    for (const car of this.cars) {
      if (!car.active) { this.spawn(car, ctx); if (!car.active) continue; }

      const e = g.edges[car.edge];
      car.speed += (car.cruise - car.speed) * Math.min(dt * 0.8, 1);
      car.s += car.speed * dt;

      if (car.s >= e.length) {
        // Hand off to an outgoing edge at the far node, preferring to keep
        // going straight and never dropping from a viaduct onto the street.
        const outs = g.out[e.to];
        if (!outs || !outs.length) { car.active = false; continue; }
        let next = outs[(Math.random() * outs.length) | 0];
        for (let i = 0; i < outs.length; i++) {
          if (g.edges[outs[i]].layer === e.layer) { next = outs[i]; break; }
        }
        car.s -= e.length;
        car.edge = next;
        const ne = g.edges[next];
        car.lane = Math.min(car.lane, ne.lanes - 1);
        car.cruise = ne.speed * (0.78 + Math.random() * 0.34);
        continue;
      }

      sampleEdge(e, car.s, p);

      const dx = p.x - cam.x;
      const dz = p.z - cam.z;
      if (dx * dx + dz * dz > RECYCLE_RADIUS * RECYCLE_RADIUS) { car.active = false; continue; }

      const t = car.type;
      const buckets = this.carMeshes[t];
      const slot = cursor[t];
      if (slot >= buckets[0].mesh.instanceMatrix.count) continue;
      cursor[t] = slot + 1;

      // Right-hand traffic: offset to the right of the centreline.
      const off = (car.lane + 0.5) * LANE_W;
      pos.set(p.x + p.hz * off, p.y, p.z - p.hx * off);
      q.setFromAxisAngle(up, Math.atan2(p.hx, p.hz));
      m.compose(pos, q, one);

      for (const b of buckets) {
        b.mesh.setMatrixAt(slot, m);
        if (b.part === 'shell' && b.mesh.instanceColor) {
          col.setHex(car.colour).convertSRGBToLinear();
          b.mesh.instanceColor.setXYZ(slot, col.r, col.g, col.b);
        }
      }
    }

    for (let t = 0; t < this.carMeshes.length; t++) {
      for (const b of this.carMeshes[t]) {
        b.mesh.count = cursor[t];
        b.mesh.instanceMatrix.needsUpdate = true;
        if (b.mesh.instanceColor) b.mesh.instanceColor.needsUpdate = true;
      }
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

    const n = WALKERS[ctx.tier] ?? 400;
    const geo = pedestrianGeometry();
    const phase = new THREE.InstancedBufferAttribute(new Float32Array(n), 1);
    geo.setAttribute('aPhase', phase);
    this.walkPhase = phase;

    const mat = new THREE.MeshStandardMaterial({
      name: 'pedestrian', roughness: 0.82, metalness: 0, vertexColors: true,
    });
    mat.onBeforeCompile = (sh) => {
      sh.vertexShader = sh.vertexShader
        .replace('#include <common>', '#include <common>\nattribute float stride;\nattribute float aPhase;')
        .replace('#include <begin_vertex>', /* glsl */ `
          #include <begin_vertex>
          // Swing limbs about the hip/shoulder. 'stride' is 0 on the torso,
          // +/-1 on the legs and +/-0.7 on the arms, so they counter-swing.
          if (abs(stride) > 0.01) {
            float a = sin(aPhase) * 0.62 * stride;
            float pivot = stride > 0.9 || stride < -0.9 ? 0.87 : 1.40;
            float dy = transformed.y - pivot;
            float c = cos(a), sn = sin(a);
            transformed.x += dy * sn;
            transformed.y = pivot + dy * c;
          }
        `);
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
      this.walkers.push({ edge: -1, s: 0, side: 0, speed: 1.4, colour: 0, phase: 0, active: false });
    }
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
      w.side = (Math.random() - 0.5) * 1.3;
      w.speed = 1.05 + Math.random() * 0.62;
      w.colour = CLOTHES[(Math.random() * CLOTHES.length) | 0];
      w.phase = Math.random() * 6.283;
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
    const p = { x: 0, y: 0, z: 0, hx: 1, hz: 0 };
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const up = new THREE.Vector3(0, 1, 0);
    const pos = new THREE.Vector3();
    const one = new THREE.Vector3(1, 1, 1);
    const col = new THREE.Color();
    const phaseArr = this.walkPhase!.array as Float32Array;
    let slot = 0;
    const cap = mesh.instanceMatrix.count;

    for (const w of this.walkers) {
      if (!w.active) { this.spawnWalker(w, ctx); if (!w.active) continue; }
      const e = g.edges[w.edge];
      w.s += w.speed * dt;
      // A 1.7 m stride at this speed; two steps per cycle.
      w.phase += (w.speed / 0.85) * dt * Math.PI;

      if (w.s >= e.length) {
        const outs = g.out[e.to];
        if (!outs || !outs.length) { w.active = false; continue; }
        w.s -= e.length;
        w.edge = outs[(Math.random() * outs.length) | 0];
        continue;
      }
      sampleEdge(e, w.s, p);
      if (Math.hypot(p.x - cam.x, p.z - cam.z) > WALK_RECYCLE) { w.active = false; continue; }
      if (slot >= cap) continue;

      pos.set(p.x + p.hz * w.side, p.y, p.z - p.hx * w.side);
      q.setFromAxisAngle(up, Math.atan2(p.hx, p.hz));
      m.compose(pos, q, one);
      mesh.setMatrixAt(slot, m);
      col.setHex(w.colour).convertSRGBToLinear();
      mesh.instanceColor!.setXYZ(slot, col.r, col.g, col.b);
      phaseArr[slot] = w.phase;
      slot++;
    }

    mesh.count = slot;
    mesh.instanceMatrix.needsUpdate = true;
    mesh.instanceColor!.needsUpdate = true;
    this.walkPhase!.needsUpdate = true;
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
    const want = BOATS[ctx.tier] ?? 34;
    const total = this.vdefs.reduce((n, d) => n + d.weight, 0);

    for (let t = 0; t < this.vdefs.length; t++) {
      const d = this.vdefs[t];
      const cap = Math.max(1, Math.round((want * d.weight) / total));
      const buckets: Bucket[] = [];
      for (const [part, geo] of Object.entries(d.parts) as [VesselPart, THREE.BufferGeometry][]) {
        const mesh = new THREE.InstancedMesh(geo, this.vesselMaterial(part, d.hullColor), cap);
        mesh.name = `vessel:${d.name}:${part}`;
        // As with the cars, only the main mass casts; the glass and rigging
        // would cost four extra cascade draws each for nothing.
        mesh.castShadow = part === 'hull' || part === 'house';
        mesh.receiveShadow = true;
        mesh.frustumCulled = false;
        mesh.count = 0;
        this.root.add(mesh);
        buckets.push({ mesh, part });
      }
      this.boatMeshes.push(buckets);

      for (let i = 0; i < cap; i++) {
        const b: Boat = { type: t, x: 0, z: 0, heading: 0, speed: d.speed, turn: 0, colour: d.hullColor };
        this.placeBoat(b);
        this.boats.push(b);
      }
    }
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
      case 'dark':  return mk({ name: 'boat:dark', color: 0x2a2c30, roughness: 0.55, metalness: 0.4 });
      default:      return mk({ name: 'boat:hull', color: hull, roughness: 0.38, metalness: 0.15,
        envMapIntensity: 1.2 });
    }
  }

  /** Drop a boat on a random legal water cell of the right kind. */
  private placeBoat(b: Boat): void {
    const n = this.waterCells.length / 3;
    const want = this.vdefs[b.type].water;
    for (let i = 0; i < 24; i++) {
      const k = (Math.random() * n) | 0;
      const river = this.waterCells[k * 3 + 2] > 0.5;
      if (want === 'river' && !river) continue;
      if (want === 'harbour' && river) continue;
      b.x = this.waterCells[k * 3];
      b.z = this.waterCells[k * 3 + 1];
      b.heading = Math.random() * Math.PI * 2;
      b.turn = (Math.random() - 0.5) * 0.06;
      return;
    }
  }

  private stepBoats(dt: number, ctx: Ctx): void {
    if (!this.boats.length) return;
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const e = new THREE.Euler();
    const pos = new THREE.Vector3();
    const one = new THREE.Vector3(1, 1, 1);
    const cursor = new Array(this.vdefs.length).fill(0);

    for (const b of this.boats) {
      b.heading += b.turn * dt;
      b.x += Math.sin(b.heading) * b.speed * dt;
      b.z += Math.cos(b.heading) * b.speed * dt;

      // If it has wandered off navigable water, put it back somewhere legal.
      if (!this.afloat(b.x, b.z)) { this.placeBoat(b); continue; }
      if (Math.random() < dt * 0.08) b.turn = (Math.random() - 0.5) * 0.06;

      const t = b.type;
      const buckets = this.boatMeshes[t];
      const slot = cursor[t];
      if (slot >= buckets[0].mesh.instanceMatrix.count) continue;
      cursor[t] = slot + 1;

      // Ride the swell: a slow pitch and roll scaled to the hull's length, so
      // a rowing shell bobs and a container ship barely moves.
      const scale = Math.min(20 / this.vdefs[t].length, 1);
      const ph = this.time * 0.9 + b.x * 0.02;
      pos.set(b.x, Math.sin(ph) * 0.09 * scale, b.z);
      e.set(Math.sin(ph * 0.8) * 0.02 * scale, b.heading, Math.cos(ph * 1.1) * 0.035 * scale);
      q.setFromEuler(e);
      m.compose(pos, q, one);
      for (const bk of buckets) bk.mesh.setMatrixAt(slot, m);
    }

    for (let t = 0; t < this.boatMeshes.length; t++) {
      for (const bk of this.boatMeshes[t]) {
        bk.mesh.count = cursor[t];
        bk.mesh.instanceMatrix.needsUpdate = true;
      }
    }
    void ctx;
  }

  /** True when a sampled water cell lies within one bucket of this point. */
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
          if (dx * dx + dz * dz < 140 * 140) return true;
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
      q.setFromAxisAngle(up, Math.atan2(this.flagUniforms.uWind.value.x, this.flagUniforms.uWind.value.y));
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

    this.stepCars(dt, ctx);
    this.stepWalkers(dt, ctx);
    this.stepBoats(dt, ctx);

    // Headlights and tail lights on the same civil-twilight curve as the rest
    // of the city, with the same exposure compensation.
    const e = ctx.sun?.elevation ?? 0.5;
    const t = THREE.MathUtils.clamp((0.16 - e) / 0.22, 0, 1);
    const comp = 2.5 / Math.max(ctx.exposure || 2.5, 0.1);
    const k = t * t * (3 - 2 * t) * comp;
    for (const m of this.nightLit) m.emissiveIntensity = k * ((m.userData.nightPeak as number) ?? 1);
  }

  dispose(ctx: Ctx): void {
    ctx.scene.remove(this.root);
    this.root.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.isMesh) m.geometry?.dispose();
    });
    for (const m of this.materials) m.dispose();
    this.materials.length = 0;
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
