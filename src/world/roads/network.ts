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
  type V2, add, cumulative, dedupe, dist, norm, perp, polylineLength,
  rayIntersect, scale, simplify, smoothProfile, sub, hashStr,
} from './math2';
import {
  CLASS, type ClassSpec, type SurfaceKey, TUNE, crownDy, lanesOf, surfaceOf, widthOf,
} from './spec';

export interface PreparedRoad {
  id: string;
  rec: RoadRecord;
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
  /** Boundary ring with per-vertex elevation offsets, up-facing when filled. */
  ring: V2[];
  ringDy: number[];
  ringY: number[];
  /** Rounded kerb returns, one per consecutive approach pair. */
  corners: Corner[];
  radius: number;
  surface: SurfaceKey;
  /** Widest approach — drives crosswalk length and stop-bar setback. */
  maxWidth: number;
  seed: number;
  /** True when at least one approach carries painted markings. */
  painted: boolean;
}

export interface Network {
  roads: PreparedRoad[];
  junctions: Junction[];
  /** Tunnel portals: node position plus the direction the road descends. */
  portals: Array<{ p: V2; y: number; dir: V2; width: number; road: PreparedRoad }>;
}

const GRID = 2; // 0.5 m snapping
const key = (p: V2, layer: number): string =>
  `${Math.round(p.x * GRID)}|${Math.round(p.z * GRID)}|${layer}`;

