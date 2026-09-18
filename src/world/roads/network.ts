/**
 * Road-network topology.
 *
 * Turns a flat list of `RoadRecord`s into a graph: ways are split where they
 * cross, chains of identical ways are welded back together so mid-block joints
 * stay mitred, and every node where three or more road ends meet becomes a
 * junction with a real boundary polygon. Each approach records how far its
 * ribbon must be trimmed back, which is what stops junctions from being a pile
 * of overlapping asphalt.
 */
import type { RoadClass, RoadRecord } from '../../core/types';
import {
  type V2, add, dist, norm, perp, polylineLength,
  rayIntersect, scale, sub, hashStr,
} from './math2';
import { SEA_LEVEL } from '../../core/config';
import {
  CLASS, type ClassSpec, type SurfaceKey, TUNE, crownDy, lanesOf, surfaceOf, widthOf,
} from './spec';

/** Minimum deck height above the water surface, metres. */
const BRIDGE_CLEARANCE = 3.6;
/** Metres in from the bank over which the deck reaches full clearance. */
const BRIDGE_RAMP = 16;

export interface PreparedRoad {
  id: string;
  /**
   * The way's name, and only the name.
   *
   * This used to be the whole `RoadRecord`, which meant every one of the
   * city's 56,655 parsed records -- each with a `path` and an `elevation`
   * array -- stayed reachable for the life of the session, through 36,755
   * prepared roads. Exactly one consumer ever touched it, `paint.ts` asking
   * whether the name suggests a bus lane. Holding a hundred megabytes of
   * polyline to answer that is not a trade worth making on a phone, where
   * the whole page has to fit in what iOS will spare.
   */
  name?: string;
  cls: RoadClass;
  spec: ClassSpec;
  pts: V2[];
  ys: number[];
  width: number;
  halfWidth: number;
  lanes: number;
  oneway: boolean;
  bridge: boolean;
  tunnel: boolean;
  layer: number;
  surface: SurfaceKey;
  length: number;
  /** Metres removed from each end so the junction fill takes over. */
  trimStart: number;
  trimEnd: number;
  seed: number;
}

export interface Approach {
  road: PreparedRoad;
  /** 0 = the road starts here, 1 = it ends here. */
  end: 0 | 1;
  /** Unit direction pointing away from the node, into the road. */
  dir: V2;
  halfWidth: number;
  angle: number;
  trim: number;
  /** Elevation of the carriageway centre at the trim point. */
  y: number;
}

/**
 * A rounded kerb return: the corner of the junction between approach `i` and
 * approach `i+1`. `pts` runs from the right edge of `i` to the left edge of
 * `i+1` and is the *same* curve the junction fill boundary uses, so the kerb
 * and the asphalt it retains can never disagree.
 */
export interface Corner {
  pts: V2[];
  ys: number[];
  /** Outward normals, away from the junction centre. */
  normals: V2[];
  /** Both flanking roads carry kerbs, so this corner gets one too. */
  kerbed: boolean;
  /** Sidewalk width to carry round the corner, metres. */
  walk: number;
}

export interface Junction {
  p: V2;
  y: number;
  layer: number;
  approaches: Approach[];
  radius: number;
  surface: SurfaceKey;
  /** Widest approach — drives crosswalk length and stop-bar setback. */
  maxWidth: number;
  /** Corner radius cap, retained so `junctionGeom` can reproduce the ring. */
  maxR: number;
  seed: number;
  /** True when at least one approach carries painted markings. */
  painted: boolean;
}

/**
 * A junction's boundary ring and kerb returns — derived, never stored.
 *
 * This used to live on the `Junction`. Each one is a ~21-vertex ring of
 * `{x,z}` objects with two parallel elevation arrays, plus one `Corner` per
 * approach pair carrying its own `pts`, `ys` and `normals`: about sixty small
 * allocations per junction, 700,000 across the city's 11,630 of them, and
 * measured at ~55 MB of the boot high-water mark. On a 3.5-vertex-average
 * network the headers and backing stores of that many tiny arrays *are* the
 * payload.
 *
 * Only two functions ever read any of it — `emitJunctionFill` and
 * `emitKerbReturns` — and both run inside a per-tile build. At boot only six
 * of the city's ninety-three base tiles are built, so the 55 MB bought
 * geometry for eighty-seven tiles that nothing would ask for before the peak,
 * or in most sessions ever. `emitCrossings` never touched it at all.
 *
 * Everything here is a pure function of what the `Junction` still stores: the
 * angle-sorted approaches with their settled `trim` and `y`, and `maxR`. So a
 * derivation is reproducible, and the numbers are the same ones the eager
 * version wrote into the struct — which `qa/_roadnet.mjs --digest` checks by
 * hashing the derived ring rather than the stored one.
 */
export interface JunctionGeom {
  ring: V2[];
  ringDy: number[];
  ringY: number[];
  corners: Corner[];
}

export interface Network {
  roads: PreparedRoad[];
  junctions: Junction[];
  /** Tunnel portals: node position plus the direction the road descends. */
  portals: Array<{ p: V2; y: number; dir: V2; width: number; road: PreparedRoad }>;
}

