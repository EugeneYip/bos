import * as THREE from 'three';
import type { Ctx, WorldModule } from '../core/Context';
import type { CityManifest } from '../core/types';
import { dataUrl, loadManifest } from '../core/data';
import { MOBILE } from '../core/gpu';
import { TILE, tileOrigin, type TilePayload } from './buildings/build';
import { mergeChunks, type PackedChunk } from './buildings/mesh';
import { buildFacadeAtlas, type FacadeAtlas } from './buildings/atlas';
import {
  createShellUniforms, createShellMaterial, createClutterMaterial, createClutterDepthMaterial,
  createSpillMaterial, spillGeometry,
  type ShellUniforms,
} from './buildings/material';
import { clutterGeometries } from './buildings/clutterGeom';
import { CLUTTER_STRIDE, CLUTTER_KINDS } from './buildings/clutter';
import { SPILL_STRIDE } from './buildings/spill';
import type { WorkerReply, WorkerRequest } from './buildings/worker';

/**
 * Boston's 63,180 OSM buildings.
 *
 * Extrusion runs in a small worker pool — each worker fetches one shard and
 * returns finished typed arrays by transfer, so the main thread never blocks
 * on ear-clipping. Results are bucketed into 500 m tiles; each tile becomes
 * one mesh whose index buffer holds silhouette triangles first and decorative
 * ones after, so switching level of detail is a `drawRange` change rather than
 * a second copy of the geometry.
 *
 * Rooftop plant is instanced separately, four unit primitives covering every
 * vent, duct, tank and dish in the city.
 */

interface Tile {
  key: number;
  mesh: THREE.Mesh;
  /** Silhouette index count; the rest of the buffer is decorative trim. */
  coreCount: number;
  totalCount: number;
  center: THREE.Vector3;
  radius: number;
  /** True while the trim range is being drawn. */
  detailed: boolean;
  /** Which shard produced it, so unloading one can find its tiles. */
  shard: number;
}

/**
 * How far from the camera a building shard is kept, metres.
 *
 * Only mobile streams. A desktop loads the whole city up front as it always
 * has -- it is the memory ceiling that forces this, not the frame rate, and
 * a laptop has the headroom. An iPad does not: building all 61,574 buildings
 * at once is what makes iOS Safari reload the tab, which is what 'it kept
 * jumping out' turned out to be.
 *
 * 1.6 km covers the downtown peninsula from a street-level pose and holds
 * the skyline together when you fly. It was 2.6 km, which looked better and
 * cost 776 MB of peak heap -- and iOS kills the tab on the peak, not on the
 * settled figure. Shards are spatially bucketed by the build tool and carry
 * their bounds in the manifest, so this is a rectangle test rather than a
 * guess.
 */
const STREAM_RADIUS = 1600;
/** Extra margin before a loaded shard is thrown away, metres. Stops churn. */
const STREAM_HYSTERESIS = 700;

/**
 * How many ground-floor light pools can be on screen at once.
 *
 * The city produces a few hundred thousand of them, held on the CPU as eight
 * floats each and compacted into this many instances around the camera when
 * it moves, exactly as the rooftop clutter is. The shader fades a pool out
 * between 110 m and 260 m, so the cap only has to cover a couple of blocks;
 * downtown at street level fills about 1,800 of these.
 */
const MAX_SPILL = 6000;

export class Buildings implements WorldModule {
  readonly name = 'Buildings';

