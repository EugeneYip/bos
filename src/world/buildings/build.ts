/**
 * Turns `BuildingRecord`s into packed, tile-bucketed geometry.
 *
 * This module is deliberately free of three.js and of the DOM so it can run
 * unchanged on the main thread *or* inside a Web Worker — the worker path is
 * what keeps the page interactive while 63,180 footprints are extruded.
 *
 * Ordering matters for the LOD scheme: everything that contributes to the
 * silhouette (walls, roof planes, parapets) is emitted into the `core` index
 * section, and everything decorative (cornices, eave trims, dormers) into
 * `trim`. A single geometry then serves three LODs by moving `drawRange`.
 */
import type { BuildingRecord } from '../../core/types';
import {
  BAYS, CROWN_FRAC, FAMILY_INDEX, LAYER, LAYER_TILE_M, REF_BAY, REF_FLOOR, REF_GROUND,
} from './atlas';
import { ClutterSink, chimneys, dormers, scatterRoof } from './clutter';
import { KIND_FACADE, MeshSink, ORIENT_WALL, type PackedChunk } from './mesh';
import {
  type Ring, computeObb, pointInRing, ringArea, ringBounds, ringCentroid, sanitizeRing,
} from './poly';
import { type RoofJob, buildRoof, cornice } from './roofs';
import { clamp, hashString, rand } from './rng';
import { SpillSink, emitSpill } from './spill';

/** Edge length of one spatial tile, metres. */
export const TILE = 500;

export const tileKey = (x: number, z: number): number =>
  ((Math.floor(x / TILE) + 512) << 10) | (Math.floor(z / TILE) + 512);

export const tileOrigin = (key: number): [number, number] => [
  ((key >> 10) - 512) * TILE,
  ((key & 1023) - 512) * TILE,
];

export interface TilePayload {
  key: number;
  chunk: PackedChunk;
}

export interface ShardResult {
  tiles: TilePayload[];
  /** Per-kind instanced clutter, `CLUTTER_STRIDE` floats each. */
  clutter: Float32Array[];
  /** Ground-floor light pools, `SPILL_STRIDE` floats each. */
  spill: Float32Array;
  built: number;
  skipped: number;
}

// ---------------------------------------------------------------------------
// facade subdivision
// ---------------------------------------------------------------------------

export interface FloorPlan {
  floorH: number;
  groundH: number;
  levels: number;
}

/**
 * Split a wall of height `H` into a taller ground floor, N upper floors and a
 * crown band, exactly filling `H` so floor lines never land mid-window.
 *
 * `levels` from OSM is frequently missing or wrong (a 40 m building tagged
 * `building:levels=2`), so it is sanity-checked against the height and
 * overruled when the two clearly disagree.
 */
export function floorPlan(H: number, levels: number, family: number): FloorPlan {
  const fh0 = REF_FLOOR[family];
  const gh0 = REF_GROUND[family];
  const gr = gh0 / fh0;

  let L = Math.max(1, Math.round(levels || 0));
  const est = Math.max(1, Math.round((H - gh0) / fh0) + 1);
  if (!Number.isFinite(L) || L < est * 0.45 || L > est * 2.4) L = est;

  const solve = (n: number): number => H / (gr + (n - 1) + CROWN_FRAC);
  let floorH = solve(L);
  if (floorH < 2.15 || floorH > 6.2) {
    floorH = clamp(floorH, 2.15, 6.2);
    L = Math.max(1, Math.round((H - floorH * (gr + CROWN_FRAC)) / floorH) + 1);
    floorH = solve(L);
  }
  floorH = clamp(floorH, 1.9, 7.5);

  let groundH = H - (L - 1) * floorH - floorH * CROWN_FRAC;
  if (groundH < 1.6 && L > 1) {
    L -= 1;
    groundH = H - (L - 1) * floorH - floorH * CROWN_FRAC;
  }
  if (!(groundH > 0.4)) groundH = Math.max(H * 0.5, 0.4);
  return { floorH, groundH, levels: L };
}

