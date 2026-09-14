import * as THREE from 'three';
import type { Ctx, WorldModule } from '../core/Context';
import { loadAreas, loadTerrain } from '../core/data';
import { Heightfield } from './terrain/Heightfield';
import { rasteriseLandCover } from './terrain/landcover';
import { carveShoreline } from './terrain/shoreline';
import { buildFieldTextures, type FieldTextures } from './terrain/fieldTextures';
import { buildGridGeometry, GRID_N, Quadtree } from './terrain/cdlod';
import { bakeSurfaces, type SurfaceLibrary } from './terrain/surfaces';
import { createTerrainDepthMaterial, createTerrainMaterial, type TerrainUniforms } from './terrain/material';

/** Refinement of the shipped ~9 m DEM posts. 2 gives ~4.5 m, which is what the
 * shoreline needs to read as a shoreline rather than as a staircase. */
const UPSAMPLE = 2;
const MAX_CHUNKS = 6144;

export interface TerrainDebugApi {
  /** 0 off, 1 LOD levels, 2 splat weights, 3 shoreline field, 4 morph. */
  setDebug(mode: number): void;
  setWireframe(on: boolean): void;
  setVisible(on: boolean): void;
  setLodBias(bias: number): void;
  stats(): Record<string, number | string>;
  /** Times the terrain alone, with everything else in the scene hidden. */
  bench(frames?: number): { terrainMs: number; sceneMs: number; chunks: number; tris: number };
  sampleHeight(x: number, z: number): number;
}

/** Heightfield ground surface with blended land-cover materials. */
export class Terrain implements WorldModule {
  readonly name = 'Terrain';

  private hf?: Heightfield;
  private tree?: Quadtree;
  private mesh?: THREE.Mesh;
  private geometry?: THREE.InstancedBufferGeometry;
  private material?: THREE.MeshStandardMaterial;
  private depthMaterial?: THREE.MeshDepthMaterial;
  private uniforms?: TerrainUniforms;
  private fields?: FieldTextures;
  private surfaces?: SurfaceLibrary;
  private instanceBuffer?: THREE.InstancedInterleavedBuffer;
  private lodBias = 1;
  private chunkCount = 0;
  private ctx?: Ctx;