function decode(rec: RoadRecord): { pts: V2[]; ys: number[] } | null {
  const path = rec.path;
  if (!Array.isArray(path) || path.length < 4) return null;
  const n = path.length >> 1;
  const pts: V2[] = new Array(n);
  const ys: number[] = new Array(n);
  const elev = Array.isArray(rec.elevation) ? rec.elevation : [];
  for (let i = 0; i < n; i++) {
    const x = path[i * 2];
    const z = path[i * 2 + 1];
    if (!Number.isFinite(x) || !Number.isFinite(z)) return null;
    pts[i] = { x, z };
    const e = elev[i];
    ys[i] = Number.isFinite(e) ? (e as number) : Number.NaN;
  }
  return { pts, ys };
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
): Network {
  // ---- 1. prepare -------------------------------------------------------
  let prepared: PreparedRoad[] = [];
  for (const rec of records) {
    if (!rec || typeof rec.id !== 'string') continue;
    const cls = (CLASS[rec.class] ? rec.class : 'residential') as RoadClass;
    const dec = decode(rec);
    if (!dec) continue;
    const dd = dedupe(dec.pts, dec.ys, 0.08);
    if (dd.pts.length < 2) continue;

    // Fill any missing elevations from the terrain sampler.
    for (let i = 0; i < dd.ys.length; i++) {
      if (!Number.isFinite(dd.ys[i])) {
        const s = sample(dd.pts[i].x, dd.pts[i].z);
        dd.ys[i] = Number.isFinite(s) ? s : 0;
      }
    }

    // Simplify and grade the profile *before* topology so the junction fill and
    // the ribbon that meets it are computed from identical numbers.
    const sm = simplify(dd.pts, dd.ys, TUNE.simplifyEps);
    if (sm.pts.length < 2) continue;
    const ys = sm.ys.length > 3 ? smoothProfile(sm.ys, 2, 0.45) : sm.ys;

    const mid = sm.pts[sm.pts.length >> 1];
    const width = widthOf(rec);
    const tunnel = isTunnelRecord(rec);
    prepared.push({
      id: rec.id,
      rec,
      cls,
      spec: CLASS[cls],
      pts: sm.pts,
      ys,
      width,
      halfWidth: width * 0.5,
      lanes: lanesOf(rec),
      oneway: !!rec.oneway,
      bridge: !tunnel && (!!rec.bridge || (rec.layer ?? 0) > 0),
      tunnel,
      layer: Number.isFinite(rec.layer) ? rec.layer : 0,
      surface: surfaceOf(rec, mid.x, mid.z),
      length: polylineLength(sm.pts),
      trimStart: 0,
      trimEnd: 0,
      seed: hashStr(rec.id),
    });
  }

  // ---- 2. vertex degrees ------------------------------------------------
  const degree = new Map<string, number>();
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
  const nodes = new Map<string, Approach[]>();
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
  const surfaceKeys = new Set<string>();
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
          const k = `${Math.round(p.x * GRID) + dx}|${Math.round(p.z * GRID) + dz}|0`;
          if (surfaceKeys.has(k)) touches = true;
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

/** Joins ways that meet head-to-tail at a degree-2 node with matching attributes. */
function weldChains(roads: PreparedRoad[]): PreparedRoad[] {
  const ends = new Map<string, Array<{ r: PreparedRoad; end: 0 | 1 }>>();
  for (const r of roads) {
    for (const end of [0, 1] as const) {
      const k = key(end === 0 ? r.pts[0] : r.pts[r.pts.length - 1], r.layer);
      const l = ends.get(k);
      if (l) l.push({ r, end });
      else ends.set(k, [{ r, end }]);
    }
  }

  const compatible = (a: PreparedRoad, b: PreparedRoad): boolean =>
    a !== b && a.cls === b.cls && a.layer === b.layer && a.bridge === b.bridge &&
    a.tunnel === b.tunnel && a.surface === b.surface && a.oneway === b.oneway &&
    a.lanes === b.lanes && Math.abs(a.width - b.width) < 0.35;

  const consumed = new Set<PreparedRoad>();
  const out: PreparedRoad[] = [];

  for (const seed of roads) {
    if (consumed.has(seed)) continue;
    consumed.add(seed);
    let pts = seed.pts.slice();
    let ys = seed.ys.slice();

    // Extend in both directions.
    for (const grow of [1, 0] as const) {
      for (;;) {
        const tip = grow === 1 ? pts[pts.length - 1] : pts[0];
        const list = ends.get(key(tip, seed.layer));
        if (!list || list.length !== 2) break;
        const other = list.find((e) => e.r !== seed && !consumed.has(e.r));
        if (!other || !compatible(seed, other.r)) break;
        consumed.add(other.r);
        const op = other.end === 0 ? other.r.pts : other.r.pts.slice().reverse();
        const oy = other.end === 0 ? other.r.ys : other.r.ys.slice().reverse();
        if (grow === 1) {
          pts = pts.concat(op.slice(1));
          ys = ys.concat(oy.slice(1));
        } else {
          pts = op.slice().reverse().slice(0, -1).concat(pts);
          ys = oy.slice().reverse().slice(0, -1).concat(ys);
        }
        if (pts.length > 4000) break;
      }
    }

    out.push({ ...seed, pts, ys, length: polylineLength(pts) });
  }
  return out;
}

/**
 * Builds the junction boundary from the incident approaches. Consecutive
 * approaches (clockwise when viewed from above) contribute a kerb corner where
 * the outgoing edge of one meets the incoming edge of the next; each approach's
 * trim distance is then the furthest of its two corners, so the trimmed ribbon
 * end and the junction boundary share exactly the same edge.
 */
function buildJunction(apps: Approach[]): Junction | null {
  const P = apps[0].end === 0 ? apps[0].road.pts[0] : apps[0].road.pts[apps[0].road.pts.length - 1];
  apps.sort((a, b) => a.angle - b.angle);
  const n = apps.length;

  let maxWidth = 0;
  let shortest = Infinity;
  for (const a of apps) {
    maxWidth = Math.max(maxWidth, a.halfWidth * 2);
    shortest = Math.min(shortest, a.road.length);
  }
  const maxR = Math.min(TUNE.maxJunctionRadius, Math.max(maxWidth * 0.95, 3), shortest * 0.44);

  const corners: Array<V2 | null> = new Array(n).fill(null);
  const trims = new Array<number>(n).fill(0);

  for (let i = 0; i < n; i++) {
    const a = apps[i];
    const b = apps[(i + 1) % n];
    if (a === b) continue;
    const na = perp(a.dir);
    const nb = perp(b.dir);
    const pa = add(P, scale(na, -a.halfWidth)); // a's right edge
    const pb = add(P, scale(nb, b.halfWidth)); // b's left edge
    const hit = rayIntersect(pa, a.dir, pb, b.dir);
    if (hit && hit.s > 0.02 && hit.t > 0.02 && hit.s < maxR && hit.t < maxR) {
      corners[i] = hit.p;
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
    const cum = cumulative(a.road.pts);
    a.y = elevationAt(a.road, onRoad, a.end, cum);
    if (a.end === 0) a.road.trimStart = Math.max(a.road.trimStart, onRoad);
    else a.road.trimEnd = Math.max(a.road.trimEnd, onRoad);
  }

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
    const ctrl = corners[i] ?? lerpMid(start, end, P);
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
  if (ring.length < 3) return null;

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
    ring,
    ringDy,
    ringY,
    corners: arcs,
    radius,
    surface: best.road.surface,
    maxWidth,
    seed: hashStr(`${Math.round(P.x)}:${Math.round(P.z)}`),
    painted: apps.some((a) => a.road.spec.markings),
  };
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

/** Centreline elevation `d` metres in from the given end of a road. */
function elevationAt(r: PreparedRoad, d: number, end: 0 | 1, cum: number[]): number {
  const total = cum[cum.length - 1];
  const target = end === 0 ? d : total - d;
  if (target <= 0) return r.ys[0] ?? 0;
  if (target >= total) return r.ys[r.ys.length - 1] ?? 0;
  let i = 1;
  while (i < cum.length && cum[i] < target) i++;
  const span = Math.max(cum[i] - cum[i - 1], 1e-6);
  const f = (target - cum[i - 1]) / span;
  return (r.ys[i - 1] ?? 0) + ((r.ys[i] ?? 0) - (r.ys[i - 1] ?? 0)) * f;
}

/** Straight-line helper used by the bridge builder. */
export function endToEnd(r: PreparedRoad): number {
  return dist(r.pts[0], r.pts[r.pts.length - 1]);
}
