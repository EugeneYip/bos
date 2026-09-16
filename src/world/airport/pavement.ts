/**
 * Runway, taxiway and apron pavement surfaces.
 *
 * One mesh per material (asphalt for runways/taxiways, concrete for aprons)
 * for the whole airfield — the project is GPU-bound on vertex/draw-call
 * count, not fill, so every polygon collapses into two draws rather than one
 * per polygon. Follows `Parks.ts`'s established pattern (ear-clip, drape on
 * terrain, vertex-colour tint, `DoubleSide` + `userData.noShadow`) and
 * `RoadMaterials`'s recipe for consuming the shared library — white base
 * colour, `vertexColors: true`, the family's own baked map carries the look
 * (`src/world/roads/materials.ts`) — mirrored rather than imported since both
 * belong to other modules.
 *
 * Runway surfaces are rebuilt as a clean rectangle from each `RunwaySpec`'s
 * measured length/width/centre/axis rather than replaying the source
 * polygon's own vertices: a runway *is* a rectangle, and rendering it as a
 * lengthwise strip is what makes the touchdown-zone rubber gradient below
 * possible without a general polygon-subdivision pass. The length, width,
 * position and orientation are still 100% the measured values from
 * `layout.ts` — only the OSM digitisation's small per-vertex wiggle is
 * smoothed away. Taxiways and aprons use their real outlines as-is.
 */
import * as THREE from 'three';
import type { Ctx } from '../../core/Context';
import { applyAntiTiling } from '../../materials/Materials';
import type { LoganLayout, RunwaySpec } from './layout';
import { MeshBuilder, type RGB } from './meshkit';

/**
 * Metres above the terrain sample the pavement sits. The terrain uses
 * continuous-LOD morphing, so its rendered surface slides vertically by more
 * than a few centimetres as chunks blend between levels (see `Parks.ts`,
 * which measured 0.22 m as enough to clear it) — a flatter lift lets the
 * terrain's own near-black runway landcover (`terrain/landcover.ts`) win the
 * depth test and show through as solid black, which is exactly what a first
 * pass at 0.05 m did here.
 */
const PAVEMENT_LIFT = 0.24;
const ASPHALT_TILE = 3.4;
const CONCRETE_TILE = 4.0;
const WHITE: RGB = [1, 1, 1];

/** How far from a threshold rubber accumulates, and how dark at its core. */
const RUBBER_REACH = 420;
const RUBBER_DARKEN = 0.6;

/** Shared with `markings.ts` so paint sits a consistent hair above the pavement. */
export { PAVEMENT_LIFT };

export interface PavementResult {
  meshes: THREE.Mesh[];
  materials: THREE.Material[];
}

export function buildPavement(ctx: Ctx, layout: LoganLayout): PavementResult {
  const materials: THREE.Material[] = [];
  const meshes: THREE.Mesh[] = [];
  const yAt = (x: number, z: number): number => ctx.sampleHeight(x, z) + PAVEMENT_LIFT;
  // Runways sit a hair above everything else so a reconstructed runway whose
  // position is not backed by a mapped polygon (see layout.ts's header — 9/27
  // has no OSM outline) never loses a depth tie to a real apron polygon it
  // happens to overlap; real runways are crowned above their surroundings
  // for drainage anyway, so this reads correctly even where it doesn't matter.
  const yAtRunway = (x: number, z: number): number => ctx.sampleHeight(x, z) + PAVEMENT_LIFT + 0.06;

  const asphalt = surfaceMaterial(ctx, 'asphalt', 0.92, materials);
  const concrete = surfaceMaterial(ctx, 'concrete', 0.87, materials);

  const asphaltMb = new MeshBuilder();
  for (const rw of layout.runways) emitRunwayStrip(asphaltMb, rw, yAtRunway);
  for (const tw of layout.taxiways) asphaltMb.polygon(tw.outline, yAt, ASPHALT_TILE, WHITE);
  const asphaltGeo = asphaltMb.build();
  if (asphaltGeo) meshes.push(finishMesh(asphaltGeo, asphalt, 'airport:pavement:asphalt'));

  const concreteMb = new MeshBuilder();
  for (const ap of layout.aprons) {
    // Slab-to-slab weathering variety, deterministic per polygon so it is
    // stable across reloads rather than a new roll every frame.
    const j = 1 + (hash01(ap.id) - 0.5) * 0.10;
    concreteMb.polygon(ap.outline, yAt, CONCRETE_TILE, [j, j, j]);
  }
  const concreteGeo = concreteMb.build();
  if (concreteGeo) meshes.push(finishMesh(concreteGeo, concrete, 'airport:pavement:apron'));

  return { meshes, materials };
}

