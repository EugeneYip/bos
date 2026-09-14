/**
 * Turn `natural=coastline` — a pile of open, arbitrarily-ordered linestrings —
 * into the harbour water polygon clipped to BOUNDS.
 *
 * OSM's rule is that a coastline way runs with LAND ON ITS LEFT and water on its
 * right. So, working in (lon, lat) where the usual maths orientation applies:
 *
 *   1. stitch ways into maximal chains by matching endpoints;
 *   2. clip each chain to the bounds rectangle;
 *   3. a chain traversed BACKWARDS has water on its left, i.e. on the inside of a
 *      counter-clockwise ring — so reverse every chain;
 *   4. between the end of one reversed chain and the start of the next, walk
 *      counter-clockwise round the rectangle (inserting corners), which keeps the
 *      water on the left there too;
 *   5. closed loops that fall entirely inside the rectangle are islands, i.e.
 *      land, and become holes.
 *
 * Without this the city has no harbour and appears to float.
 */

const EPS = 1e-9;

const key = (p) => `${p.lon.toFixed(7)},${p.lat.toFixed(7)}`;

/** Stitch ways (arrays of {lat,lon}) into maximal chains; closed ones flagged. */
export function stitchChains(ways) {
  const frags = ways
    .filter((w) => w && w.length >= 2)
    .map((g, i) => ({ g, used: false, i }));
  const byStart = new Map();
  for (const f of frags) {
    const k = key(f.g[0]);
    let a = byStart.get(k);
    if (!a) byStart.set(k, (a = []));
    a.push(f);
  }
  const byEnd = new Map();
  for (const f of frags) {
    const k = key(f.g[f.g.length - 1]);
    let a = byEnd.get(k);
    if (!a) byEnd.set(k, (a = []));
    a.push(f);
  }

  const chains = [];
  const grow = (seed) => {
    seed.used = true;
    let pts = seed.g.slice();
    let guard = 0;
    // forward
    for (;;) {
      if (++guard > 50000) break;
      const k = key(pts[pts.length - 1]);
      if (k === key(pts[0])) break;
      const next = (byStart.get(k) || []).find((c) => !c.used);
      if (!next) break;
      next.used = true;
      pts = pts.concat(next.g.slice(1));
    }
    // backward — without this a chain seeded from its middle comes out in two
    // halves, inventing endpoints that then look like dangling coastline.
    for (;;) {
      if (++guard > 50000) break;
      const k = key(pts[0]);
      if (k === key(pts[pts.length - 1])) break;
      const prev = (byEnd.get(k) || []).find((c) => !c.used);
      if (!prev) break;
      prev.used = true;
      pts = prev.g.slice(0, -1).concat(pts);
    }
    chains.push({ pts, closed: key(pts[0]) === key(pts[pts.length - 1]) });
  };

  // Seed from true chain heads first (nothing flows into them), then mop up loops.
  for (const f of frags) {
    if (f.used) continue;
    const k = key(f.g[0]);
    const hasPred = (byEnd.get(k) || []).some((c) => c !== f);
    if (!hasPred) grow(f);
  }
  for (const f of frags) if (!f.used) grow(f);
  return chains;
}

/** Liang-Barsky clip of one segment to a rect. @returns [t0,t1] or null */
function clipSeg(x0, y0, x1, y1, r) {
  let t0 = 0, t1 = 1;
  const dx = x1 - x0, dy = y1 - y0;
  const p = [-dx, dx, -dy, dy];
  const q = [x0 - r.west, r.east - x0, y0 - r.south, r.north - y0];
  for (let i = 0; i < 4; i++) {
    if (Math.abs(p[i]) < EPS) { if (q[i] < 0) return null; continue; }
    const t = q[i] / p[i];
    if (p[i] < 0) { if (t > t1) return null; if (t > t0) t0 = t; }
    else { if (t < t0) return null; if (t < t1) t1 = t; }
  }
  return [t0, t1];
}

const inside = (p, r) =>
  p.lon >= r.west - EPS && p.lon <= r.east + EPS && p.lat >= r.south - EPS && p.lat <= r.north + EPS;

/** Clip an open polyline to the rect, returning the inside runs (direction kept). */
function clipPolyline(pts, r) {
  const runs = [];
  let cur = null;
  for (let i = 0; i + 1 < pts.length; i++) {
    const a = pts[i], b = pts[i + 1];
    const c = clipSeg(a.lon, a.lat, b.lon, b.lat, r);
    if (!c) { cur = null; continue; }
    const [t0, t1] = c;
    const pa = { lon: a.lon + (b.lon - a.lon) * t0, lat: a.lat + (b.lat - a.lat) * t0 };
    const pb = { lon: a.lon + (b.lon - a.lon) * t1, lat: a.lat + (b.lat - a.lat) * t1 };
    if (!cur) { cur = [pa]; runs.push(cur); }
    cur.push(pb);
    if (t1 < 1 - EPS) cur = null; // leaves the rect here
  }
  return runs.filter((run) => run.length >= 2);
}

/** Boundary parameter in [0,4) for a point on the rect edge, counter-clockwise. */
function boundaryParam(p, r) {
  const w = r.east - r.west, h = r.north - r.south;
  const dS = Math.abs(p.lat - r.south), dN = Math.abs(p.lat - r.north);
  const dW = Math.abs(p.lon - r.west), dE = Math.abs(p.lon - r.east);
  const m = Math.min(dS, dN, dW, dE);
  if (m === dS) return 0 + (p.lon - r.west) / w;
  if (m === dE) return 1 + (p.lat - r.south) / h;
  if (m === dN) return 2 + (r.east - p.lon) / w;
  return 3 + (r.north - p.lat) / h;
}