  async init(ctx: Ctx): Promise<void> {
    this.ctx = ctx;
    const t0 = performance.now();

    const [td, areas] = await Promise.all([loadTerrain(), loadAreas()]);
    const tLoad = performance.now();

    const hf = Heightfield.fromData(td, UPSAMPLE);
    this.hf = hf;
    const tGrid = performance.now();

    const grid = {
      width: hf.width,
      height: hf.height,
      originX: hf.originX,
      originZ: hf.originZ,
      spacingX: hf.spacingX,
      spacingZ: hf.spacingZ,
    };
    const cover = rasteriseLandCover(areas, grid);
    const tCover = performance.now();

    // Coverage is easy to get silently wrong — a bad grid or an empty area
    // list yields an all-zero map, which renders as a city paved end to end
    // in concrete rather than one with parks in it.
    let painted = 0;
    let greenCells = 0;
    for (let i = 0; i < cover.cover.length; i += 4) {
      if (cover.cover[i] || cover.cover[i + 1] || cover.cover[i + 2] || cover.cover[i + 3]) painted++;
      if (cover.cover[i] > 8) greenCells++;
    }
    const coverPct = (100 * painted) / (cover.cover.length / 4);
    const greenPct = (100 * greenCells) / (cover.cover.length / 4);

    const shore = carveShoreline(hf, cover);
    const tShore = performance.now();

    // Install the sampler the moment the heightfield is final: every module
    // after this one places its geometry with it.
    this.installSamplers(ctx, hf);

    const fields = buildFieldTextures(hf, cover, shore.shoreDist, ctx.quality.anisotropy);
    this.fields = fields;
    const tFields = performance.now();

    const tree = new Quadtree(hf);
    this.tree = tree;
    const tTree = performance.now();

    const res = ctx.tier === 'low' ? 256 : ctx.tier === 'medium' ? 384 : 512;
    const surfaces = bakeSurfaces(ctx.renderer, ctx.materials, res, ctx.quality.anisotropy);
    this.surfaces = surfaces;
    const tBake = performance.now();

    const { material, uniforms } = createTerrainMaterial({
      height: fields.height,
      field: fields.normal,
      cover: fields.cover,
      albedoArray: surfaces.albedo,
      detailArray: surfaces.normal,
      tiles: surfaces.tiles,
      heightBase: fields.heightBase,
      heightRange: fields.heightRange,
      hfOriginX: hf.originX,
      hfOriginZ: hf.originZ,
      hfSpacingX: hf.spacingX,
      hfSpacingZ: hf.spacingZ,
      hfWidth: hf.width,
      hfHeight: hf.height,
    });
    this.material = material;
    this.uniforms = uniforms;
    this.depthMaterial = createTerrainDepthMaterial(uniforms);

    const geometry = buildGridGeometry(GRID_N);
    const normals = new Float32Array((GRID_N + 1) * (GRID_N + 1) * 3);
    for (let i = 1; i < normals.length; i += 3) normals[i] = 1;
    geometry.setAttribute('normal', new THREE.BufferAttribute(normals, 3));

    const buffer = new THREE.InstancedInterleavedBuffer(new Float32Array(MAX_CHUNKS * 5), 5, 1);
    buffer.setUsage(THREE.DynamicDrawUsage);
    geometry.setAttribute('iChunk', new THREE.InterleavedBufferAttribute(buffer, 4, 0));
    geometry.setAttribute('iMeta', new THREE.InterleavedBufferAttribute(buffer, 1, 4));
    geometry.instanceCount = 0;
    this.instanceBuffer = buffer;
    this.geometry = geometry;

    const mesh = new THREE.Mesh(geometry, material);
    mesh.name = 'terrain';
    mesh.frustumCulled = false;
    mesh.receiveShadow = true;
    mesh.castShadow = false;
    mesh.customDepthMaterial = this.depthMaterial;
    mesh.matrixAutoUpdate = false;
    mesh.renderOrder = -10;
    ctx.scene.add(mesh);
    this.mesh = mesh;

    ctx.on('quality-changed', () => this.applyQuality(ctx));
    this.applyQuality(ctx);
    this.readUrlOverrides();
    (window as unknown as Record<string, unknown>).__terrain = this.debugApi();

    const t1 = performance.now();
    const hills = probeHills(hf);
    ctx.stats.terrainPosts = hf.width * hf.height;
    ctx.stats.terrainNodes = tree.nodeCount;
    ctx.stats.terrainVram = `${Math.round((fields.bytes + surfaces.bytes) / 1048576)}MB`;

    console.info(
      `[Terrain] ${hf.width}x${hf.height} posts @ ${hf.spacingX.toFixed(2)}m `
      + `(${(hf.width * hf.height / 1e6).toFixed(2)}M), ${tree.nodeCount} quadtree nodes, `
      + `elevation ${hf.minElevation.toFixed(2)}..${hf.maxElevation.toFixed(2)} m, `
      + `${shore.carved} cells carved to ${shore.deepest.toFixed(1)} m, `
      + `cover ${coverPct.toFixed(1)}% painted / ${greenPct.toFixed(1)}% green from ${areas.length} areas, `
      + `surfaces ${surfaces.adopted.length ? `adopted[${surfaces.adopted.join(',')}]` : 'procedural'}\n`
      + `[Terrain] init ${(t1 - t0).toFixed(0)}ms = fetch ${(tLoad - t0).toFixed(0)} `
      + `+ refine ${(tGrid - tLoad).toFixed(0)} + landcover ${(tCover - tGrid).toFixed(0)} `
      + `+ shoreline ${(tShore - tCover).toFixed(0)} + fields ${(tFields - tShore).toFixed(0)} `
      + `+ quadtree ${(tTree - tFields).toFixed(0)} + surfaces ${(tBake - tTree).toFixed(0)}\n`
      + `[Terrain] sampleHeight ${measureSampler(hf).toFixed(1)} ns/call\n`
      + `[Terrain] hills: ${hills}`,
    );
  }

