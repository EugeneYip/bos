import * as THREE from 'three';
import type RAPIER from '@dimforge/rapier3d-compat';
import type { Ctx, WorldModule } from '../core/Context';
import type { CharacterMoveRequest, VehicleStateRequest } from '../controls/types';
import type { BuildingRecord } from '../core/types';
import { loadBuildings } from '../core/data';

/**
 * Rapier rigid-body world.
 *
 * A full 63,000-building collision world would cost more memory and broadphase
 * time than it is worth, since the player can only ever touch what is nearby.
 * Instead colliders are **streamed**: building footprints are kept as cheap
 * CPU-side records, and only those within a radius of the player are promoted
 * to real Rapier colliders, retiring again as they fall behind.
 *
 * Terrain is a single heightfield collider rebuilt around the player on the
 * same schedule, so walking and driving follow the real ground.
 *
 * Published contracts (see `src/controls/types.ts`):
 *  - `ctx.physics.moveCharacter(pos, delta, radius, height)` — direct call.
 *  - `'physics:move-character'` event carrying a `CharacterMoveRequest`.
 *  - `'physics:get-vehicle'` event carrying a `VehicleStateRequest`.
 */

/** Radius around the player within which building colliders exist. */
const COLLIDER_RADIUS = 220;
/** Player movement before the active collider set is recomputed. */
const RESTREAM_DISTANCE = 60;
/** Side of the terrain heightfield patch kept under the player, in metres. */
const TERRAIN_PATCH = 600;
const TERRAIN_SAMPLES = 48;

interface Footprint {
  cx: number;
  cz: number;
  /** Bounding radius, for the streaming test. */
  r: number;
  /** Convex-ish hull in world metres, [x,z,...]. */
  hull: number[];
  base: number;
  top: number;
}

export class Physics implements WorldModule {
  readonly name = 'Physics';

  private R: typeof RAPIER | null = null;
  private world: RAPIER.World | null = null;
  private controller: RAPIER.KinematicCharacterController | null = null;

  private footprints: Footprint[] = [];
  private grid = new Map<string, number[]>();
  private active = new Map<number, RAPIER.Collider>();
  private lastStream = new THREE.Vector3(1e9, 1e9, 1e9);

  private terrainBody: RAPIER.RigidBody | null = null;
  private terrainCollider: RAPIER.Collider | null = null;
  private lastTerrain = new THREE.Vector3(1e9, 1e9, 1e9);

  private vehicle: {
    body: RAPIER.RigidBody;
    forward: THREE.Vector3;
    speed: number;
  } | null = null;

  private accumulator = 0;
  private static readonly STEP = 1 / 60;

  async init(ctx: Ctx): Promise<void> {
    try {
      const mod = await import('@dimforge/rapier3d-compat');
      await mod.default.init();
      this.R = mod.default;
    } catch (err) {
      console.warn('[Physics] Rapier failed to load; collision disabled', err);
      return;
    }
    const R = this.R;

    this.world = new R.World({ x: 0, y: -9.81, z: 0 });
    this.world.timestep = Physics.STEP;

    // Kinematic character controller: the standard way to move a player
    // against colliders without the jitter a dynamic capsule gives you.
    this.controller = this.world.createCharacterController(0.08);
    this.controller.setUp({ x: 0, y: 1, z: 0 });
    this.controller.enableAutostep(0.45, 0.25, true); // kerbs and single steps
    this.controller.enableSnapToGround(0.6);
    this.controller.setMaxSlopeClimbAngle((50 * Math.PI) / 180);
    this.controller.setMinSlopeSlideAngle((38 * Math.PI) / 180);
    this.controller.setApplyImpulsesToDynamicBodies(true);

    await this.loadFootprints(ctx);

    // Publish both the direct handle and the event contract, so callers can
    // use whichever they already hold.
    (ctx as unknown as Record<string, unknown>).physics = {
      moveCharacter: (
        pos: { x: number; y: number; z: number },
        delta: { x: number; y: number; z: number },
        radius: number,
        height: number,
      ) => this.moveCharacter(pos, delta, radius, height),
    };

    ctx.on('physics:move-character', (payload) => {
      const req = payload as CharacterMoveRequest;
      const res = this.moveCharacter(req.position, req.delta, req.radius, req.height);
      if (!res) return;
      req.out.x = res.x;
      req.out.y = res.y;
      req.out.z = res.z;
      req.grounded = this.controller?.computedGrounded() ?? false;
      req.handled = true;
    });

    ctx.on('physics:get-vehicle', (payload) => {
      const req = payload as VehicleStateRequest;
      if (!this.vehicle) return;
      const t = this.vehicle.body.translation();
      req.position.x = t.x; req.position.y = t.y; req.position.z = t.z;
      req.forward.x = this.vehicle.forward.x;
      req.forward.y = this.vehicle.forward.y;
      req.forward.z = this.vehicle.forward.z;
      req.speed = this.vehicle.speed;
      req.handled = true;
    });

    ctx.stats.physicsBodies = 0;
    console.info(`[Physics] Rapier ready, ${this.footprints.length} streamable footprints`);
  }