/**
 * Node key: 0.5 m snapping, packed into one integer.
 *
 * This used to be a template string. The topology pass builds one for every
 * vertex of every road three separate times -- degree counting, chain
 * welding, endpoint indexing -- over 199,413 source vertices, and the maps
 * then *retain* 146,120 of them for the rest of the pass. Measured on the
 * shards: 19 MB for the `degree` map alone and ~55 MB across the three, none
 * of it collectable until well after the boot high-water mark has been set,
 * which is the figure iOS kills the tab on.
 *
 * The packing holds +/-131 km at 0.5 m and layers -16..15. Boston's road data
 * spans 13.6 km by 11.1 km with layers -4..3, so there is a factor of ten of
 * headroom on each axis. An out-of-range coordinate is clamped rather than
 * left to wrap, so a nonsense record collides with another nonsense record
 * instead of aliasing onto a real node.
 */
const GRID = 2; // 0.5 m snapping
const KEY_SPAN = 1 << 19;
const KEY_HALF = 1 << 18;
const clampAxis = (v: number): number => (v < -KEY_HALF ? -KEY_HALF : v > KEY_HALF - 1 ? KEY_HALF - 1 : v);
/** Packs already-snapped grid coordinates; `dx`/`dz` neighbour probes use this. */
const keyAt = (rx: number, rz: number, layer: number): number =>
  ((layer + 16) * KEY_SPAN + (clampAxis(rx) + KEY_HALF)) * KEY_SPAN + (clampAxis(rz) + KEY_HALF);
const key = (p: V2, layer: number): number =>
  keyAt(Math.round(p.x * GRID), Math.round(p.z * GRID), layer);

/* ------------------------------------------------- the prepare scratch */

/**
 * One set of reusable rows for the whole prepare pass.
 *
 * `decode -> dedupe -> simplify -> smoothProfile` used to hand each other
 * freshly allocated arrays: four generations of `{x,z}[]` and `number[]` per
 * record, plus a `Uint8Array` and an array-of-tuples stack inside the
 * Ramer-Douglas-Peucker, for all 56,655 records -- including the 21,250
 * sidewalk duplicates that get thrown away two steps later.
 *
 * The city's ways average **3.5 vertices**. At that length an array is almost
 * entirely header and backing store, ~48-64 bytes whatever it holds, and the
 * ones built with `push` abandon a backing store at every capacity doubling.
 * So the cost of the pass was never the coordinates; it was ten allocation
 * headers per record, half a million of them, measured at ~55 MB of the boot
 * high-water mark.
 *
 * Now every stage works in place on these rows and only the surviving
 * polyline is materialised, once, at its exact final length. `Float64Array`
 * and not `Float32Array`: these are the numbers the geometry builders consume
 * and they have to stay bit-identical.
 */
let sX = new Float64Array(0);
let sZ = new Float64Array(0);
let sY = new Float64Array(0);
/** Previous-pass elevations: `smoothProfile` is Jacobi, not Gauss-Seidel. */
let sY2 = new Float64Array(0);
let sKeep = new Uint8Array(0);
/** RDP interval stack, two ints per frame; depth cannot exceed the vertex count. */
let sStack = new Int32Array(0);

function reserve(n: number): void {
  if (sX.length >= n) return;
  const cap = 1 << (32 - Math.clz32(Math.max(n - 1, 15)));
  sX = new Float64Array(cap);
  sZ = new Float64Array(cap);
  sY = new Float64Array(cap);
  sY2 = new Float64Array(cap);
  sKeep = new Uint8Array(cap);
  sStack = new Int32Array(cap * 2 + 8);
}

/** Releases the scratch once the pass is done; it is the largest way in the city. */
function releaseScratch(): void {
  sX = sZ = sY = sY2 = new Float64Array(0);
  sKeep = new Uint8Array(0);
  sStack = new Int32Array(0);
}

/** Decodes a record's path into the scratch rows. Returns the vertex count, 0 to reject. */
function decodeInto(rec: RoadRecord): number {
  const path = rec.path;
  if (!Array.isArray(path) || path.length < 4) return 0;
  const n = path.length >> 1;
  reserve(n);
  const elev = Array.isArray(rec.elevation) ? rec.elevation : [];
  for (let i = 0; i < n; i++) {
    const x = path[i * 2];
    const z = path[i * 2 + 1];
    if (!Number.isFinite(x) || !Number.isFinite(z)) return 0;
    sX[i] = x;
    sZ[i] = z;
    const e = elev[i];
    sY[i] = Number.isFinite(e) ? (e as number) : Number.NaN;
  }
  return n;
}

/** {@link dedupe} in place: drops consecutive duplicates below `eps` metres. */
function dedupeInPlace(n: number, eps: number): number {
  let m = 0;
  for (let i = 0; i < n; i++) {
    // `m <= i` always, so the compacting write can never clobber an unread
    // source vertex.
    if (m === 0 || Math.hypot(sX[m - 1] - sX[i], sZ[m - 1] - sZ[i]) > eps) {
      sX[m] = sX[i];
      sZ[m] = sZ[i];
      sY[m] = sY[i];
      m++;
    }
  }
  if (m === 1 && n > 1) {
    sX[m] = sX[n - 1];
    sZ[m] = sZ[n - 1];
    sY[m] = sY[n - 1];
    m++;
  }
  return m;
}