// ---------------------------------------------------------------------------
// material / layer selection
// ---------------------------------------------------------------------------

/**
 * Flat-roof membrane colour.
 *
 * Boston's flat roofs used to be uniformly black — built-up tar, or tar with
 * grey gravel ballast over it. Energy codes changed that: a large and growing
 * share is now white or light-grey TPO/PVC single-ply, and from the air that
 * is one of the most obvious things about the city. Drawing every flat roof
 * dark made the whole place read as a slab of asphalt from above.
 *
 * Returns a tint to multiply the roof atlas by, or null to leave it alone.
 */
function membraneTint(area: number, r: number): [number, number, number] | null {
  // Big-footprint commercial and institutional buildings re-roof soonest, so
  // they carry most of the white membrane; a triple-decker almost never does.
  const chance = area > 2600 ? 0.42 : area > 700 ? 0.24 : 0.07;
  if (r > chance) return null;
  const t = (r / chance);
  if (t < 0.55) return [214, 214, 209];            // white TPO, a little dirty
  if (t < 0.82) return [176, 176, 172];            // weathered light grey
  return [150, 152, 150];                          // older, greyer single-ply
}

function roofLayerFor(shape: string, family: number, r: number): number {
  switch (shape) {
    case 'flat':
      return r < 0.5 ? LAYER.roofTar : LAYER.roofGravel;
    case 'mansard':
      return r < 0.82 ? LAYER.roofSlate : LAYER.roofShingle;
    case 'dome':
      return r < 0.6 ? LAYER.roofSeam : LAYER.roofTile;
    case 'skillion':
      return r < 0.55 ? LAYER.roofSeam : LAYER.roofShingle;
    default:
      // pitched: New England is asphalt shingle over timber, slate over masonry
      if (family === 5 || family === 3) return LAYER.roofSeam;
      if (family <= 2) return r < 0.55 ? LAYER.roofSlate : LAYER.roofShingle;
      return r < 0.82 ? LAYER.roofShingle : LAYER.roofSlate;
  }
}

const srgb8 = (hex: number): [number, number, number] => [
  (hex >> 16) & 255,
  (hex >> 8) & 255,
  hex & 255,
];

/** Lighten toward white — used for painted stone trim over a coloured wall. */
function lighten(c: [number, number, number], t: number): [number, number, number] {
  return [
    Math.round(c[0] + (255 - c[0]) * t),
    Math.round(c[1] + (255 - c[1]) * t),
    Math.round(c[2] + (255 - c[2]) * t),
  ];
}

// ---------------------------------------------------------------------------
// one building
// ---------------------------------------------------------------------------

interface Scratch {
  sink: MeshSink;
  clutter: ClutterSink;
  spill: SpillSink;
}

