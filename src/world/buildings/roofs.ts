/**
 * Roof geometry for all seven `RoofShape`s.
 *
 * Boston's stock is overwhelmingly pitched — 19.5k hipped, 18.8k gabled, 3.2k
 * mansard — so ridges have to be *right*, not approximated by a wedge. Every
 * pitched shape works the same way:
 *
 *   1. Fit an oriented bounding box to the footprint (`computeObb`).
 *   2. Split the footprint along the roof's crease lines with half-plane clips,
 *      so each piece lies in a single plane.
 *   3. Lift each piece with the shape's height field and triangulate it.
 *
 * Because the height field is continuous across every crease, adjacent faces
 * share exact edge positions and the roof is watertight even when the footprint
 * is an irregular L, U or sawtooth. A vertical "gable band" then closes the gap
 * between the wall top and the lifted roof edge, which is what turns a tent
 * into a real gabled roof with end walls.
 *
 * Everything degrades: a clip that returns nothing, an inset that folds, a
 * triangulation that fails — each falls back to a flat deck rather than
 * throwing, because one bad footprint must never abort the city load.
 */
import {
  type Obb, type Ring, clipHalfPlane, insetRingSafe, interiorPoint, ringArea, triangulateRing,
} from './poly';
import { KIND_FACADE, KIND_TILED, ORIENT_ROOF, ORIENT_WALL, type MeshSink } from './mesh';
import { type Rand, clamp } from './rng';

export interface RoofJob {
  sink: MeshSink;
  /** Sanitised outer ring, canonical (positive-area) winding. */
  ring: Ring;
  holes: Ring[] | undefined;
  obb: Obb;
  /** World Y of the wall top — where the roof springs from. */
  eaves: number;
  /** World Y of the wall base, for facade UVs on gable ends. */
  base: number;
  /** Roof volume height above the eaves. */
  rh: number;
  /** Atlas layer for the roof cladding. */
  layer: number;
  /** Metres covered by one tile of that layer. */
  tileM: number;
  /** Atlas layer of the wall family, for gable end walls. */
  wallLayer: number;
  /** Facade params (floorH, groundH, wallTop, bayW) for gable end walls. */
  facade: [number, number, number, number];
  rnd: Rand;
  area: number;
}

/** Where the flat-roof deck ended up, so clutter knows what it can stand on. */
export interface RoofResult {
  /** Ring bounding a usable horizontal deck, or null when the roof is pitched. */
  deck: Ring | null;
  deckY: number;
  /** True when the roof produced a slope that dormers can sit on. */
  slopeRing: Ring | null;
  slopeY: number;
  slopeTopY: number;
}

const NO_DECK: RoofResult = { deck: null, deckY: 0, slopeRing: null, slopeY: 0, slopeTopY: 0 };

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

/** Miter offset outward (d > 0) or inward (d < 0). Returns null if it folds. */
export function offsetRing(r: Ring, d: number): Ring | null {
  const n = r.length >> 1;
  if (n < 3 || Math.abs(d) < 1e-4) return null;
  const out: Ring = new Array(n * 2);
  for (let i = 0; i < n; i++) {
    const pi = (i - 1 + n) % n;
    const ni = (i + 1) % n;
    const cx = r[i * 2];
    const cz = r[i * 2 + 1];
    let e1x = cx - r[pi * 2];
    let e1z = cz - r[pi * 2 + 1];
    let e2x = r[ni * 2] - cx;
    let e2z = r[ni * 2 + 1] - cz;
    const l1 = Math.hypot(e1x, e1z);
    const l2 = Math.hypot(e2x, e2z);
    if (l1 < 1e-6 || l2 < 1e-6) return null;
    e1x /= l1;
    e1z /= l1;
    e2x /= l2;
    e2z /= l2;
    // outward normal of edge (dx,dz) is (dz,-dx)
    const n1x = e1z;
    const n1z = -e1x;
    const n2x = e2z;
    const n2z = -e2x;
    let bx = n1x + n2x;
    let bz = n1z + n2z;
    const bl = Math.hypot(bx, bz);
    if (bl < 1e-4) {
      bx = n1x;
      bz = n1z;
    } else {
      bx /= bl;
      bz /= bl;
    }
    const cosHalf = bx * n1x + bz * n1z;
    const scale = Math.min(1 / Math.max(cosHalf, 0.25), 4);
    out[i * 2] = cx + bx * d * scale;
    out[i * 2 + 1] = cz + bz * d * scale;
  }
  const a0 = ringArea(r);
  const a1 = ringArea(out);
  if (!Number.isFinite(a1) || Math.sign(a1) !== Math.sign(a0)) return null;
  if (d > 0 && Math.abs(a1) <= Math.abs(a0)) return null;
  return out;
}