/**
 * {@link simplify} in place. The interval stack is popped in the same order
 * the array-of-tuples version popped it -- last pushed first, so `[best, i1]`
 * before `[i0, best]` -- because RDP's tie-break is first-maximum-wins and a
 * different traversal would keep a different vertex.
 */
function simplifyInPlace(n: number, eps: number): number {
  if (n <= 2) return n;
  sKeep.fill(0, 0, n);
  sKeep[0] = 1;
  sKeep[n - 1] = 1;
  let sp = 0;
  sStack[sp++] = 0;
  sStack[sp++] = n - 1;

  while (sp > 0) {
    const i1 = sStack[--sp];
    const i0 = sStack[--sp];
    if (i1 - i0 < 2) continue;
    const ax = sX[i0];
    const az = sZ[i0];
    const dx = sX[i1] - ax;
    const dz = sZ[i1] - az;
    const l = Math.hypot(dx, dz);
    const y0 = sY[i0];
    const y1 = sY[i1];
    let best = -1;
    let bestD = eps;
    for (let i = i0 + 1; i < i1; i++) {
      const rx = sX[i] - ax;
      const rz = sZ[i] - az;
      let dev: number;
      if (l < 1e-6) {
        dev = Math.hypot(rx, rz);
      } else {
        dev = Math.abs(dx * rz - dz * rx) / l;
      }
      // Never simplify away a significant grade break either.
      const yLerp = y0 + ((y1 - y0) * (i - i0)) / (i1 - i0);
      dev = Math.max(dev, Math.abs(sY[i] - yLerp) * 1.5);
      if (dev > bestD) {
        bestD = dev;
        best = i;
      }
    }
    if (best >= 0) {
      sKeep[best] = 1;
      sStack[sp++] = i0;
      sStack[sp++] = best;
      sStack[sp++] = best;
      sStack[sp++] = i1;
    }
  }

  let m = 0;
  for (let i = 0; i < n; i++) {
    if (sKeep[i]) {
      sX[m] = sX[i];
      sZ[m] = sZ[i];
      sY[m] = sY[i];
      m++;
    }
  }
  return m;
}

/** {@link smoothProfile} in place. Endpoints are never touched, as before. */
function smoothInPlace(n: number, passes: number, strength: number): void {
  for (let p = 0; p < passes; p++) {
    for (let i = 0; i < n; i++) sY2[i] = sY[i];
    for (let i = 1; i < n - 1; i++) {
      sY[i] = sY2[i] + ((sY2[i - 1] + sY2[i + 1]) * 0.5 - sY2[i]) * strength;
    }
  }
}

/**
 * OSM leaves a handful of Boston's harbour tunnels tagged only by name — the
 * Callahan and Sumner approaches in particular. Drawing those on the surface
 * puts a motorway through the North End, so trust the name as well as the tag.
 */
function isTunnelRecord(rec: RoadRecord): boolean {
  if (rec.tunnel || (rec.layer ?? 0) < 0) return true;
  const n = rec.name;
  if (!n) return false;
  if (rec.class !== 'motorway' && rec.class !== 'trunk' && rec.class !== 'rail') return false;
  return /\btunnel\b/i.test(n);
}

/**
 * Boston's OSM coverage maps most sidewalks as separate `footway` ways running
 * a few metres off the kerb. We build our own kerb-attached sidewalks, so those
 * duplicates have to go or every street gets two overlapping pavements. A
 * footway counts as a duplicate when nearly all of its vertices sit inside the
 * corridor of a carriageway. Park paths, plaza links and footbridges survive.
 */
function markSidewalkDuplicates(prepared: PreparedRoad[]): Set<PreparedRoad> {
  const CELL = 48;
  const grid = new Map<number, number[]>();
  const segs: number[] = []; // x0,z0,x1,z1,corridor
  const cellKey = (cx: number, cz: number): number => (cx + 4096) * 8192 + (cz + 4096);

  for (const r of prepared) {
    if (!r.spec.kerb && r.cls !== 'motorway' && r.cls !== 'trunk' && r.cls !== 'service') continue;
    if (r.tunnel) continue;
    const corridor = r.halfWidth + (r.spec.sidewalk > 0 ? r.spec.sidewalk + 2.6 : 3.2);
    for (let i = 1; i < r.pts.length; i++) {
      const a = r.pts[i - 1];
      const b = r.pts[i];
      const base = segs.length;
      segs.push(a.x, a.z, b.x, b.z, corridor);
      const cx0 = Math.floor(Math.min(a.x, b.x) / CELL);
      const cx1 = Math.floor(Math.max(a.x, b.x) / CELL);
      const cz0 = Math.floor(Math.min(a.z, b.z) / CELL);
      const cz1 = Math.floor(Math.max(a.z, b.z) / CELL);
      if ((cx1 - cx0) * (cz1 - cz0) > 400) continue;
      for (let cx = cx0; cx <= cx1; cx++) {
        for (let cz = cz0; cz <= cz1; cz++) {
          const k = cellKey(cx, cz);
          const l = grid.get(k);
          if (l) l.push(base);
          else grid.set(k, [base]);
        }
      }
    }
  }

  const inside = (x: number, z: number): boolean => {
    const cx = Math.floor(x / CELL);
    const cz = Math.floor(z / CELL);
    for (let dx = -1; dx <= 1; dx++) {
      for (let dz = -1; dz <= 1; dz++) {
        const l = grid.get(cellKey(cx + dx, cz + dz));
        if (!l) continue;
        for (const b of l) {
          const x0 = segs[b]; const z0 = segs[b + 1];
          const vx = segs[b + 2] - x0; const vz = segs[b + 3] - z0;
          const l2 = vx * vx + vz * vz;
          let t = l2 > 1e-9 ? ((x - x0) * vx + (z - z0) * vz) / l2 : 0;
          t = t < 0 ? 0 : t > 1 ? 1 : t;
          const dxp = x - (x0 + vx * t);
          const dzp = z - (z0 + vz * t);
          if (dxp * dxp + dzp * dzp < segs[b + 4] * segs[b + 4]) return true;
        }
      }
    }
    return false;
  };

  const dupes = new Set<PreparedRoad>();
  for (const r of prepared) {
    if (r.cls !== 'footway') continue;
    if (r.bridge || r.tunnel || r.layer !== 0) continue;
    let hits = 0;
    for (const p of r.pts) if (inside(p.x, p.z)) hits++;
    if (hits / r.pts.length > 0.72) dupes.add(r);
  }
  return dupes;
}