function buildOne(rec: BuildingRecord, s: Scratch): boolean {
  const ring = sanitizeRing(rec.outline, 2.5, true);
  if (!ring) return false;

  const area = Math.abs(ringArea(ring));
  const perim = ring.length >> 1;
  if (perim < 3 || !Number.isFinite(area)) return false;

  // Holes: keep only rings that actually sit inside the footprint.
  let holes: Ring[] | undefined;
  if (rec.holes && rec.holes.length) {
    const hs: Ring[] = [];
    for (const raw of rec.holes) {
      const h = sanitizeRing(raw, 1.0, false);
      if (!h) continue;
      const [hx, hz] = ringCentroid(h);
      if (!pointInRing(ring, hx, hz)) continue;
      if (Math.abs(ringArea(h)) > area * 0.93) continue;
      hs.push(h);
    }
    if (hs.length) holes = hs;
  }

  const seed = hashString(rec.id);
  const rnd = rand(seed);
  const family = FAMILY_INDEX[rec.material] ?? 0;
  const obb = computeObb(ring);

  const ground = Number.isFinite(rec.ground) ? rec.ground : 0;
  const minH = Math.max(0, rec.minHeight || 0);
  const height = clamp(Number.isFinite(rec.height) ? rec.height : 6, 2, 460);
  const base = ground + minH;
  const eaves = ground + Math.max(height, minH + 2);
  const H = eaves - base;

  const plan = floorPlan(H, rec.levels, family);
  const bayRef = REF_BAY[family] * clamp(plan.floorH / REF_FLOOR[family], 0.78, 1.4);

  // Bury the base so a metre of terrain disagreement can never show a gap.
  const skirt = minH > 0.05 ? 0 : clamp(0.8 + Math.sqrt(area) * 0.05, 0.8, 3.2);

  const wall = srgb8(rec.color >>> 0);
  const roofCol = srgb8((rec.roofColor >>> 0) || rec.color >>> 0);
  // A little per-building brightness drift keeps a terrace of identical OSM
  // colours from reading as one flat mass.
  const drift = 1 + rnd.bell() * 0.085;
  const wallTint: [number, number, number] = [
    clamp(wall[0] * drift, 0, 255),
    clamp(wall[1] * drift, 0, 255),
    clamp(wall[2] * drift, 0, 255),
  ];
  const weather = Math.round(clamp(rnd.range(0.15, 0.95) * 255, 0, 255));

  const { sink } = s;
  sink.section(0);
  sink.begin(wallTint[0], wallTint[1], wallTint[2], weather, seed & 0xffff);

  // ---- walls ------------------------------------------------------------
  const fieldLayer = LAYER.field[family];
  sink.surface(fieldLayer, KIND_FACADE, ORIENT_WALL);
  emitWalls(sink, ring, base - skirt, eaves, -skirt, H, plan, bayRef, seed, false);
  if (holes) {
    for (const h of holes) emitWalls(sink, h, base - skirt, eaves, -skirt, H, plan, bayRef, seed, false);
  }

  // ---- roof -------------------------------------------------------------
  const rh = clamp(rec.roofHeight || 0, 0, 40);
  const shape = rec.roof || 'flat';
  const rLayer = roofLayerFor(shape, family, rnd());
  const job: RoofJob = {
    sink,
    ring,
    holes,
    obb,
    eaves,
    base,
    rh: shape === 'flat' ? 0 : Math.max(rh, 0.8),
    layer: rLayer,
    tileM: LAYER_TILE_M[rLayer] ?? 4,
    wallLayer: fieldLayer,
    facade: [plan.floorH, plan.groundH, H, bayRef],
    rnd,
    area,
  };
  // Flat roofs may be light single-ply rather than tar or gravel; the atlas
  // layer supplies the surface texture either way and the tint carries the
  // colour, so no extra layer is needed.
  const membrane = shape === 'flat' ? membraneTint(area, rnd()) : null;
  const rc = membrane ?? roofCol;
  sink.begin(rc[0], rc[1], rc[2], membrane ? weather * 0.55 : weather, seed & 0xffff);
  const res = buildRoof(shape, job);

  // ---- trim -------------------------------------------------------------
  const masonry = family <= 2 || family === 7 || family === 6;
  if (shape === 'flat' && masonry && H > 5.5 && H < 75) {
    const trimCol = lighten(wallTint, family === 6 ? 0.62 : 0.42);
    sink.begin(trimCol[0], trimCol[1], trimCol[2], weather, seed & 0xffff);
    cornice(job, eaves - 0.18, LAYER.clutterPaint, 2);
  }
  if (shape === 'mansard' && res.slopeRing) {
    const trimCol = lighten(wallTint, 0.5);
    sink.begin(trimCol[0], trimCol[1], trimCol[2], weather, seed & 0xffff);
    sink.surface(fieldLayer, KIND_FACADE, ORIENT_WALL);
    dormers(sink, res.slopeRing, res.slopeY, res.slopeTopY, fieldLayer, rnd, area);
  }

  // ---- rooftop plant ----------------------------------------------------
  if (res.deck) {
    scatterRoof({
      clutter: s.clutter,
      deck: res.deck,
      deckY: res.deckY,
      area: Math.abs(ringArea(res.deck)),
      height: eaves - ground,
      rotY: obb.angle,
      rnd,
      family,
    });
  } else if (res.slopeRing && (family === 6 || family <= 1 || family === 7) && H < 26) {
    chimneys(s.clutter, ring, res.slopeTopY, eaves, rnd, family, area);
  }

  // ---- light out of the ground floor ------------------------------------
  emitSpill(s.spill, ring, ground, family, area, seed);

  sink.section(0);
  return true;
}