  private root = new THREE.Group();
  private tiles: Tile[] = [];
  private atlas: FacadeAtlas | null = null;
  private uniforms: ShellUniforms | null = null;
  private shell: THREE.MeshStandardMaterial | null = null;
  private clutterMesh: THREE.InstancedMesh[] = [];
  /** Per clutter mesh: prebuilt matrices and instance centres, for culling. */
  private clutterData: Array<{ matrices: Float32Array; px: Float32Array; pz: Float32Array }> = [];
  private lastClutterCull = new THREE.Vector3(1e9, 1e9, 1e9);
  private spillMesh: THREE.InstancedMesh | null = null;
  /** Every pool in the loaded city, SPILL_STRIDE floats each. */
  private spillSrc: Float32Array | null = null;
  private spillAttr: THREE.InstancedBufferAttribute | null = null;
  private lastSpillCull = new THREE.Vector3(1e9, 1e9, 1e9);
  private spillMat = new THREE.Matrix4();
  private spillQuat = new THREE.Quaternion();
  private spillUp = new THREE.Vector3(0, 1, 0);
  private spillPos = new THREE.Vector3();
  private spillScale = new THREE.Vector3();
  private frustum = new THREE.Frustum();
  private sphere = new THREE.Sphere();
  private projScreen = new THREE.Matrix4();
  private lastLod = new THREE.Vector3(1e9, 1e9, 1e9);
  private built = 0;
  private skipped = 0;
  /** Streaming state; empty bounds means 'load everything, once'. */
  private shardUrls: string[] = [];
  private shardBounds: Array<[number, number, number, number]> = [];
  private skipLandmarks: string[] = [];
  private loadedShards = new Set<number>();
  private loadingShards = new Set<number>();
  private streaming = false;
  private radius = STREAM_RADIUS;
  private streamCountdown = 0;
  private lastStreamAt = new THREE.Vector3(1e9, 1e9, 1e9);

  async init(ctx: Ctx): Promise<void> {
    this.root.name = 'buildings';
    ctx.scene.add(this.root);

    let manifest: CityManifest;
    try {
      manifest = await loadManifest();
    } catch (err) {
      console.warn('[Buildings] no data; skipping', err);
      return;
    }

    const t0 = performance.now();

    // The atlas is the single biggest boot cost, so start it before the
    // workers and let the two overlap.
    const size = ctx.quality.shadowMapSize >= 4096 ? 1024 : ctx.quality.detailDistance > 700 ? 1024 : 512;
    const atlasPromise = buildFacadeAtlas(size, ctx.quality.anisotropy, async () => {
      await new Promise((r) => setTimeout(r, 0));
    }).catch((err) => {
      console.warn('[Buildings] facade atlas failed; falling back to flat shading', err);
      return null;
    });

    const skipLandmarks = [
      ...((ctx as unknown as { landmarkSlugs?: Set<string> }).landmarkSlugs ?? []),
    ];

    // Streaming needs three things from the manifest: the shard list, their
    // world bounds, and a device that cannot hold all of them at once.
    this.shardUrls = manifest.files.buildings.map((f) => dataUrl(f));
    this.shardBounds = manifest.shardBounds?.buildings ?? [];
    this.skipLandmarks = skipLandmarks;
    this.streaming = MOBILE && this.shardBounds.length === this.shardUrls.length;

    // A degraded boot pulls the radius in further still; see core/safeMode.
    this.radius = STREAM_RADIUS * (ctx.safeLevel > 0 ? (ctx.safeLevel > 1 ? 0.4 : 0.65) : 1);
    const first = this.streaming
      ? this.shardsNear(ctx.camera.position)
      : this.shardUrls.map((_, i) => i);
    const payloads = await this.runWorkers(first);

    this.atlas = await atlasPromise;
    this.uniforms = createShellUniforms(this.atlas);
    this.shell = createShellMaterial(this.uniforms, ctx.envMap);

    this.assembleTiles(payloads.tiles, payloads.shardOf);
    this.assembleClutter(ctx, payloads.clutter);
    this.assembleSpill(ctx, payloads.spill);
    for (const i of first) this.loadedShards.add(i);
    if (this.streaming) {
      this.lastStreamAt.copy(ctx.camera.position);
      console.info(
        `[Buildings] streaming: ${first.length} of ${this.shardUrls.length} shards within `
        + `${Math.round(this.radius)} m`,
      );
    }

    ctx.stats.buildings = this.built;
    ctx.stats.buildingTiles = this.tiles.length;
    console.info(
      `[Buildings] ${this.built} built, ${this.skipped} skipped, ${this.tiles.length} tiles, ` +
      `${Math.round(performance.now() - t0)} ms`,
    );

    ctx.on('quality-changed', () => {
      if (this.uniforms) this.uniforms.uLod.value = ctx.quality.detailDistance / 1400;
      this.lastLod.set(1e9, 1e9, 1e9);
    });
  }