/** Builds the topology. `sample` fills in elevations the data does not carry. */
export function buildNetwork(
  records: RoadRecord[],
  sample: (x: number, z: number) => number,
  waterDist?: (x: number, z: number) => number,
): Network {
  // ---- 1. prepare -------------------------------------------------------
  let prepared: PreparedRoad[] = [];
  for (const rec of records) {
    if (!rec || typeof rec.id !== 'string') continue;
    const cls = (CLASS[rec.class] ? rec.class : 'residential') as RoadClass;
    let m = decodeInto(rec);
    if (!m) continue;
    m = dedupeInPlace(m, 0.08);
    if (m < 2) continue;

    // Fill any missing elevations from the terrain sampler.
    for (let i = 0; i < m; i++) {
      if (!Number.isFinite(sY[i])) {
        const s = sample(sX[i], sZ[i]);
        sY[i] = Number.isFinite(s) ? s : 0;
      }
    }

    // Simplify and grade the profile *before* topology so the junction fill and
    // the ribbon that meets it are computed from identical numbers.
    m = simplifyInPlace(m, TUNE.simplifyEps);
    if (m < 2) continue;
    if (m > 3) smoothInPlace(m, 2, 0.45);

    // Lift a bridge deck clear of the water it crosses.
    //
    // A deck's elevation is interpolated between its land endpoints, and where
    // both of those sit near sea level -- which is every crossing of Fort Point
    // Channel -- the deck lands *at* the water surface. What you see from
    // altitude is a one-pixel line of carriageway appearing and disappearing
    // as the wave troughs pass under it, with no bridge visible at all.
    //
    // The ramp comes from the shoreline field's own signed distance rather than
    // from a guess, so the deck meets the bank at bank height and reaches full
    // clearance out in the channel. No kink to smooth afterwards, and a deck
    // that is already high enough is left alone by the `max`.
    if (waterDist && (rec.bridge || /\bbridge\b/i.test(rec.name ?? ''))) {
      // `sY2` stands in for the old `lifted` copy. The test reads `sY`, the
      // unlifted profile, throughout -- as it did when it compared against
      // `ys` while writing into `lifted`.
      let lifted = false;
      for (let i = 0; i < m; i++) {
        const d = waterDist(sX[i], sZ[i]);
        if (!(d > 0)) continue;
        const t = Math.min(1, d / BRIDGE_RAMP);
        const want = SEA_LEVEL + BRIDGE_CLEARANCE * t;
        if (want <= sY[i]) continue;
        if (!lifted) {
          for (let k = 0; k < m; k++) sY2[k] = sY[k];
          lifted = true;
        }
        sY2[i] = want;
      }
      if (lifted) {
        // One smoothing pass off the lifted profile, endpoints held.
        for (let i = 0; i < m; i++) sY[i] = sY2[i];
        for (let i = 1; i < m - 1; i++) {
          sY[i] = sY2[i] + ((sY2[i - 1] + sY2[i + 1]) * 0.5 - sY2[i]) * 0.35;
        }
      }
    }

    // Materialise the survivor, once, at its exact length.
    const pts: V2[] = new Array(m);
    const ys: number[] = new Array(m);
    for (let i = 0; i < m; i++) {
      pts[i] = { x: sX[i], z: sZ[i] };
      ys[i] = sY[i];
    }

    const midX = sX[m >> 1];
    const midZ = sZ[m >> 1];
    const width = widthOf(rec);
    const tunnel = isTunnelRecord(rec);
    prepared.push({
      id: rec.id,
      name: rec.name,
      cls,
      spec: CLASS[cls],
      pts,
      ys,
      width,
      halfWidth: width * 0.5,
      lanes: lanesOf(rec),
      oneway: !!rec.oneway,
      bridge: !tunnel && (!!rec.bridge || (rec.layer ?? 0) > 0),
      tunnel,
      layer: Number.isFinite(rec.layer) ? rec.layer : 0,
      surface: surfaceOf(rec, midX, midZ),
      length: polylineLength(pts),
      trimStart: 0,
      trimEnd: 0,
      seed: hashStr(rec.id),
    });
  }

  releaseScratch();
  // ---- 2. vertex degrees ------------------------------------------------
  const degree = new Map<number, number>();
  for (const r of prepared) {
    for (let i = 0; i < r.pts.length; i++) {
      const k = key(r.pts[i], r.layer);
      const ends = i === 0 || i === r.pts.length - 1 ? 1 : 2;
      degree.set(k, (degree.get(k) ?? 0) + ends);
    }
  }

  // ---- 3. split ways at interior junction vertices ----------------------
  const split: PreparedRoad[] = [];
  for (const r of prepared) {
    const cuts: number[] = [];
    for (let i = 1; i < r.pts.length - 1; i++) {
      if ((degree.get(key(r.pts[i], r.layer)) ?? 0) >= 3) cuts.push(i);
    }
    if (!cuts.length) {
      split.push(r);
      continue;
    }
    let from = 0;
    let part = 0;
    for (const c of [...cuts, r.pts.length - 1]) {
      if (c - from < 1) continue;
      const pts = r.pts.slice(from, c + 1);
      const ys = r.ys.slice(from, c + 1);
      if (polylineLength(pts) < 0.4) {
        from = c;
        continue;
      }
      split.push({ ...r, id: `${r.id}#${part++}`, pts, ys, length: polylineLength(pts), seed: r.seed + part * 7919 });
      from = c;
    }
  }
  prepared = split;

  // ---- 4. weld degree-2 chains so mid-block joints stay mitred ----------
  prepared = weldChains(prepared);

  // ---- 4b. drop OSM sidewalk footways we are about to rebuild ourselves --
  const dupes = markSidewalkDuplicates(prepared);
  if (dupes.size) prepared = prepared.filter((r) => !dupes.has(r));

  // ---- 5. index the endpoints ------------------------------------------
  const nodes = new Map<number, Approach[]>();
  const surfaceRoads = prepared.filter((r) => !r.tunnel);
  for (const r of surfaceRoads) {
    for (const end of [0, 1] as const) {
      const i = end === 0 ? 0 : r.pts.length - 1;
      const j = end === 0 ? 1 : r.pts.length - 2;
      // Use a look-ahead of a few metres so a wiggly first segment does not
      // throw the approach bearing off.
      const dir = approachDir(r.pts, end);
      const k = key(r.pts[i], r.layer);
      const a: Approach = {
        road: r,
        end,
        dir,
        halfWidth: r.halfWidth,
        angle: Math.atan2(dir.z, dir.x),
        trim: 0,
        y: r.ys[i] ?? 0,
      };
      void j;
      const list = nodes.get(k);
      if (list) list.push(a);
      else nodes.set(k, [a]);
    }
  }

  // ---- 6. junction polygons --------------------------------------------
  const junctions: Junction[] = [];
  for (const [, apps] of nodes) {
    if (apps.length < 2) continue;
    if (apps.length === 2) {
      // Only worth a fill when the two ribbons genuinely mismatch.
      const dw = Math.abs(apps[0].halfWidth - apps[1].halfWidth);
      const straight = Math.abs(apps[0].angle - apps[1].angle);
      const opposed = Math.abs(Math.PI - Math.min(straight, Math.PI * 2 - straight));
      if (dw < 0.7 && opposed < 0.25) continue;
    }
    const j = buildJunction(apps);
    if (j) junctions.push(j);
  }

  // ---- 7. apply trims ---------------------------------------------------
  for (const r of surfaceRoads) {
    const usable = Math.max(0, r.length - 1.2);
    let a = r.trimStart;
    let b = r.trimEnd;
    if (a + b > usable) {
      const k = usable / Math.max(a + b, 1e-3);
      a *= k;
      b *= k;
    }
    r.trimStart = a;
    r.trimEnd = b;
  }

  // ---- 8. tunnel portals ------------------------------------------------
  const portals: Network['portals'] = [];
  const surfaceKeys = new Set<number>();
  for (const r of surfaceRoads) {
    surfaceKeys.add(key(r.pts[0], 0));
    surfaceKeys.add(key(r.pts[r.pts.length - 1], 0));
  }
  for (const r of prepared) {
    if (!r.tunnel) continue;
    // A footway "tunnel" is usually a building passage; only real portals.
    if (r.width < 4 || r.cls === 'footway' || r.cls === 'cycleway' || r.cls === 'service') continue;
    for (const end of [0, 1] as const) {
      const i = end === 0 ? 0 : r.pts.length - 1;
      const p = r.pts[i];
      // A portal exists where a tunnel end coincides with surface road ends.
      let touches = false;
      for (let dz = -1; dz <= 1 && !touches; dz++) {
        for (let dx = -1; dx <= 1 && !touches; dx++) {
          if (surfaceKeys.has(keyAt(Math.round(p.x * GRID) + dx, Math.round(p.z * GRID) + dz, 0))) {
            touches = true;
          }
        }
      }
      if (!touches) continue;
      portals.push({
        p,
        y: sample(p.x, p.z),
        dir: approachDir(r.pts, end),
        width: r.width,
        road: r,
      });
    }
  }

  return { roads: prepared, junctions, portals };
}