  /**
   * Reduce every building to a coarse hull. Rapier convex hulls are far
   * cheaper than trimeshes and a building is convex enough for collision that
   * the difference is imperceptible on foot.
   */
  private async loadFootprints(ctx: Ctx): Promise<void> {
    let buildings: BuildingRecord[] = [];
    try {
      buildings = await loadBuildings();
    } catch (err) {
      console.warn('[Physics] no building data; buildings will not collide', err);
      return;
    }

    for (const b of buildings) {
      const o = b.outline;
      if (!o || o.length < 6) continue;
      let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
      for (let i = 0; i < o.length; i += 2) {
        if (o[i] < minX) minX = o[i];
        if (o[i] > maxX) maxX = o[i];
        if (o[i + 1] < minZ) minZ = o[i + 1];
        if (o[i + 1] > maxZ) maxZ = o[i + 1];
      }
      const cx = (minX + maxX) / 2;
      const cz = (minZ + maxZ) / 2;
      const idx = this.footprints.length;
      this.footprints.push({
        cx, cz,
        r: Math.hypot(maxX - minX, maxZ - minZ) / 2,
        hull: o,
        base: b.ground + b.minHeight,
        top: b.ground + b.height + b.roofHeight,
      });

      // Uniform grid so streaming is a local lookup, not a 63k scan.
      const key = Physics.cell(cx, cz);
      const bucket = this.grid.get(key);
      if (bucket) bucket.push(idx);
      else this.grid.set(key, [idx]);
    }
    void ctx;
  }

  private static readonly CELL = 250;
  private static cell(x: number, z: number): string {
    return `${Math.floor(x / Physics.CELL)},${Math.floor(z / Physics.CELL)}`;
  }

  /** Promote nearby footprints to colliders and retire distant ones. */
  private restream(ctx: Ctx, at: THREE.Vector3): void {
    const R = this.R;
    const world = this.world;
    if (!R || !world) return;

    const want = new Set<number>();
    const span = Math.ceil(COLLIDER_RADIUS / Physics.CELL);
    const cx = Math.floor(at.x / Physics.CELL);
    const cz = Math.floor(at.z / Physics.CELL);
    for (let gx = cx - span; gx <= cx + span; gx++) {
      for (let gz = cz - span; gz <= cz + span; gz++) {
        for (const i of this.grid.get(`${gx},${gz}`) ?? []) {
          const f = this.footprints[i];
          const dx = f.cx - at.x;
          const dz = f.cz - at.z;
          if (dx * dx + dz * dz <= (COLLIDER_RADIUS + f.r) ** 2) want.add(i);
        }
      }
    }

    for (const [i, col] of this.active) {
      if (want.has(i)) continue;
      world.removeCollider(col, false);
      this.active.delete(i);
    }

    for (const i of want) {
      if (this.active.has(i)) continue;
      const f = this.footprints[i];
      const height = Math.max(f.top - f.base, 2);
      // Convex hull of the footprint extruded to the building's height.
      const pts = new Float32Array((f.hull.length / 2) * 6);
      let w = 0;
      for (let k = 0; k < f.hull.length; k += 2) {
        const x = f.hull[k] - f.cx;
        const z = f.hull[k + 1] - f.cz;
        pts[w++] = x; pts[w++] = 0; pts[w++] = z;
        pts[w++] = x; pts[w++] = height; pts[w++] = z;
      }
      const desc = R.ColliderDesc.convexHull(pts);
      if (!desc) continue;
      desc.setTranslation(f.cx, f.base, f.cz);
      desc.setFriction(0.9);
      this.active.set(i, world.createCollider(desc));
    }

    ctx.stats.physicsBodies = this.active.size;
    this.lastStream.copy(at);
  }