  update(_dt: number, ctx: Ctx): void {
    const tree = this.tree;
    const geo = this.geometry;
    const buf = this.instanceBuffer;
    if (!tree || !geo || !buf) return;

    const sel = tree.select(ctx.camera, this.lodBias);
    const n = Math.min(sel.nodes, MAX_CHUNKS);
    this.chunkCount = n;
    buf.array.set(tree.instances.subarray(0, n * 5));
    buf.clearUpdateRanges();
    buf.addUpdateRange(0, n * 5);
    buf.needsUpdate = true;
    geo.instanceCount = n;

    ctx.stats.terrainChunks = n;
    ctx.stats.terrainTris = sel.tris;
  }

  dispose(ctx: Ctx): void {
    if (this.mesh) ctx.scene.remove(this.mesh);
    this.geometry?.dispose();
    this.material?.dispose();
    this.depthMaterial?.dispose();
    this.fields?.dispose();
    this.surfaces?.dispose();
    delete (window as unknown as Record<string, unknown>).__terrain;
  }

  // ---------------------------------------------------------------- helpers

  /**
   * The single most-called function in the engine. Bound to local scalars
   * rather than `this` so the JIT sees a monomorphic, allocation-free closure.
   */
  private installSamplers(ctx: Ctx, hf: Heightfield): void {
    const d = hf.data;
    const w = hf.width;
    const h = hf.height;
    const ox = hf.originX;
    const oz = hf.originZ;
    const isx = hf.invSpacingX;
    const isz = hf.invSpacingZ;
    const maxI = w - 1.0001;
    const maxJ = h - 1.0001;

    const sample = (x: number, z: number): number => {
      let fx = (x - ox) * isx;
      let fz = (z - oz) * isz;
      if (!(fx > 0)) fx = 0; else if (fx > maxI) fx = maxI;
      if (!(fz > 0)) fz = 0; else if (fz > maxJ) fz = maxJ;
      const i = fx | 0;
      const j = fz | 0;
      const tx = fx - i;
      const r0 = j * w + i;
      const r1 = r0 + w;
      const a = d[r0];
      const top = a + (d[r0 + 1] - a) * tx;
      const c = d[r1];
      const bot = c + (d[r1 + 1] - c) * tx;
      return top + (bot - top) * (fz - j);
    };

    const ex = hf.spacingX;
    const ez = hf.spacingZ;
    const sampleNormal = (x: number, z: number, out?: THREE.Vector3): THREE.Vector3 => {
      const v = out ?? new THREE.Vector3();
      const dx = (sample(x - ex, z) - sample(x + ex, z)) / (2 * ex);
      const dz = (sample(x, z - ez) - sample(x, z + ez)) / (2 * ez);
      const inv = 1 / Math.sqrt(dx * dx + 1 + dz * dz);
      return v.set(dx * inv, inv, dz * inv);
    };

    ctx.sampleHeight = sample;
    (ctx as Ctx & {
      sampleNormal?: (x: number, z: number, out?: THREE.Vector3) => THREE.Vector3;
      terrainBounds?: { minX: number; maxX: number; minZ: number; maxZ: number };
    }).sampleNormal = sampleNormal;
    (ctx as Ctx & { terrainBounds?: unknown }).terrainBounds = {
      minX: hf.originX, maxX: hf.maxX, minZ: hf.originZ, maxZ: hf.maxZ,
    };
    ctx.emit('terrain-ready', { minY: hf.minElevation, maxY: hf.maxElevation });
  }

  private applyQuality(ctx: Ctx): void {
    const u = this.uniforms;
    if (!u) return;
    const tier = ctx.tier;
    this.lodBias = tier === 'low' ? 0.62 : tier === 'medium' ? 0.8 : tier === 'high' ? 1 : 1.25;
    const near = tier === 'low' ? 0 : tier === 'medium' ? 26 : tier === 'high' ? 42 : 60;
    u.uHexNear.value = near;
    u.uHexFar.value = near * 4.5 + 30;
    u.uNormalFar.value = tier === 'low' ? 140 : tier === 'medium' ? 260 : tier === 'high' ? 420 : 620;
    if (this.surfaces) {
      this.surfaces.albedo.anisotropy = ctx.quality.anisotropy;
      this.surfaces.normal.anisotropy = ctx.quality.anisotropy;
    }
  }