function approachDir(pts: V2[], end: 0 | 1): V2 {
  const n = pts.length;
  const at = (i: number): V2 => pts[end === 0 ? i : n - 1 - i];
  const p0 = at(0);
  for (let i = 1; i < n; i++) {
    const d = sub(at(i), p0);
    if (Math.hypot(d.x, d.z) > 2.5) return norm(d);
  }
  return norm(sub(at(n - 1), p0));
}

/**
 * Joins ways that meet head-to-tail at a degree-2 node with matching
 * attributes.
 *
 * The bookkeeping used to cost more than the welding. Every road got
 * `pts.slice()` and `ys.slice()` up front and a `{...seed}` spread on the way
 * out, whether or not it welded to anything -- and only 12,048 of the 66,147
 * do. Both `for (const end of [0, 1] as const)` loops allocated their literal
 * once per road, the endpoint index held a `{r, end}` object and an `Array`
 * per node for 132,294 ends, and the candidate search allocated a closure per
 * probe. On a network averaging 3.5 vertices a way, that was the whole cost of
 * the step.
 *
 * The opening `slice()` was pure waste in any case: every branch that extends
 * the chain `concat`s, which copies on its own, so the copy was made twice
 * when a weld happened and made for nothing when it did not. A road that
 * welds to nothing is now passed straight through -- `length` is already
 * `polylineLength(pts)` over the same points, so the spread was rebuilding an
 * identical object.
 */