const CORNERS = (r) => [
  { lon: r.west, lat: r.south },  // t = 0
  { lon: r.east, lat: r.south },  // t = 1
  { lon: r.east, lat: r.north },  // t = 2
  { lon: r.west, lat: r.north },  // t = 3
];

/** Points to insert when walking CCW along the boundary from ta to tb. */
function walkBoundary(ta, tb, r) {
  const corners = CORNERS(r);
  const out = [];
  let span = tb - ta;
  if (span <= 1e-12) span += 4;
  let c = Math.floor(ta) + 1;
  for (let n = 0; n < 8; n++) {
    const ct = c % 4;
    let d = ct - ta;
    if (d <= 1e-12) d += 4;
    if (d >= span - 1e-12) break;
    out.push(corners[ct]);
    c++;
  }
  return out;
}

function ringArea(pts) {
  let s = 0;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    s += pts[j].lon * pts[i].lat - pts[i].lon * pts[j].lat;
  }
  return s / 2;
}

function pointInRingLL(ring, p) {
  let ins = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i].lon, yi = ring[i].lat, xj = ring[j].lon, yj = ring[j].lat;
    if ((yi > p.lat) !== (yj > p.lat) && p.lon < ((xj - xi) * (p.lat - yi)) / (yj - yi) + xi) ins = !ins;
  }
  return ins;
}

/**
 * @param {object[]} coastWays  raw Overpass `natural=coastline` way elements
 * @param {{south:number,west:number,north:number,east:number}} rect
 * @returns {{outer:{lon:number,lat:number}[], holes:{lon:number,lat:number}[][]}[]}
 */
export function buildCoastWater(coastWays, rect, log = console.log) {
  const chains = stitchChains(coastWays.map((w) => w.geometry).filter(Boolean));
  log(`  coastline: ${coastWays.length} ways -> ${chains.length} chains (${chains.filter((c) => c.closed).length} closed)`);

  /** Open runs that touch the rect boundary, and closed island loops inside it. */
  const open = [];
  const islands = [];
  for (const ch of chains) {
    if (ch.closed) {
      const allIn = ch.pts.every((p) => inside(p, rect));
      if (allIn) { islands.push(ch.pts.slice(0, -1)); continue; }
    }
    for (const run of clipPolyline(ch.pts, rect)) {
      const startsOnEdge = !strictlyInside(run[0], rect);
      const endsOnEdge = !strictlyInside(run[run.length - 1], rect);
      if (startsOnEdge && endsOnEdge) open.push(run);
      // A run with a dangling end inside the rect means the source data is
      // incomplete there; using it would produce a self-intersecting polygon.
    }
  }
  log(`  coastline: ${open.length} boundary-crossing runs, ${islands.length} whole islands`);

  // Reverse so water is on the left, then index by where each reversed run
  // *starts* on the boundary.
  const rev = open.map((run) => run.slice().reverse());
  const items = rev.map((pts, i) => ({
    pts, i, used: false,
    tStart: boundaryParam(pts[0], rect),
    tEnd: boundaryParam(pts[pts.length - 1], rect),
  }));
  items.sort((a, b) => a.tStart - b.tStart);
  if (process.env.COAST_DEBUG) {
    for (const it of items) {
      const a = it.pts[0], b = it.pts[it.pts.length - 1];
      log(`    run pts=${it.pts.length} tStart=${it.tStart.toFixed(4)} (${a.lat.toFixed(4)},${a.lon.toFixed(4)}) -> tEnd=${it.tEnd.toFixed(4)} (${b.lat.toFixed(4)},${b.lon.toFixed(4)})`);
    }
  }

  /** First run whose start lies counter-clockwise-next after `t` (wrapping). */
  const nextAfter = (t) => items.find((it) => it.tStart > t + 1e-12) ?? items[0];

  const polys = [];
  for (const seed of items) {
    if (seed.used) continue;
    const ring = [];
    let cur = seed;
    let guard = 0;
    for (;;) {
      cur.used = true;
      for (const p of cur.pts) ring.push(p);
      const cand = nextAfter(cur.tEnd);
      for (const c of walkBoundary(cur.tEnd, cand.tStart, rect)) ring.push(c);
      // The ring closes when the walk arrives back at the run it started from;
      // landing on some *other* used run means the source coastline is
      // inconsistent, so stop rather than weld two unrelated water bodies.
      if (cand === seed || cand.used || ++guard > 10000) break;
      cur = cand;
    }
    if (ring.length >= 4) polys.push(ring);
  }

  // Water rings must come out counter-clockwise (positive shoelace in lon/lat).
  const out = [];
  for (const ring of polys) {
    const a = ringArea(ring);
    if (Math.abs(a) < 1e-10) continue;
    const outer = a > 0 ? ring : ring.slice().reverse();
    out.push({ outer, holes: [] });
  }
  // Islands are land: assign each to the water polygon containing it.
  for (const isl of islands) {
    const a = ringArea(isl);
    const hole = a < 0 ? isl : isl.slice().reverse(); // holes clockwise
    const probe = isl[0];
    const host = out.find((o) => pointInRingLL(o.outer, probe));
    if (host) host.holes.push(hole);
  }
  log(`  coastline: ${out.length} water polygons, ${out.reduce((s, o) => s + o.holes.length, 0)} island holes`);
  return out;
}

function strictlyInside(p, r) {
  const dx = Math.min(Math.abs(p.lon - r.west), Math.abs(p.lon - r.east));
  const dy = Math.min(Math.abs(p.lat - r.south), Math.abs(p.lat - r.north));
  return dx > 1e-7 && dy > 1e-7;
}