/** OBB-local coordinates of a world point. */
function uvOf(o: Obb, x: number, z: number): [number, number] {
  const dx = x - o.cx;
  const dz = z - o.cz;
  return [dx * o.ux + dz * o.uz, -dx * o.uz + dz * o.ux];
}

/** Turn `a*u + b*v <= c` (OBB space) into a world-space half-plane. */
function obbHalfPlane(o: Obb, a: number, b: number, c: number): [number, number, number] {
  const nx = a * o.ux - b * o.uz;
  const nz = a * o.uz + b * o.ux;
  return [nx, nz, c + nx * o.cx + nz * o.cz];
}

function clipAll(ring: Ring, planes: Array<[number, number, number]>): Ring | null {
  let r = ring;
  for (const [nx, nz, c] of planes) {
    r = clipHalfPlane(r, nx, nz, c);
    if (r.length < 6) return null;
  }
  return Math.abs(ringArea(r)) < 0.15 ? null : r;
}

type HeightFn = (x: number, z: number) => number;

/**
 * Triangulate a planar roof piece and emit it with a single Newell normal.
 * Holes are only passed for the (single-piece) flat and skillion cases.
 */
function emitPiece(
  sink: MeshSink, poly: Ring, holes: Ring[] | undefined, y0: number, h: HeightFn,
): boolean {
  const tri = triangulateRing(poly, holes, true);
  if (!tri) return false;

  const nv = tri.verts.length >> 1;
  const ys = new Float64Array(nv);
  for (let i = 0; i < nv; i++) ys[i] = y0 + h(tri.verts[i * 2], tri.verts[i * 2 + 1]);

  // Newell normal over the outer boundary of the lifted piece.
  let nx = 0;
  let ny = 0;
  let nz = 0;
  const on = tri.outerCount;
  for (let i = 0, j = on - 1; i < on; j = i++) {
    const ax = tri.verts[j * 2];
    const ay = ys[j];
    const az = tri.verts[j * 2 + 1];
    const bx = tri.verts[i * 2];
    const by = ys[i];
    const bz = tri.verts[i * 2 + 1];
    nx += (ay - by) * (az + bz);
    ny += (az - bz) * (ax + bx);
    nz += (ax - bx) * (ay + by);
  }
  const l = Math.hypot(nx, ny, nz);
  if (l < 1e-9) return false;
  nx /= l;
  ny /= l;
  nz /= l;
  if (ny < 0) {
    nx = -nx;
    ny = -ny;
    nz = -nz;
  }

  const map = new Int32Array(nv).fill(-1);
  for (let t = 0; t < tri.indices.length; t += 3) {
    for (let k = 0; k < 3; k++) {
      const vi = tri.indices[t + k];
      if (map[vi] < 0) {
        const x = tri.verts[vi * 2];
        const z = tri.verts[vi * 2 + 1];
        map[vi] = sink.vertex(x, ys[vi], z, nx, ny, nz, x, -z);
      }
    }
    sink.tri(map[tri.indices[t]], map[tri.indices[t + 1]], map[tri.indices[t + 2]]);
  }
  return true;
}

/**
 * Vertical band from the wall top up to the lifted roof edge — the gable ends.
 * Uses the facade surface so end walls are clad like the rest of the building,
 * complete with windows and night lighting.
 */