function weldChains(roads: PreparedRoad[]): PreparedRoad[] {
  const n = roads.length;
  // Endpoint index, packed as `roadIndex * 2 + end`. Only the first two ends
  // at a node are named, because a node with any other count is one this pass
  // refuses to weld; `crowded` records the overflow.
  const firstAt = new Map<number, number>();
  const secondAt = new Map<number, number>();
  const crowded = new Set<number>();
  for (let i = 0; i < n; i++) {
    const r = roads[i];
    for (let end = 0; end < 2; end++) {
      const k = key(end === 0 ? r.pts[0] : r.pts[r.pts.length - 1], r.layer);
      if (!firstAt.has(k)) firstAt.set(k, i * 2 + end);
      else if (!secondAt.has(k)) secondAt.set(k, i * 2 + end);
      else crowded.add(k);
    }
  }

  const compatible = (a: PreparedRoad, b: PreparedRoad): boolean =>
    a !== b && a.cls === b.cls && a.layer === b.layer && a.bridge === b.bridge &&
    a.tunnel === b.tunnel && a.surface === b.surface && a.oneway === b.oneway &&
    a.lanes === b.lanes && Math.abs(a.width - b.width) < 0.35;

  const consumed = new Uint8Array(n);
  const out: PreparedRoad[] = [];

  for (let si = 0; si < n; si++) {
    if (consumed[si]) continue;
    consumed[si] = 1;
    const seed = roads[si];
    let pts = seed.pts;
    let ys = seed.ys;
    let welded = false;

    // Extend in both directions, forwards first.
    for (let g = 0; g < 2; g++) {
      const grow = g === 0 ? 1 : 0;
      for (;;) {
        const tip = grow === 1 ? pts[pts.length - 1] : pts[0];
        const k = key(tip, seed.layer);
        // Exactly two ends here, or nothing to do.
        if (crowded.has(k)) break;
        const a = firstAt.get(k);
        const b = secondAt.get(k);
        if (a === undefined || b === undefined) break;
        // First of the two that is neither the seed nor already taken.
        let oi = a >> 1;
        let oend = a & 1;
        if (oi === si || consumed[oi]) {
          oi = b >> 1;
          oend = b & 1;
        }
        if (oi === si || consumed[oi]) break;
        const other = roads[oi];
        if (!compatible(seed, other)) break;
        consumed[oi] = 1;
        const op = oend === 0 ? other.pts : other.pts.slice().reverse();
        const oy = oend === 0 ? other.ys : other.ys.slice().reverse();
        if (grow === 1) {
          pts = pts.concat(op.slice(1));
          ys = ys.concat(oy.slice(1));
        } else {
          pts = op.slice().reverse().slice(0, -1).concat(pts);
          ys = oy.slice().reverse().slice(0, -1).concat(ys);
        }
        welded = true;
        if (pts.length > 4000) break;
      }
    }

    out.push(welded ? { ...seed, pts, ys, length: polylineLength(pts) } : seed);
  }
  return out;
}

/**
 * Junction topology: which approaches meet here, how far each ribbon is cut
 * back, and how high the carriageway is at the cut.
 *
 * The boundary ring and the kerb returns are no longer built here -- see
 * {@link junctionGeom}, which derives them on demand from what this function
 * settles. Storing them cost ~55 MB of the boot high-water mark to have
 * geometry ready for tiles that would not be asked for before the peak.
 */
