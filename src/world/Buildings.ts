import * as THREE from 'three';
import type { Ctx, WorldModule } from '../core/Context';
import type { CityManifest } from '../core/types';
import { dataUrl, loadManifest } from '../core/data';
import { TILE, tileOrigin, type TilePayload } from './buildings/build';
import { mergeChunks, type PackedChunk } from './buildings/mesh';
import { buildFacadeAtlas, type FacadeAtlas } from './buildings/atlas';
import {
  createShellUniforms, createShellMaterial, createClutterMaterial, createClutterDepthMaterial,
  type ShellUniforms,
} from './buildings/material';
import { clutterGeometries } from './buildings/clutterGeom';
import { CLUTTER_STRIDE, CLUTTER_KINDS } from './buildings/clutter';
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
}

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
  private frustum = new THREE.Frustum();
  private sphere = new THREE.Sphere();
  private projScreen = new THREE.Matrix4();
  private lastLod = new THREE.Vector3(1e9, 1e9, 1e9);
  private built = 0;
  private skipped = 0;

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

    const payloads = await this.runWorkers(manifest, skipLandmarks);

    this.atlas = await atlasPromise;
    this.uniforms = createShellUniforms(this.atlas);
    this.shell = createShellMaterial(this.uniforms, ctx.envMap);

    this.assembleTiles(payloads.tiles);
    this.assembleClutter(ctx, payloads.clutter);

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
    manifest: CityManifest,
    skipLandmarks: string[],
  ): Promise<{ tiles: Map<number, PackedChunk[]>; clutter: Float32Array[][] }> {
    const urls = manifest.files.buildings.map((f) => dataUrl(f));
    const tiles = new Map<number, PackedChunk[]>();
    const clutter: Float32Array[][] = [];

    const absorb = (reply: WorkerReply): void => {
      this.built += reply.built ?? 0;
      this.skipped += reply.skipped ?? 0;
      for (const t of (reply.tiles ?? []) as TilePayload[]) {
        const arr = tiles.get(t.key);
        if (arr) arr.push(t.chunk);
        else tiles.set(t.key, [t.chunk]);
      }
      if (reply.clutter) clutter.push(reply.clutter);
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
        absorb({ type: 'done', index: i, tiles: out.tiles, clutter: out.clutter, built: out.built, skipped: out.skipped });
        await new Promise((r) => setTimeout(r, 0));
      }
      return { tiles, clutter };
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

    return { tiles, clutter };
  }

  /** One mesh per 500 m tile, silhouette indices first and trim after. */
  private assembleTiles(byKey: Map<number, PackedChunk[]>): void {
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
      });
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

  update(_dt: number, ctx: Ctx): void {
    const u = this.uniforms;
    if (!u || !this.tiles.length) return;

    u.uCamPos.value.copy(ctx.camera.position);
    u.uLod.value = ctx.quality.detailDistance / 1400;

    // Window lighting tracks the same civil-twilight curve as the landmarks
    // and street lamps, so the whole city comes on together.
    const e = ctx.sun?.elevation ?? 0.5;
    const t = THREE.MathUtils.clamp((0.14 - e) / 0.21, 0, 1);
    u.uNight.value = t * t * (3 - 2 * t);

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
    this.shell?.dispose();
    this.atlas?.albedo?.dispose();
    this.atlas?.surface?.dispose();
    this.tiles.length = 0;
  }
}