/** Vertical walls with an integer number of window bays per edge. */
function emitWalls(
  sink: MeshSink, ring: Ring, yBot: number, yTop: number, vBot: number, vTop: number,
  plan: FloorPlan, bayRef: number, seed: number, flip: boolean,
): void {
  const n = ring.length >> 1;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const x0 = ring[i * 2];
    const z0 = ring[i * 2 + 1];
    const x1 = ring[j * 2];
    const z1 = ring[j * 2 + 1];
    const len = Math.hypot(x1 - x0, z1 - z0);
    if (len < 0.12) continue;
    // Snap to a whole number of bays so no wall ever ends on half a window.
    const bays = Math.max(1, Math.round(len / bayRef));
    const bayW = len / bays;
    sink.params(plan.floorH, plan.groundH, vTop, bayW);
    // Stagger which bay a wall starts on so neighbours don't rhyme.
    const u0 = bayW * ((seed + i * 7) % BAYS);
    sink.wallQuad(x0, z0, x1, z1, yBot, yTop, u0, vBot, vTop, flip);
  }
}

// ---------------------------------------------------------------------------
// shard -> tiles
// ---------------------------------------------------------------------------

export interface BuildOptions {
  /** Slugs whose footprints are replaced by hand-authored landmark meshes. */
  skipLandmarks?: string[];
}

/**
 * Extrude a whole shard, bucketed by tile. Buildings are grouped by tile first
 * so each tile's vertices land contiguously in one sink and need no
 * re-indexing afterwards.
 */
export function buildShard(records: BuildingRecord[], opts: BuildOptions = {}): ShardResult {
  const skip = new Set(opts.skipLandmarks ?? []);
  const buckets = new Map<number, BuildingRecord[]>();
  let skipped = 0;

  for (const rec of records) {
    if (!rec || !rec.outline || rec.outline.length < 6) {
      skipped++;
      continue;
    }
    if (rec.landmark && skip.has(rec.landmark)) {
      skipped++;
      continue;
    }
    const b = ringBounds(rec.outline);
    const cx = (b.minX + b.maxX) * 0.5;
    const cz = (b.minZ + b.maxZ) * 0.5;
    if (!Number.isFinite(cx) || !Number.isFinite(cz)) {
      skipped++;
      continue;
    }
    const key = tileKey(cx, cz);
    const arr = buckets.get(key);
    if (arr) arr.push(rec);
    else buckets.set(key, [rec]);
  }

  const clutter = new ClutterSink();
  const spill = new SpillSink();
  const tiles: TilePayload[] = [];
  let built = 0;

  for (const [key, recs] of buckets) {
    const sink = new MeshSink(Math.max(1024, recs.length * 48));
    const scratch: Scratch = { sink, clutter, spill };
    for (const rec of recs) {
      try {
        if (buildOne(rec, scratch)) built++;
        else skipped++;
      } catch {
        // A single pathological footprint must never abort the city.
        skipped++;
      }
    }
    if (!sink.empty) tiles.push({ key, chunk: sink.pack() });
  }

  return { tiles, clutter: clutter.pack(), spill: spill.pack(), built, skipped };
}

/** Every transferable buffer in a result, for `postMessage`. */
export function shardTransferables(r: ShardResult): ArrayBufferLike[] {
  const out: ArrayBufferLike[] = [];
  for (const t of r.tiles) {
    const c = t.chunk;
    out.push(
      c.position.buffer, c.normal.buffer, c.uv.buffer, c.tint.buffer,
      c.surf.buffer, c.par.buffer, c.core.buffer, c.trim.buffer,
    );
  }
  for (const c of r.clutter) out.push(c.buffer);
  out.push(r.spill.buffer);
  return out;
}