function buildJunction(apps: Approach[]): Junction | null {
  const P = apps[0].end === 0 ? apps[0].road.pts[0] : apps[0].road.pts[apps[0].road.pts.length - 1];
  apps.sort((a, b) => a.angle - b.angle);
  const n = apps.length;
  // The ring is two vertices per approach before any corner is walked, so a
  // node with two or more approaches can never fail the old `ring.length < 3`
  // test. This is that test, asked before the ring is built instead of after.
  if (n < 2) return null;

  let maxWidth = 0;
  let shortest = Infinity;
  for (const a of apps) {
    maxWidth = Math.max(maxWidth, a.halfWidth * 2);
    shortest = Math.min(shortest, a.road.length);
  }
  const maxR = Math.min(TUNE.maxJunctionRadius, Math.max(maxWidth * 0.95, 3), shortest * 0.44);

  const trims = new Array<number>(n).fill(0);

  for (let i = 0; i < n; i++) {
    const a = apps[i];
    const b = apps[(i + 1) % n];
    if (a === b) continue;
    const hit = cornerHit(P, a, b, maxR);
    if (hit) {
      trims[i] = Math.max(trims[i], hit.s);
      trims[(i + 1) % n] = Math.max(trims[(i + 1) % n], hit.t);
    } else {
      // Parallel / reflex: bevel straight across at a safe radius.
      const rr = Math.min(maxR, Math.max(a.halfWidth, b.halfWidth) * 1.15);
      trims[i] = Math.max(trims[i], rr);
      trims[(i + 1) % n] = Math.max(trims[(i + 1) % n], rr);
    }
  }

  let radius = 0;
  for (let i = 0; i < n; i++) {
    const a = apps[i];
    a.trim = Math.min(Math.max(trims[i], a.halfWidth * 0.35), maxR);
    radius = Math.max(radius, a.trim + a.halfWidth);
    // The node is taken from the first approach; compensate for any snapping
    // slack so each ribbon is cut exactly on the junction boundary.
    const own = a.end === 0 ? a.road.pts[0] : a.road.pts[a.road.pts.length - 1];
    const slack = a.dir.x * (P.x - own.x) + a.dir.z * (P.z - own.z);
    const onRoad = Math.max(0, a.trim + slack);
    a.y = elevationAt(a.road, onRoad, a.end);
    if (a.end === 0) a.road.trimStart = Math.max(a.road.trimStart, onRoad);
    else a.road.trimEnd = Math.max(a.road.trimEnd, onRoad);
  }

  // Pick the dominant surface: the highest-priority approach wins.
  let best = apps[0];
  for (const a of apps) if (a.road.spec.priority > best.road.spec.priority) best = a;

  let y = 0;
  for (const a of apps) y += a.y;
  y /= n;

  return {
    p: P,
    y,
    layer: apps[0].road.layer,
    approaches: apps,
    radius,
    surface: best.road.surface,
    maxWidth,
    maxR,
    seed: hashStr(`${Math.round(P.x)}:${Math.round(P.z)}`),
    painted: apps.some((a) => a.road.spec.markings),
  };
}

/**
 * Where the kerb lines of two consecutive approaches cross.
 *
 * Shared by the trim pass and the ring derivation so the corner the ribbon is
 * cut against and the corner the kerb is drawn along can never be computed two
 * different ways. Returns `null` when the lines are parallel or the crossing
 * falls outside the corner radius, which is the caller's cue to bevel.
 *
 * The `{x,z}` temporaries here look like the obvious thing to scalarise --
 * eight objects a corner, ~35,000 corners, walked again on every tile that
 * draws them. Measured, it is worth nothing: none of them escape the call, so
 * TurboFan has already elided them, and a hand-scalarised version with
 * out-parameters moved the boot peak 139.4 -> 140.6 MB, i.e. not at all. The
 * allocations that cost on this path are the ones that *escape* -- what
 * `junctionGeom` pushes into its ring and normals, what the topology maps
 * retain. Left readable on purpose.
 */
function cornerHit(
  P: V2, a: Approach, b: Approach, maxR: number,
): { p: V2; s: number; t: number } | null {
  if (a === b) return null;
  const pa = add(P, scale(perp(a.dir), -a.halfWidth)); // a's right edge
  const pb = add(P, scale(perp(b.dir), b.halfWidth)); // b's left edge
  const hit = rayIntersect(pa, a.dir, pb, b.dir);
  if (hit && hit.s > 0.02 && hit.t > 0.02 && hit.s < maxR && hit.t < maxR) return hit;
  return null;
}

/**
 * Builds the junction boundary from the incident approaches. Consecutive
 * approaches (clockwise when viewed from above) contribute a kerb corner where
 * the outgoing edge of one meets the incoming edge of the next; each approach's
 * trim distance is the furthest of its two corners, so the trimmed ribbon end
 * and the junction boundary share exactly the same edge.
 *
 * Called per tile build, from `emitJunctionFill` and `emitKerbReturns`. A
 * junction that is visible in both the base and the detail tier derives twice;
 * that is thirty-odd short-lived objects against a `MeshBuilder` push of a
 * hundred vertices, and they die inside the same frame slice instead of
 * sitting in old space through the boot peak.
 */