function gableBand(job: RoofJob, ring: Ring, h: HeightFn): void {
  const { sink, eaves, base } = job;
  const n = ring.length >> 1;
  sink.surface(job.wallLayer, KIND_FACADE, ORIENT_WALL);
  sink.params(job.facade[0], job.facade[1], job.facade[2], job.facade[3]);
  const vBase = eaves - base;

  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const ax = ring[i * 2];
    const az = ring[i * 2 + 1];
    const bx = ring[j * 2];
    const bz = ring[j * 2 + 1];
    const ha = h(ax, az);
    const hb = h(bx, bz);
    if (ha < 0.06 && hb < 0.06) continue;
    const dx = bx - ax;
    const dz = bz - az;
    const len = Math.hypot(dx, dz);
    if (len < 1e-3) continue;
    const nx = dz / len;
    const nz = -dx / len;

    const va = sink.vertex(ax, eaves, az, nx, 0, nz, 0, vBase);
    const vb = sink.vertex(bx, eaves, bz, nx, 0, nz, len, vBase);
    const vc = sink.vertex(bx, eaves + hb, bz, nx, 0, nz, len, vBase + hb);
    const vd = sink.vertex(ax, eaves + ha, az, nx, 0, nz, 0, vBase + ha);
    // reversed winding: ring order is clockwise seen from above
    if (hb > 0.06) sink.tri(va, vc, vb);
    if (ha > 0.06) sink.tri(va, vd, vc);
  }
}

/** Projecting eave / drip band: a thin sloped skirt just outside the wall top. */
function eaveTrim(job: RoofJob, y: number, out: number, drop: number): void {
  if (job.area < 45 || job.area > 9000) return;
  const over = offsetRing(job.ring, out);
  if (!over) return;
  job.sink.section(1);
  job.sink.surface(job.layer, KIND_TILED, ORIENT_ROOF);
  job.sink.params(0, 0, 0, job.tileM);
  job.sink.band(over, y - drop, job.ring, y, 0.15, true);
  job.sink.section(0);
}

// ---------------------------------------------------------------------------
// shapes
// ---------------------------------------------------------------------------

function buildFlat(job: RoofJob): RoofResult {
  const { sink, ring, obb, eaves, rnd } = job;
  const minSpan = obb.ev * 2;
  // Parapet height: taller on big commercial decks, absent on tiny sheds.
  const pH = clamp(job.area > 260 ? rnd.range(0.55, 1.15) : rnd.range(0.25, 0.6), 0.2, 1.2);
  const inset = clamp(minSpan * 0.08, 0.18, 0.42);
  const fit = minSpan > 2.6 ? insetRingSafe(ring, inset) : null;

  sink.surface(job.layer, KIND_TILED, ORIENT_ROOF);
  sink.params(0, 0, 0, job.tileM);

  if (!fit) {
    emitPiece(sink, ring, job.holes, eaves, () => 0);
    return { deck: null, deckY: eaves, slopeRing: null, slopeY: 0, slopeTopY: 0 };
  }

  const deckY = eaves - pH;
  // One band does the coping and the inner parapet face at once: it runs from
  // the outer wall top inward and down to the deck.
  sink.band(ring, eaves, fit.ring, deckY, 0.0, true);
  const ok = emitPiece(sink, fit.ring, job.holes, deckY, () => 0);
  if (!ok) emitPiece(sink, ring, job.holes, eaves, () => 0);
  return { deck: fit.ring, deckY, slopeRing: null, slopeY: 0, slopeTopY: 0 };
}

function buildGabled(job: RoofJob): RoofResult {
  const { sink, ring, obb, eaves, rh } = job;
  const ev = Math.max(obb.ev, 0.35);
  const h: HeightFn = (x, z) => {
    const v = uvOf(obb, x, z)[1];
    return rh * (1 - Math.min(1, Math.abs(v) / ev));
  };

  const front = clipAll(ring, [obbHalfPlane(obb, 0, 1, 0)]);
  const back = clipAll(ring, [obbHalfPlane(obb, 0, -1, 0)]);
  if (!front && !back) return buildFlat(job);

  sink.surface(job.layer, KIND_TILED, ORIENT_ROOF);
  sink.params(0, 0, 0, job.tileM);
  if (front) emitPiece(sink, front, undefined, eaves, h);
  if (back) emitPiece(sink, back, undefined, eaves, h);

  gableBand(job, ring, h);
  eaveTrim(job, eaves, 0.3, 0.24);
  return { deck: null, deckY: eaves, slopeRing: ring, slopeY: eaves, slopeTopY: eaves + rh };
}