/** Longitudinal strip of quads along the runway's own axis, ~60 m per segment. */
function emitRunwayStrip(mb: MeshBuilder, rw: RunwaySpec, yAt: (x: number, z: number) => number): void {
  const segs = Math.max(6, Math.round(rw.length / 60));
  const [ax, az] = rw.axis;
  const nx = -az, nz = ax;
  const hw = rw.width / 2;
  const inv = 1 / ASPHALT_TILE;
  const half = rw.length / 2;

  const point = (l: number, w: number): [number, number] => [rw.center[0] + ax * l + nx * w, rw.center[1] + az * l + nz * w];
  const colourAt = (l: number): RGB => {
    const dA = l + half;
    const dB = half - l;
    const t = THREE.MathUtils.clamp(1 - Math.min(dA, dB) / RUBBER_REACH, 0, 1);
    const k = 1 - RUBBER_DARKEN * t * t;
    return [k, k, k];
  };

  let prevA: [number, number] | null = null;
  let prevB: [number, number] | null = null;
  let prevC: RGB = WHITE;
  for (let i = 0; i <= segs; i++) {
    const l = -half + (rw.length * i) / segs;
    const a = point(l, -hw);
    const b = point(l, hw);
    const c = colourAt(l);
    if (prevA && prevB) {
      const i0 = mb.vert(prevA[0], yAt(prevA[0], prevA[1]), prevA[1], 0, 1, 0, prevA[0] * inv, prevA[1] * inv, prevC);
      const i1 = mb.vert(a[0], yAt(a[0], a[1]), a[1], 0, 1, 0, a[0] * inv, a[1] * inv, c);
      const i2 = mb.vert(b[0], yAt(b[0], b[1]), b[1], 0, 1, 0, b[0] * inv, b[1] * inv, c);
      const i3 = mb.vert(prevB[0], yAt(prevB[0], prevB[1]), prevB[1], 0, 1, 0, prevB[0] * inv, prevB[1] * inv, prevC);
      mb.tri(i0, i1, i2);
      mb.tri(i0, i2, i3);
    }
    prevA = a; prevB = b; prevC = c;
  }
}

function surfaceMaterial(ctx: Ctx, family: 'asphalt' | 'concrete', roughness: number, bag: THREE.Material[]): THREE.MeshStandardMaterial {
  const set = ctx.materials.textures(family);
  const mat = new THREE.MeshStandardMaterial({
    name: `airport:${family}`,
    color: 0xffffff,
    vertexColors: true,
    map: set?.map ?? null,
    normalMap: set?.normalMap ?? null,
    roughnessMap: set?.roughnessMap ?? null,
    aoMap: set?.aoMap ?? null,
    roughness,
    metalness: 0,
    envMapIntensity: 0.6,
    // Ear-clipping in the XZ plane and then treating it as a Y-up surface
    // flips the handedness (see `Parks.ts`), so this comes out back-facing
    // half the time under `FrontSide` culling.
    side: THREE.DoubleSide,
  });
  if (mat.normalMap) mat.normalScale.set(0.8, 0.8);
  if (ctx.envMap) mat.envMap = ctx.envMap;
  // A 3000 m runway at a 3.4 m tile repeats the map ~880 times down its
  // length; the hex-cell stochastic sampler is what keeps that from reading
  // as a lattice from altitude, exactly the problem Parks.ts solved for lawns.
  applyAntiTiling(mat, { hexScale: 0.22, hexContrast: 3, macroMeters: 70, macroStrength: 0.15 });
  bag.push(mat);
  return mat;
}

function finishMesh(geo: THREE.BufferGeometry, mat: THREE.Material, name: string): THREE.Mesh {
  const mesh = new THREE.Mesh(geo, mat);
  mesh.name = name;
  // A large flat DoubleSide ground polygon that casts shadows fails the depth
  // comparison against its own front faces and renders black — this is
  // exactly what happened to Boston Common. `castShadow = false` alone does
  // not stick: the sky module's per-frame sweep turns casting back on for
  // anything without `userData.noShadow`.
  mesh.castShadow = false;
  mesh.receiveShadow = true;
  mesh.userData.noShadow = true;
  mesh.matrixAutoUpdate = false;
  return mesh;
}

function hash01(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return ((h >>> 8) & 0xffffff) / 0xffffff;
}