  /**
   * Fan the shards out across a worker pool. Falls back to building on the
   * main thread if workers are unavailable (older Safari, blob-URL policies).
   */
  private async runWorkers(
    want: number[],
  ): Promise<{
    tiles: Map<number, PackedChunk[]>;
    clutter: Float32Array[][];
    spill: Float32Array[];
    shardOf: Map<number, number>;
  }> {
    const skipLandmarks = this.skipLandmarks;
    const urls = want.map((i) => this.shardUrls[i]);
    const tiles = new Map<number, PackedChunk[]>();
    const clutter: Float32Array[][] = [];
    const spill: Float32Array[] = [];
    // Which shard each tile key came from. Spatial sharding packs whole
    // tiles, so a tile has exactly one owner and unloading is unambiguous.
    const shardOf = new Map<number, number>();

    const absorb = (reply: WorkerReply): void => {
      this.built += reply.built ?? 0;
      this.skipped += reply.skipped ?? 0;
      for (const t of (reply.tiles ?? []) as TilePayload[]) {
        const arr = tiles.get(t.key);
        if (arr) arr.push(t.chunk);
        else tiles.set(t.key, [t.chunk]);
        shardOf.set(t.key, want[reply.index] ?? want[0]);
      }
      if (reply.clutter) clutter.push(reply.clutter);
      if (reply.spill?.length) spill.push(reply.spill);
    };

    let pool: Worker[] = [];
    try {
      const n = Math.max(1, Math.min(4, (navigator.hardwareConcurrency || 4) - 1));
      pool = Array.from({ length: n }, () =>
        new Worker(new URL('./buildings/worker.ts', import.meta.url), { type: 'module' }));
    } catch {
      pool = [];
    }

    if (!pool.length) {
      // Main-thread fallback: slower, but the city still appears.
      const { buildShard } = await import('./buildings/build');
      for (let i = 0; i < urls.length; i++) {
        const recs = await (await fetch(urls[i])).json();
        const out = buildShard(recs, { skipLandmarks });
        absorb({
          type: 'done', index: i, tiles: out.tiles, clutter: out.clutter, spill: out.spill,
          built: out.built, skipped: out.skipped,
        });
        await new Promise((r) => setTimeout(r, 0));
      }
      return { tiles, clutter, spill, shardOf };
    }

    let next = 0;
    await Promise.all(pool.map((w) => new Promise<void>((resolve) => {
      const send = (): void => {
        const index = next++;
        if (index >= urls.length) {
          w.terminate();
          resolve();
          return;
        }
        const req: WorkerRequest = { type: 'shard', index, url: urls[index], skipLandmarks };
        w.postMessage(req);
      };
      w.onmessage = (ev: MessageEvent<WorkerReply>) => {
        if (ev.data.type === 'error') console.warn(`[Buildings] shard ${ev.data.index}: ${ev.data.message}`);
        else absorb(ev.data);
        send();
      };
      w.onerror = (e) => { console.warn('[Buildings] worker error', e.message); w.terminate(); resolve(); };
      send();
    })));

    return { tiles, clutter, spill, shardOf };
  }