  private readUrlOverrides(): void {
    const p = new URLSearchParams(location.search);
    const dbg = p.get('tdebug');
    if (dbg) this.setDebug(Number(dbg) || 0);
    if (p.get('twire') === '1') this.setWireframe(true);
    const bias = p.get('tlod');
    if (bias) this.lodBias = Number(bias) || 1;
  }

  private setDebug(mode: number): void {
    if (this.uniforms) this.uniforms.uDebug.value = mode;
  }

  private setWireframe(on: boolean): void {
    if (this.material) this.material.wireframe = on;
  }

  private debugApi(): TerrainDebugApi {
    return {
      setDebug: (m) => this.setDebug(m),
      setWireframe: (on) => this.setWireframe(on),
      setVisible: (on) => { if (this.mesh) this.mesh.visible = on; },
      setLodBias: (b) => { this.lodBias = b; },
      stats: () => ({
        chunks: this.chunkCount,
        tris: this.chunkCount * GRID_N * GRID_N * 2,
        nodes: this.tree?.nodeCount ?? 0,
        posts: this.hf ? this.hf.width * this.hf.height : 0,
        minY: this.hf?.minElevation ?? 0,
        maxY: this.hf?.maxElevation ?? 0,
      }),
      bench: (frames = 40) => this.bench(frames),
      sampleHeight: (x, z) => this.hf?.sample(x, z) ?? 0,
    };
  }

  /**
   * Renders the scene with and without the terrain, forcing a GPU sync each
   * time, so "terrain alone costs N ms" is a measurement rather than a guess.
   */
  private bench(frames: number): { terrainMs: number; sceneMs: number; chunks: number; tris: number } {
    const ctx = this.ctx;
    const mesh = this.mesh;
    if (!ctx || !mesh) return { terrainMs: 0, sceneMs: 0, chunks: 0, tris: 0 };
    const gl = ctx.renderer.getContext();
    const time = (fn: () => void): number => {
      fn();
      gl.finish();
      const t = performance.now();
      for (let i = 0; i < frames; i++) fn();
      gl.finish();
      return (performance.now() - t) / frames;
    };
    const draw = (): void => { ctx.renderer.render(ctx.scene, ctx.camera); };
    const sceneMs = time(draw);
    mesh.visible = false;
    const withoutMs = time(draw);
    mesh.visible = true;
    return {
      terrainMs: Math.max(0, sceneMs - withoutMs),
      sceneMs,
      chunks: this.chunkCount,
      tris: this.chunkCount * GRID_N * GRID_N * 2,
    };
  }
}

/** Rough ns-per-call cost of `sampleHeight` over a scattered access pattern. */
function measureSampler(hf: Heightfield): number {
  const N = 200000;
  const spanX = hf.sizeX;
  const spanZ = hf.sizeZ;
  let acc = 0;
  // Warm the JIT before timing.
  for (let i = 0; i < 20000; i++) acc += hf.sample(hf.originX + (i * 37) % spanX, hf.originZ + (i * 53) % spanZ);
  const t = performance.now();
  for (let i = 0; i < N; i++) {
    acc += hf.sample(hf.originX + (i * 37.13) % spanX, hf.originZ + (i * 53.71) % spanZ);
  }
  const ns = ((performance.now() - t) * 1e6) / N;
  if (!Number.isFinite(acc)) console.warn('[Terrain] sampler produced NaN');
  return ns;
}

const HILLS: Array<[string, number, number]> = [
  ['Beacon Hill', -20, -334],
  ['Bunker Hill (monument)', 383, -2334],
  ['Bunker Hill (crest)', -52, -2869],
  ['Copps Hill', 753, -1309],
  ['Fort Hill, Roxbury', -2199, 3306],
  ['Dorchester Heights', 1624, 2510],
  ['Parker Hill', -3276, 2930],
  ['Corey Hill', -5450, 1452],
];

function probeHills(hf: Heightfield): string {
  return HILLS.map(([name, x, z]) => `${name} ${hf.sample(x, z).toFixed(1)}m`).join(', ');
}