function buildHipped(job: RoofJob): RoofResult {
  const { sink, ring, obb, eaves, rh } = job;
  const ev = Math.max(obb.ev, 0.35);
  const k = Math.max(0, obb.eu - obb.ev);
  const h: HeightFn = (x, z) => {
    const [u, v] = uvOf(obb, x, z);
    const a = Math.abs(v) / ev;
    const b = Math.max(0, Math.abs(u) - k) / ev;
    return rh * (1 - Math.min(1, Math.max(a, b)));
  };

  const pieces = [
    clipAll(ring, [obbHalfPlane(obb, 1, 1, k), obbHalfPlane(obb, -1, 1, k), obbHalfPlane(obb, 0, 1, 0)]),
    clipAll(ring, [obbHalfPlane(obb, 1, -1, k), obbHalfPlane(obb, -1, -1, k), obbHalfPlane(obb, 0, -1, 0)]),
    clipAll(ring, [obbHalfPlane(obb, 1, -1, -k), obbHalfPlane(obb, 1, 1, -k)]),
    clipAll(ring, [obbHalfPlane(obb, -1, 1, -k), obbHalfPlane(obb, -1, -1, -k)]),
  ];
  if (!pieces.some(Boolean)) return buildFlat(job);

  sink.surface(job.layer, KIND_TILED, ORIENT_ROOF);
  sink.params(0, 0, 0, job.tileM);
  let any = false;
  for (const p of pieces) if (p) any = emitPiece(sink, p, undefined, eaves, h) || any;
  if (!any) return buildFlat(job);

  // Hips leave no gable ends, but irregular footprints can still lift a ring
  // vertex above the eaves; close those.
  gableBand(job, ring, h);
  eaveTrim(job, eaves, 0.32, 0.26);
  return { deck: null, deckY: eaves, slopeRing: ring, slopeY: eaves, slopeTopY: eaves + rh };
}

function buildPyramidal(job: RoofJob): RoofResult {
  const { sink, ring, eaves, rh } = job;
  const [ax, az] = interiorPoint(ring);
  const n = ring.length >> 1;

  sink.surface(job.layer, KIND_TILED, ORIENT_ROOF);
  sink.params(0, 0, 0, job.tileM);
  const apexY = eaves + rh;

  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const px = ring[i * 2];
    const pz = ring[i * 2 + 1];
    const qx = ring[j * 2];
    const qz = ring[j * 2 + 1];
    // face normal of triangle (p@eaves, q@eaves, apex)
    const e1x = qx - px;
    const e1z = qz - pz;
    const e2x = ax - px;
    const e2y = rh;
    const e2z = az - pz;
    let nx = -e1z * e2y;
    let ny = e1z * e2x - e1x * e2z;
    let nz = e1x * e2y;
    const l = Math.hypot(nx, ny, nz);
    if (l < 1e-9) continue;
    nx /= l;
    ny /= l;
    nz /= l;
    if (ny < 0) {
      nx = -nx;
      ny = -ny;
      nz = -nz;
    }
    const a = sink.vertex(px, eaves, pz, nx, ny, nz, px, -pz);
    const b = sink.vertex(qx, eaves, qz, nx, ny, nz, qx, -qz);
    const c = sink.vertex(ax, apexY, az, nx, ny, nz, ax, -az);
    // ring is canonically wound, so (p,q,apex) seen from above is clockwise
    sink.tri(a, c, b);
  }
  eaveTrim(job, eaves, 0.3, 0.24);
  return { deck: null, deckY: eaves, slopeRing: ring, slopeY: eaves, slopeTopY: apexY };
}

function buildSkillion(job: RoofJob): RoofResult {
  const { sink, ring, obb, eaves, rh } = job;
  const ev = Math.max(obb.ev, 0.35);
  const h: HeightFn = (x, z) => {
    const v = uvOf(obb, x, z)[1];
    return rh * clamp((v + ev) / (2 * ev), 0, 1);
  };
  sink.surface(job.layer, KIND_TILED, ORIENT_ROOF);
  sink.params(0, 0, 0, job.tileM);
  if (!emitPiece(sink, ring, job.holes, eaves, h)) return buildFlat(job);
  gableBand(job, ring, h);
  eaveTrim(job, eaves, 0.28, 0.22);
  return { deck: null, deckY: eaves, slopeRing: ring, slopeY: eaves, slopeTopY: eaves + rh };
}