export function junctionGeom(j: Junction): JunctionGeom {
  const apps = j.approaches;
  const n = apps.length;
  const P = j.p;
  const maxR = j.maxR;

  const ring: V2[] = [];
  const ringDy: number[] = [];
  const ringY: number[] = [];
  const arcs: Corner[] = [];

  // Edge points of every approach, at its trimmed end. The fill is pushed
  // 60 mm past the trim so it always laps the ribbon rather than leaving a
  // hairline of bare terrain between the two.
  const edgeL: V2[] = new Array(n);
  const edgeR: V2[] = new Array(n);
  for (let i = 0; i < n; i++) {
    const a = apps[i];
    const na = perp(a.dir);
    const base = add(P, scale(a.dir, a.trim + 0.06));
    edgeL[i] = add(base, scale(na, a.halfWidth));
    edgeR[i] = add(base, scale(na, -a.halfWidth));
  }

  for (let i = 0; i < n; i++) {
    const a = apps[i];
    const b = apps[(i + 1) % n];
    const kerbedA = a.road.spec.kerb;
    const crown = crownDy(a.halfWidth, a.halfWidth, kerbedA);
    ring.push(edgeL[i]);
    ringDy.push(crown);
    ringY.push(a.y);
    ring.push(edgeR[i]);
    ringDy.push(crown);
    ringY.push(a.y);

    const start = edgeR[i];
    const end = edgeL[(i + 1) % n];
    const hit = cornerHit(P, a, b, maxR);
    const ctrl = hit ? hit.p : lerpMid(start, end, P);
    const hw = Math.min(a.halfWidth, b.halfWidth);
    const cornerDy = crownDy(hw, hw, kerbedA && b.road.spec.kerb);

    // Quadratic Bezier through the kerb-line intersection: a real kerb
    // return. It stays inside the triangle start-ctrl-end, so it can never
    // bulge across the carriageway of either approach.
    const chord = dist(start, end);
    const steps = chord < 1.2 ? 1 : Math.max(2, Math.min(7, Math.round(chord / 2.1) + 1));
    const pts: V2[] = [];
    const ys: number[] = [];
    const normals: V2[] = [];
    for (let k = 0; k <= steps; k++) {
      const t = k / steps;
      const mt = 1 - t;
      const px = mt * mt * start.x + 2 * mt * t * ctrl.x + t * t * end.x;
      const pz = mt * mt * start.z + 2 * mt * t * ctrl.z + t * t * end.z;
      const p2 = { x: px, z: pz };
      pts.push(p2);
      ys.push(a.y + (b.y - a.y) * t + cornerDy);
      const ov = sub(p2, P);
      const ol = Math.hypot(ov.x, ov.z);
      normals.push(ol > 1e-4 ? { x: ov.x / ol, z: ov.z / ol } : { x: 1, z: 0 });
      if (k > 0 && k < steps) {
        ring.push(p2);
        ringDy.push(cornerDy);
        ringY.push(a.y + (b.y - a.y) * t);
      }
    }
    arcs.push({
      pts,
      ys,
      normals,
      kerbed: kerbedA && b.road.spec.kerb && n >= 2,
      walk: Math.min(a.road.spec.sidewalk, b.road.spec.sidewalk),
    });
  }

  return { ring, ringDy, ringY, corners: arcs };
}

/** Fallback corner control point when the two kerb lines do not intersect. */
function lerpMid(a: V2, b: V2, away: V2): V2 {
  const mx = (a.x + b.x) * 0.5;
  const mz = (a.z + b.z) * 0.5;
  const dx = mx - away.x;
  const dz = mz - away.z;
  const l = Math.hypot(dx, dz);
  if (l < 1e-4) return { x: mx, z: mz };
  return { x: mx + (dx / l) * 0.6, z: mz + (dz / l) * 0.6 };
}

/**
 * Centreline elevation `d` metres in from the given end of a road.
 *
 * This used to be handed a `cumulative(r.pts)` array, allocated fresh for
 * every approach of every junction -- 36,938 throwaway arrays on a network
 * whose ways average three and a half vertices. The running sum below visits
 * the same segments in the same order and so accumulates bit-identical
 * partial sums; it just never materialises them.
 */
function elevationAt(r: PreparedRoad, d: number, end: 0 | 1): number {
  const pts = r.pts;
  const n = pts.length;
  let total = 0;
  for (let i = 1; i < n; i++) total += dist(pts[i - 1], pts[i]);
  const target = end === 0 ? d : total - d;
  if (target <= 0) return r.ys[0] ?? 0;
  if (target >= total) return r.ys[r.ys.length - 1] ?? 0;
  // First vertex whose cumulative length reaches `target`, as the array scan
  // found it: `prev` is cum[i-1], `cur` is cum[i].
  let prev = 0;
  let cur = 0;
  let i = 1;
  for (; i < n; i++) {
    cur = prev + dist(pts[i - 1], pts[i]);
    if (cur >= target) break;
    prev = cur;
  }
  const span = Math.max(cur - prev, 1e-6);
  const f = (target - prev) / span;
  return (r.ys[i - 1] ?? 0) + ((r.ys[i] ?? 0) - (r.ys[i - 1] ?? 0)) * f;
}

/** Straight-line helper used by the bridge builder. */
export function endToEnd(r: PreparedRoad): number {
  return dist(r.pts[0], r.pts[r.pts.length - 1]);
}