  /** Keep a heightfield patch of real terrain under the player. */
  private restreamTerrain(ctx: Ctx, at: THREE.Vector3): void {
    const R = this.R;
    const world = this.world;
    if (!R || !world) return;

    if (this.terrainCollider) world.removeCollider(this.terrainCollider, false);
    if (this.terrainBody) world.removeRigidBody(this.terrainBody);

    const n = TERRAIN_SAMPLES;
    const step = TERRAIN_PATCH / n;
    const x0 = at.x - TERRAIN_PATCH / 2;
    const z0 = at.z - TERRAIN_PATCH / 2;
    // Rapier heightfields are column-major over (row=z, col=x) with rows+1 x cols+1.
    const heights = new Float32Array((n + 1) * (n + 1));
    for (let ix = 0; ix <= n; ix++) {
      for (let iz = 0; iz <= n; iz++) {
        heights[ix * (n + 1) + iz] = ctx.sampleHeight(x0 + ix * step, z0 + iz * step);
      }
    }

    this.terrainBody = world.createRigidBody(
      R.RigidBodyDesc.fixed().setTranslation(at.x, 0, at.z),
    );
    const desc = R.ColliderDesc.heightfield(
      n, n, heights, { x: TERRAIN_PATCH, y: 1, z: TERRAIN_PATCH },
    ).setFriction(1.0);
    this.terrainCollider = world.createCollider(desc, this.terrainBody);
    this.lastTerrain.copy(at);
  }

  /**
   * Slide a capsule by `delta`, returning the corrected position. Returns null
   * when physics is unavailable so callers can fall back to terrain-only.
   */
  moveCharacter(
    pos: { x: number; y: number; z: number },
    delta: { x: number; y: number; z: number },
    radius: number,
    height: number,
  ): { x: number; y: number; z: number } | null {
    const R = this.R;
    const world = this.world;
    const c = this.controller;
    if (!R || !world || !c) return null;

    // A throwaway kinematic capsule is cheaper than keeping one in sync, and
    // the controller only needs it for the sweep.
    const half = Math.max((height - 2 * radius) / 2, 0.05);
    const body = world.createRigidBody(
      R.RigidBodyDesc.kinematicPositionBased().setTranslation(pos.x, pos.y + height / 2, pos.z),
    );
    const col = world.createCollider(R.ColliderDesc.capsule(half, radius), body);
    try {
      c.computeColliderMovement(col, delta);
      const m = c.computedMovement();
      return { x: pos.x + m.x, y: pos.y + m.y, z: pos.z + m.z };
    } catch {
      return null;
    } finally {
      world.removeCollider(col, false);
      world.removeRigidBody(body);
    }
  }

  update(dt: number, ctx: Ctx): void {
    const world = this.world;
    if (!world) return;

    const at = ctx.camera.position;
    if (at.distanceTo(this.lastStream) > RESTREAM_DISTANCE) this.restream(ctx, at);
    if (at.distanceTo(this.lastTerrain) > TERRAIN_PATCH * 0.3) this.restreamTerrain(ctx, at);

    // Fixed-step integration so behaviour is frame-rate independent, with a
    // cap so a long stall can't spiral into a catch-up death loop.
    this.accumulator = Math.min(this.accumulator + dt, 0.2);
    let steps = 0;
    while (this.accumulator >= Physics.STEP && steps < 4) {
      world.step();
      this.accumulator -= Physics.STEP;
      steps++;
    }

    if (this.vehicle) {
      const v = this.vehicle.body.linvel();
      this.vehicle.speed = Math.hypot(v.x, v.z);
      const q = this.vehicle.body.rotation();
      this.vehicle.forward
        .set(0, 0, -1)
        .applyQuaternion(new THREE.Quaternion(q.x, q.y, q.z, q.w));
    }
  }

  dispose(): void {
    this.active.clear();
    this.world?.free();
    this.world = null;
  }
}