function buildMansard(job: RoofJob): RoofResult {
  const { sink, ring, obb, eaves, rh } = job;
  const minSpan = obb.ev * 2;
  const inset = clamp(Math.min(rh * 0.62, minSpan * 0.26), 0.3, 3.2);
  const fit = minSpan > 3 ? insetRingSafe(ring, inset) : null;
  if (!fit) return buildFlat(job);

  const topY = eaves + rh;
  sink.surface(job.layer, KIND_TILED, ORIENT_ROOF);
  sink.params(0, 0, 0, job.tileM);
  // Steep lower slope — the defining feature. Nearly vertical, slightly raked.
  sink.band(ring, eaves, fit.ring, topY, 0, true);
  // Flat deck behind the mansard.
  const deckInset = insetRingSafe(fit.ring, 0.22);
  const deck = deckInset?.ring ?? fit.ring;
  emitPiece(sink, deck, undefined, topY, () => 0);

  eaveTrim(job, eaves, 0.34, 0.3);
  return {
    deck,
    deckY: topY,
    slopeRing: ring,
    slopeY: eaves,
    slopeTopY: topY,
  };
}

function buildDome(job: RoofJob): RoofResult {
  const { sink, ring, obb, eaves, rh } = job;
  // Flat collar first so the footprint corners outside the dome are covered.
  sink.surface(job.layer, KIND_TILED, ORIENT_ROOF);
  sink.params(0, 0, 0, job.tileM);
  emitPiece(sink, ring, job.holes, eaves, () => 0);

  const rings = 10;
  const segs = Math.max(12, Math.min(28, Math.round(Math.max(obb.eu, obb.ev) * 1.6)));
  const [cx, cz] = [obb.cx, obb.cz];
  const ra = obb.eu * 0.94;
  const rb = obb.ev * 0.94;
  const prev: number[] = new Array(segs);
  const cur: number[] = new Array(segs);

  for (let r = 0; r <= rings; r++) {
    const phi = (r / rings) * (Math.PI / 2);
    const cp = Math.cos(phi);
    const sp = Math.sin(phi);
    for (let s = 0; s < segs; s++) {
      const th = (s / segs) * Math.PI * 2;
      const ct = Math.cos(th);
      const st = Math.sin(th);
      const x = cx + ra * cp * ct;
      const z = cz + rb * cp * st;
      const y = eaves + rh * sp;
      // ellipsoid normal
      let nx = (cp * ct) / Math.max(ra, 1e-3);
      let ny = sp / Math.max(rh, 1e-3);
      let nz = (cp * st) / Math.max(rb, 1e-3);
      const l = Math.hypot(nx, ny, nz) || 1;
      nx /= l;
      ny /= l;
      nz /= l;
      cur[s] = sink.vertex(x, y, z, nx, ny, nz, th * ra, -phi * rh);
    }
    if (r > 0) {
      for (let s = 0; s < segs; s++) {
        const t = (s + 1) % segs;
        sink.quadIdx(prev[s], cur[s], cur[t], prev[t]);
      }
    }
    for (let s = 0; s < segs; s++) prev[s] = cur[s];
  }
  return { deck: null, deckY: eaves, slopeRing: null, slopeY: 0, slopeTopY: eaves + rh };
}

/** Dispatch. Always emits *something*; never throws. */
export function buildRoof(shape: string, job: RoofJob): RoofResult {
  try {
    switch (shape) {
      case 'gabled':
        return buildGabled(job);
      case 'hipped':
        return buildHipped(job);
      case 'pyramidal':
        return buildPyramidal(job);
      case 'skillion':
        return buildSkillion(job);
      case 'mansard':
        return buildMansard(job);
      case 'dome':
        return buildDome(job);
      default:
        return buildFlat(job);
    }
  } catch {
    try {
      return buildFlat(job);
    } catch {
      return NO_DECK;
    }
  }
}

/**
 * Projecting masonry cornice at the top of a flat-roofed wall — the single
 * detail that makes Back Bay read as rowhouses rather than extruded boxes.
 */
export function cornice(job: RoofJob, y: number, layer: number, tileM: number): void {
  if (job.area < 55 || job.area > 12000) return;
  const over = offsetRing(job.ring, 0.34);
  if (!over) return;
  const { sink } = job;
  sink.section(1);
  sink.surface(layer, KIND_TILED, ORIENT_ROOF);
  sink.params(0, 0, 0, tileM);
  // sloping top face of the cornice...
  sink.band(over, y - 0.06, job.ring, y, 0.1, true);
  // ...and the fascia hanging below it
  sink.vertBand(over, y - 0.5, y - 0.06);
  sink.section(0);
}