  /** One mesh per 500 m tile, silhouette indices first and trim after. */
  private assembleTiles(byKey: Map<number, PackedChunk[]>, shardOf?: Map<number, number>): void {
    for (const [key, parts] of byKey) {
      const chunk = parts.length === 1 ? parts[0] : mergeChunks(parts);
      if (!chunk || !chunk.vertexCount) continue;

      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(chunk.position, 3));
      // Byte normals padded to four components for alignment; the shader's
      // vec3 simply ignores the fourth.
      g.setAttribute('normal', new THREE.BufferAttribute(chunk.normal, 4, true));
      g.setAttribute('aMuv', new THREE.BufferAttribute(chunk.uv, 2));
      g.setAttribute('aTint', new THREE.BufferAttribute(chunk.tint, 4, true));
      // aSurf carries raw 0..255 codes (layer, flags, seed), not a colour.
      g.setAttribute('aSurf', new THREE.BufferAttribute(chunk.surf, 4, false));
      g.setAttribute('aPar', new THREE.BufferAttribute(chunk.par, 4, true));

      const core = chunk.core;
      const trim = chunk.trim;
      const idx = new Uint32Array(core.length + trim.length);
      idx.set(core, 0);
      idx.set(trim, core.length);
      g.setIndex(new THREE.BufferAttribute(idx, 1));
      g.setDrawRange(0, idx.length);
      g.computeBoundingSphere();

      const mesh = new THREE.Mesh(g, this.shell!);
      mesh.name = `buildings:${key}`;
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      // Let three.js cull: it tests the bounding sphere against the camera
      // frustum AND against each shadow cascade's frustum. Culling by hand
      // here only covers the camera, so every tile would still be submitted to
      // all four cascades — 1,400 shadow draws for a city that needs a few
      // hundred.
      mesh.frustumCulled = true;
      mesh.matrixAutoUpdate = false;
      this.root.add(mesh);

      const [ox, oz] = tileOrigin(key);
      const bs = g.boundingSphere;
      this.tiles.push({
        key,
        mesh,
        coreCount: core.length,
        totalCount: idx.length,
        center: bs ? bs.center.clone() : new THREE.Vector3(ox + TILE / 2, 0, oz + TILE / 2),
        radius: bs ? bs.radius : TILE,
        detailed: true,
        shard: shardOf?.get(key) ?? -1,
      });
    }
  }

  /**
   * Shards whose bounds come within `reach` of a point, nearest first.
   *
   * Nearest first matters: the loader works through them in order, so the
   * ground under the camera appears before the far side of the river.
   */
  private shardsNear(p: THREE.Vector3, reach = this.radius): number[] {
    const out: Array<{ i: number; d: number }> = [];
    for (let i = 0; i < this.shardBounds.length; i++) {
      const [x0, z0, x1, z1] = this.shardBounds[i];
      // Distance from the point to the rectangle, zero when inside it.
      const dx = Math.max(x0 - p.x, 0, p.x - x1);
      const dz = Math.max(z0 - p.z, 0, p.z - z1);
      const d = Math.hypot(dx, dz);
      if (d <= reach) out.push({ i, d });
    }
    out.sort((a, b) => a.d - b.d);
    return out.map((e) => e.i);
  }

  /** Drop every tile a shard owns, and the GPU buffers behind them. */
  private unloadShard(index: number): number {
    let dropped = 0;
    for (let i = this.tiles.length - 1; i >= 0; i--) {
      const t = this.tiles[i];
      if (t.shard !== index) continue;
      this.root.remove(t.mesh);
      t.mesh.geometry.dispose();
      this.tiles.splice(i, 1);
      dropped++;
    }
    this.loadedShards.delete(index);
    return dropped;
  }

  /**
   * Bring the loaded set in line with where the camera is.
   *
   * Loading is asynchronous and unloading is not, so the two are deliberately
   * asymmetric: a shard is loaded as soon as it comes within the radius, and
   * only dropped once it is a further {@link STREAM_HYSTERESIS} out. Without
   * that margin a camera sitting on a boundary would load and free the same
   * shard forever.
   */
  private async reconcile(ctx: Ctx): Promise<void> {
    const cam = ctx.camera.position;
    const want = new Set(this.shardsNear(cam));
    const keep = new Set(this.shardsNear(cam, this.radius + STREAM_HYSTERESIS));

    for (const i of [...this.loadedShards]) {
      if (!keep.has(i)) this.unloadShard(i);
    }

    const missing = [...want].filter((i) => !this.loadedShards.has(i) && !this.loadingShards.has(i));
    if (!missing.length) return;

    // One shard at a time: each is a worker spin-up and a few thousand
    // extrusions, and doing four at once on a phone is a visible hitch.
    const next = missing[0];
    this.loadingShards.add(next);
    try {
      const payload = await this.runWorkers([next]);
      // The camera may have moved on while that was in flight.
      if (this.shardsNear(ctx.camera.position, this.radius + STREAM_HYSTERESIS).includes(next)) {
        this.assembleTiles(payload.tiles, payload.shardOf);
        this.loadedShards.add(next);
      }
    } catch (err) {
      console.warn(`[Buildings] shard ${next} failed to stream`, err);
    } finally {
      this.loadingShards.delete(next);
      ctx.stats.buildingTiles = this.tiles.length;
      ctx.stats.buildingShards = this.loadedShards.size;
    }
  }

  /** Four unit primitives cover every vent, duct, tank and dish in the city. */
  private assembleClutter(ctx: Ctx, batches: Float32Array[][]): void {
    if (!this.uniforms) return;
    const geos = clutterGeometries();
    const mat = createClutterMaterial(this.uniforms, ctx.envMap);
    const depth = createClutterDepthMaterial(this.uniforms);

    for (let kind = 0; kind < CLUTTER_KINDS; kind++) {
      let count = 0;
      for (const b of batches) count += (b[kind]?.length ?? 0) / CLUTTER_STRIDE;
      if (!count) continue;

      const mesh = new THREE.InstancedMesh(geos[kind], mat, count);
      mesh.name = `buildings:clutter:${kind}`;
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.frustumCulled = false;
      mesh.customDepthMaterial = depth;

      const tint = new Float32Array(count * 4);
      const layer = new Float32Array(count);
      const matrices = new Float32Array(count * 16);
      const px = new Float32Array(count);
      const pz = new Float32Array(count);
      const m = new THREE.Matrix4();
      const q = new THREE.Quaternion();
      const up = new THREE.Vector3(0, 1, 0);
      const pos = new THREE.Vector3();
      const scl = new THREE.Vector3();

      let i = 0;
      for (const b of batches) {
        const data = b[kind];
        if (!data) continue;
        for (let o = 0; o + CLUTTER_STRIDE <= data.length; o += CLUTTER_STRIDE, i++) {
          pos.set(data[o], data[o + 1], data[o + 2]);
          scl.set(data[o + 3], data[o + 4], data[o + 5]);
          q.setFromAxisAngle(up, data[o + 6]);
          m.compose(pos, q, scl);
          m.toArray(matrices, i * 16);
          px[i] = pos.x;
          pz[i] = pos.z;
          mesh.setMatrixAt(i, m);
          tint[i * 4] = data[o + 7];
          tint[i * 4 + 1] = data[o + 8];
          tint[i * 4 + 2] = data[o + 9];
          // Alpha carries a per-instance seed for the shader's variation.
          tint[i * 4 + 3] = (i * 0.61803398875) % 1;
          layer[i] = data[o + 10];
        }
      }
      mesh.instanceMatrix.needsUpdate = true;
      mesh.geometry.setAttribute('aTint', new THREE.InstancedBufferAttribute(tint, 4));
      mesh.geometry.setAttribute('aLayer', new THREE.InstancedBufferAttribute(layer, 1));
      this.root.add(mesh);
      this.clutterMesh.push(mesh);
      this.clutterData.push({ matrices, px, pz });
    }
    ctx.stats.roofClutter = this.clutterMesh.reduce((n, m) => n + m.count, 0);
  }

  /**
   * One instanced quad per lit ground-floor frontage, lying on the pavement.
   *
   * See `buildings/spill.ts` for why this is a decal and not a light. The
   * whole city is one draw call: the pools are held on the CPU as eight
   * floats each and the nearest {@link MAX_SPILL} are composed into the
   * instance buffer whenever the camera moves, which is the same trick the
   * rooftop clutter uses and for the same reason.
   */
  private assembleSpill(ctx: Ctx, batches: Float32Array[]): void {
    if (!this.uniforms) return;
    let total = 0;
    for (const b of batches) total += b.length;
    if (!total) return;

    const src = new Float32Array(total);
    let at = 0;
    for (const b of batches) {
      src.set(b, at);
      at += b.length;
    }
    this.spillSrc = src;

    const count = Math.min(src.length / SPILL_STRIDE, MAX_SPILL);
    const mesh = new THREE.InstancedMesh(spillGeometry(), createSpillMaterial(this.uniforms), count);
    mesh.name = 'buildings:spill';
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    // The instance set is rebuilt around the camera, so its bounds are always
    // 'wherever the camera is'; a stale bounding sphere would cull it away.
    mesh.frustumCulled = false;
    // After the opaque city, so the pool is added on top of the road rather
    // than fighting it for the same depth.
    mesh.renderOrder = 6;
    const attr = new THREE.InstancedBufferAttribute(new Float32Array(count * 2), 2);
    attr.setUsage(THREE.DynamicDrawUsage);
    mesh.geometry.setAttribute('aSpill', attr);
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    mesh.count = 0;
    this.spillAttr = attr;
    this.spillMesh = mesh;
    this.root.add(mesh);
    ctx.stats.windowSpill = src.length / SPILL_STRIDE;
  }

  /**
   * Compose the nearest pools into the instance buffer.
   *
   * Sorted by nothing: the cap is generous enough that downtown never reaches
   * it, and a pool that does get dropped is one the shader was already fading
   * out. Recomputed only when the camera has moved far enough to matter, as
   * with the clutter.
   */
  private cullSpill(ctx: Ctx): void {
    const mesh = this.spillMesh;
    const src = this.spillSrc;
    const attr = this.spillAttr;
    if (!mesh || !src || !attr) return;
    // Nothing to add by day, and the pools are a thousand additive quads that
    // would each shade a screenful of fragments to write zero.
    mesh.visible = (this.uniforms?.uNight.value ?? 0) > 0.003;
    if (!mesh.visible) return;
    const cam = ctx.camera.position;
    if (cam.distanceTo(this.lastSpillCull) < 18) return;
    this.lastSpillCull.copy(cam);

    // Matches the shader's own fade-out, with a margin so a pool is never
    // popped in while it is still visible.
    const r2 = 290 * 290;
    const cap = mesh.instanceMatrix.count;
    const m = this.spillMat;
    const q = this.spillQuat;
    const up = this.spillUp;
    const pos = this.spillPos;
    const scl = this.spillScale;
    const dst = mesh.instanceMatrix.array as Float32Array;
    const aux = attr.array as Float32Array;

    let n = 0;
    for (let o = 0; o + SPILL_STRIDE <= src.length && n < cap; o += SPILL_STRIDE) {
      const dx = src[o] - cam.x;
      const dz = src[o + 2] - cam.z;
      if (dx * dx + dz * dz > r2) continue;
      pos.set(src[o], src[o + 1], src[o + 2]);
      q.setFromAxisAngle(up, src[o + 3]);
      scl.set(src[o + 4], 1, src[o + 5]);
      m.compose(pos, q, scl);
      m.toArray(dst, n * 16);
      aux[n * 2] = src[o + 6];
      aux[n * 2 + 1] = src[o + 7];
      n++;
    }
    mesh.count = n;
    mesh.instanceMatrix.needsUpdate = true;
    attr.needsUpdate = true;
    ctx.stats.windowSpillDrawn = n;
  }

  update(_dt: number, ctx: Ctx): void {
    if (this.streaming && --this.streamCountdown <= 0) {
      this.streamCountdown = 30;
      // Only when the camera has actually gone somewhere. A rectangle test
      // against a dozen shards is cheap, but a worker spin-up is not.
      if (ctx.camera.position.distanceToSquared(this.lastStreamAt) > 150 * 150
        || this.loadingShards.size > 0) {
        this.lastStreamAt.copy(ctx.camera.position);
        void this.reconcile(ctx);
      }
    }

    const u = this.uniforms;
    if (!u || !this.tiles.length) return;

    u.uCamPos.value.copy(ctx.camera.position);
    u.uLod.value = ctx.quality.detailDistance / 1400;

    // Window lighting tracks the same civil-twilight curve as the landmarks
    // and street lamps, so the whole city comes on together.
    const e = ctx.sun?.elevation ?? 0.5;
    const t = THREE.MathUtils.clamp((0.14 - e) / 0.21, 0, 1);
    u.uNight.value = t * t * (3 - 2 * t);

    // Lit windows are authored display-referred, and the frame's exposure winds
    // up roughly six-fold once the sun is down, so they have to come back down
    // by the same factor. `ctx.exposure` is what the frame is actually
    // presented at, which is not the same as the sky's artistic value.
    //
    // The gain itself is a *photographic* decision, not a physical one. At 2.6
    // a lit window sat past the tonemapper's shoulder, so the mean of a
    // distant facade — where the individual windows are sub-pixel and average
    // out at about half lit — landed at 0.89 display and the whole tower went
    // to a flat white slab. A window is a midtone in a night exposure; the
    // highlights are the street lamps and the signs. Note that this cannot be
    // tuned open-loop: the windows are most of the light in the frame, so the
    // metering gives back roughly half of any reduction.
    const expo = ctx.exposure || 2.5;
    u.uWindowGain.value = 0.9 * (2.5 / Math.max(expo, 0.1));

    if (this.shell && ctx.envMap && this.shell.envMap !== ctx.envMap) {
      this.shell.envMap = ctx.envMap;
      this.shell.needsUpdate = true;
    }

    // Frustum cull every tile, and decide detail by screen-space error rather
    // than raw distance: from 2 km up, a whole neighbourhood is a few hundred
    // pixels tall and its window reveals and cornices are invisible, so a flat
    // distance threshold draws tens of millions of triangles nobody can see.
    this.projScreen.multiplyMatrices(ctx.camera.projectionMatrix, ctx.camera.matrixWorldInverse);
    this.frustum.setFromProjectionMatrix(this.projScreen);
    const cam = ctx.camera.position;

    // Pixels per metre at one metre of depth, for this camera and viewport.
    const vh = ctx.renderer.domElement.height;
    const focal = vh / (2 * Math.tan((ctx.camera.fov * Math.PI) / 360));
    // Trim is worth drawing while a typical 12 m storey-stack still covers
    // more than ~22 px. `detailDistance` scales the threshold per quality tier.
    const trimPixels = 22 * (1400 / Math.max(ctx.quality.detailDistance, 1));
    const trimRange = (12 * focal) / Math.max(trimPixels, 1);

    let visible = 0;
    let detailed = 0;
    for (const tile of this.tiles) {
      this.sphere.set(tile.center, tile.radius);
      if (this.frustum.intersectsSphere(this.sphere)) visible++;
      // Detail is decided for every tile, not just visible ones: a tile behind
      // the camera may still cast into a shadow cascade, and switching its
      // range while it is off-screen avoids a hitch when it swings into view.
      const near = tile.center.distanceTo(cam) - tile.radius < trimRange;
      if (near) detailed++;
      if (near !== tile.detailed) {
        tile.detailed = near;
        tile.mesh.geometry.setDrawRange(0, near ? tile.totalCount : tile.coreCount);
      }
    }
    ctx.stats.buildingTilesVisible = visible;
    ctx.stats.buildingTilesDetailed = detailed;

    this.cullClutter(ctx, trimRange);
    this.cullSpill(ctx);
  }

  /**
   * Rooftop plant only reads from close range, and there are 162,000 pieces of
   * it. The shader already collapses distant instances, but that still pays
   * their vertex cost, so compact the instance buffer to what is actually near
   * — recomputed only when the camera has moved far enough to matter.
   */
  private cullClutter(ctx: Ctx, range: number): void {
    if (!this.clutterMesh.length) return;
    const cam = ctx.camera.position;
    if (cam.distanceTo(this.lastClutterCull) < 45) return;
    this.lastClutterCull.copy(cam);

    const r2 = (range * 1.35) ** 2;
    let total = 0;
    for (let k = 0; k < this.clutterMesh.length; k++) {
      const mesh = this.clutterMesh[k];
      const d = this.clutterData[k];
      const arr = mesh.instanceMatrix.array as Float32Array;
      let n = 0;
      for (let i = 0; i < d.px.length; i++) {
        const dx = d.px[i] - cam.x;
        const dz = d.pz[i] - cam.z;
        if (dx * dx + dz * dz > r2) continue;
        arr.set(d.matrices.subarray(i * 16, i * 16 + 16), n * 16);
        n++;
      }
      mesh.count = n;
      mesh.instanceMatrix.needsUpdate = true;
      total += n;
    }
    ctx.stats.roofClutterDrawn = total;
  }

  dispose(ctx: Ctx): void {
    ctx.scene.remove(this.root);
    for (const t of this.tiles) t.mesh.geometry.dispose();
    for (const m of this.clutterMesh) m.geometry.dispose();
    this.spillMesh?.geometry.dispose();
    (this.spillMesh?.material as THREE.Material | undefined)?.dispose();
    this.spillSrc = null;
    this.shell?.dispose();
    this.atlas?.albedo?.dispose();
    this.atlas?.surface?.dispose();
    this.tiles.length = 0;
  }
}
