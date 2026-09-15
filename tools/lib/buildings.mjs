/**
 * BuildingRecord extraction.
 *
 * Handles: way footprints, `type=multipolygon` relation footprints (with proper
 * ring stitching and hole assignment), the OSM height tag zoo, `building:part`
 * de-duplication, and a neighbourhood-aware fallback for the ~70% of Boston
 * buildings that carry no height, material or colour at all.
 */
import { lonLatToWorld } from './geo.mjs';
import {
  area, assembleRings, assignHoles, bbox, centroid, cleanRing, ensureWinding,
  hash32, pointInPolygon, rand1,
} from './geom.mjs';
import { neighbourhoodAt, pick, wallColour, roofColour } from './neighbourhoods.mjs';
import { matchLandmark } from './landmarks.mjs';
import { parseColour, parseLength, parseLevels, parseMaterial, parseRoofShape } from './tags.mjs';

/** Canonical storey height used when converting `building:levels` to metres. */
const LEVEL_M = 3.2;
const MIN_FOOTPRINT_M2 = 8;

/** Building tag values that are never real volumes. */
const SKIP_BUILDING = new Set(['no', 'none', 'demolished', 'razed', 'proposed', 'construction']);

/** Coarse use class, used to select a storey range from the neighbourhood profile. */
function useClass(tags) {
  const b = tags.building || tags['building:part'] || 'yes';
  if (/^(house|detached|semidetached_house|semi|bungalow|terrace|terraced|townhouse|residential|apartments|dormitory|flats|static_caravan|cabin)$/.test(b)) return 'residential';
  if (/^(commercial|office|retail|supermarket|hotel|kiosk|shop|mall|restaurant)$/.test(b)) return 'commercial';
  if (/^(church|cathedral|chapel|mosque|synagogue|temple|civic|public|government|school|university|college|hospital|museum|library|train_station|transportation|stadium|sports_hall|fire_station|courthouse|kindergarten)$/.test(b)) return 'civic';
  if (/^(industrial|warehouse|factory|manufacture|hangar|storage_tank|silo|works|service)$/.test(b)) return 'industrial';
  if (tags.amenity || tags.office || tags.shop || tags.tourism === 'hotel') return 'commercial';
  if (tags.landuse === 'industrial' || tags.man_made) return 'industrial';
  return null; // 'yes' etc -> decided by the neighbourhood
}

/** Tiny outbuildings: never inferred as anything but a single low storey. */
const TINY = new Set([
  'shed', 'garage', 'garages', 'carport', 'hut', 'cabin', 'roof', 'greenhouse',
  'container', 'kiosk', 'bunker', 'boathouse', 'toilets', 'shelter', 'tent', 'canopy',
]);

/**
 * Resolve wall height, in the priority order the brief specifies:
 *   height  ->  building:levels * 3.2 (+ roof)  ->  building:height  ->  inferred.
 * @returns {{height:number, levels:number, source:string}}
 */
/** Distance from a point to a closed ring's boundary, metres. */
function distToRing(ring, x, z) {
  let best = Infinity;
  const n = ring.length / 2;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const ax = ring[j * 2], az = ring[j * 2 + 1];
    const bx = ring[i * 2], bz = ring[i * 2 + 1];
    const dx = bx - ax, dz = bz - az;
    const len2 = dx * dx + dz * dz;
    const t = len2 > 0 ? Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / len2)) : 0;
    const px = ax + dx * t, pz = az + dz * t;
    const d = Math.hypot(x - px, z - pz);
    if (d < best) best = d;
  }
  return best;
}

/**
 * Is every vertex of `ring` inside `poly`, counting the boundary as inside?
 *
 * The tolerance is not a fudge, it is the whole point. A `building:part` almost
 * always shares its parent's outer wall — often the very same OpenStreetMap
 * nodes — so most of its vertices lie exactly *on* the boundary, where
 * point-in-polygon is undefined and returns whichever way the ray casting fell.
 * Testing strictly caught the Prudential, whose part floats a little inside the
 * tower, and missed a thousand others that touch: One Financial Center, Exchange
 * Place, the Federal Reserve, One Post Office Square, State Street Financial
 * Center — every one of them carrying an unnamed slab a few metres shorter than
 * itself, sharing its walls and z-fighting with them.
 *
 * Vertex containment is not polygon containment in general: two rings can
 * interleave with every vertex of one inside the other. Building outlines do not
 * do that, and being wrong here costs a building rather than a crash.
 */
function ringInside(ring, poly, eps = 0.5) {
  for (let i = 0; i < ring.length; i += 2) {
    const x = ring[i], z = ring[i + 1];
    if (distToRing(poly.outline, x, z) <= eps) continue;
    if (poly.holes && poly.holes.some((h) => distToRing(h, x, z) <= eps)) continue;
    if (!pointInPolygon(poly, x, z)) return false;
  }
  return true;
}

/** Height of a footprint's underside above local ground, metres. */
function baseOf(tags, height) {
  let b = parseLength(tags.min_height) ?? 0;
  const minLevel = parseLevels(tags['building:min_level'] ?? tags.min_level);
  if (!b && minLevel) b = minLevel * LEVEL_M;
  return b >= 0 && b < height ? b : 0;
}

function resolveHeight(tags, areaM2, nb, id) {
  const b = tags.building || tags['building:part'] || 'yes';
  const levelsTag = parseLevels(tags['building:levels'] ?? tags.levels);
  const roofLevels = parseLevels(tags['roof:levels']) ?? 0;

  const h = parseLength(tags.height);
  if (h != null && h >= 2 && h <= 450) {
    const lv = levelsTag ?? Math.max(1, Math.round(h / LEVEL_M));
    return { height: h, levels: lv, source: 'height' };
  }
  if (levelsTag != null && levelsTag >= 1) {
    return { height: levelsTag * LEVEL_M, levels: Math.round(levelsTag), source: 'levels' };
  }
  const bh = parseLength(tags['building:height']);
  if (bh != null && bh >= 2 && bh <= 450) {
    return { height: bh, levels: Math.max(1, Math.round(bh / LEVEL_M)), source: 'building:height' };
  }
  if (roofLevels > 0) {
    return { height: Math.max(1, roofLevels) * LEVEL_M, levels: Math.max(1, roofLevels), source: 'roof:levels' };
  }

  // --- inference -----------------------------------------------------------
  if (TINY.has(b)) {
    const lv = b === 'roof' || b === 'canopy' ? 1 : 1;
    return { height: lv * (b === 'shed' || b === 'garage' || b === 'garages' ? 2.8 : 3.2), levels: lv, source: 'inferred-tiny' };
  }
  const p = nb.profile;
  const cls = useClass(tags) ?? (nb.key === 'downtown' || nb.key === 'seaport' || nb.key === 'kendall' ? 'commercial' : 'residential');
  const [lo, hi] = p[cls] ?? p.residential;

  // Footprint size drives most of the placement inside the range; a seeded
  // random tail supplies the variance that stops the skyline looking combed.
  const s = Math.sqrt(Math.max(areaM2, 1));
  const a = Math.min(1, Math.max(0, (s - p.aLo) / (p.aHi - p.aLo)));
  const r = rand1(id, 'lv');
  const t = 0.55 * a + 0.45 * Math.pow(r, 1.7);
  let levels = lo + (hi - lo) * t;

  // Big footprints in tower districts occasionally go properly high-rise.
  if (a > 0.55 && rand1(id, 'tower') < p.towerBias * 0.35) {
    levels *= 1.25 + rand1(id, 'tower2') * 0.9;
  }
  // Churches and civic halls are short in storeys but tall in metres.
  if (/^(church|cathedral|chapel|mosque|synagogue|temple)$/.test(b)) {
    return { height: Math.max(9, Math.min(26, 8 + s * 0.32)), levels: 2, source: 'inferred-church' };
  }
  levels = Math.max(1, Math.round(levels));
  return { height: levels * LEVEL_M, levels, source: 'inferred' };
}

function resolveRoof(tags, areaM2, levels, nb, id) {
  let shape = parseRoofShape(tags['roof:shape'] ?? tags['building:roof:shape']);
  const s = Math.sqrt(Math.max(areaM2, 1));
  if (!shape) {
    if (levels >= 7 || areaM2 > 1800) shape = 'flat';
    else shape = pick(nb.profile.roofs, id, 'roof');
  }
  let roofHeight = parseLength(tags['roof:height']);
  const rl = parseLevels(tags['roof:levels']);
  if (roofHeight == null && rl != null) roofHeight = rl * 2.7;
  if (roofHeight == null || !(roofHeight >= 0) || roofHeight > 60) {
    switch (shape) {
      case 'flat': roofHeight = 0; break;
      case 'mansard': roofHeight = 2.6 + rand1(id, 'rhh') * 1.4; break;
      case 'skillion': roofHeight = 1.0 + Math.min(3, s * 0.06); break;
      case 'dome': roofHeight = Math.min(22, s * 0.45); break;
      case 'pyramidal': roofHeight = Math.min(18, s * 0.34); break;
      default: roofHeight = Math.min(7.5, 1.6 + s * 0.20); break; // gabled / hipped
    }
  }
  if (shape === 'flat') roofHeight = 0;
  return { shape, roofHeight };
}

function resolveMaterial(tags, levels, nb, id) {
  const tagged =
    parseMaterial(tags['building:material']) ??
    parseMaterial(tags['building:facade:material']) ??
    parseMaterial(tags['building:cladding']) ??
    parseMaterial(tags.material);
  if (tagged) return tagged;

  let m = pick(nb.profile.walls, id, 'mat');
  // Height overrides the neighbourhood bag at the extremes: nobody builds a
  // 30-storey wooden tower, and a 2-storey glass box is rare outside the Seaport.
  if (levels >= 14 && (m === 'wood' || m === 'brick' || m === 'plaster' || m === 'brownstone')) {
    m = rand1(id, 'tall') < 0.6 ? 'glass' : 'stone';
  } else if (levels >= 8 && m === 'wood') {
    m = rand1(id, 'tall') < 0.5 ? 'brick' : 'concrete';
  } else if (levels <= 3 && m === 'glass') {
    m = rand1(id, 'short') < 0.5 ? 'brick' : 'stone';
  }
  return m;
}

/**
 * @param {object[]} elements raw Overpass elements
 * @param {(x:number,z:number)=>number} sampleGround
 */
export function buildBuildings(elements, sampleGround, log = console.log) {
  const stats = {
    ways: 0, relations: 0, ringsDropped: 0, tooSmall: 0, partsDropped: 0, buriedDropped: 0, duplicatesDropped: 0,
    partsKept: 0, landmarks: new Map(), heightSource: {}, materialTagged: 0, colourTagged: 0,
  };

  /** @type {{id:string, tags:object, outline:number[], holes:number[][]|undefined, isPart:boolean, a:number}[]} */
  const polys = [];

  const toWorldRing = (geom) => {
    const flat = [];
    for (const p of geom) {
      const [x, z] = lonLatToWorld(p.lon, p.lat);
      flat.push(x, z);
    }
    return cleanRing(flat);
  };

  for (const el of elements) {
    const tags = el.tags || {};
    const bt = tags.building ?? tags['building:part'];
    if (bt == null || SKIP_BUILDING.has(String(bt))) continue;
    const isPart = tags.building == null && tags['building:part'] != null;

    if (el.type === 'way') {
      if (!el.geometry || el.geometry.length < 4) { stats.ringsDropped++; continue; }
      const ring = toWorldRing(el.geometry);
      if (ring.length < 6) { stats.ringsDropped++; continue; }
      polys.push({ id: `w${el.id}`, tags, outline: ring, holes: undefined, isPart, a: area(ring) });
      stats.ways++;
    } else if (el.type === 'relation') {
      const type = tags.type;
      // `type=building` relations just group an outline way with its parts; both
      // are already in the way stream, so processing them would double up.
      if (type !== 'multipolygon') continue;
      const outerGeoms = [], innerGeoms = [];
      for (const mem of el.members || []) {
        if (mem.type !== 'way' || !mem.geometry || mem.geometry.length < 2) continue;
        (mem.role === 'inner' ? innerGeoms : outerGeoms).push(mem.geometry);
      }
      if (!outerGeoms.length) { stats.ringsDropped++; continue; }
      const outers = assembleRings(outerGeoms).map(toWorldRing).filter((r) => r.length >= 6);
      const inners = assembleRings(innerGeoms).map(toWorldRing).filter((r) => r.length >= 6);
      if (!outers.length) { stats.ringsDropped++; continue; }
      const grouped = assignHoles(outers, inners);
      grouped.forEach((g, k) => {
        polys.push({
          id: k === 0 ? `r${el.id}` : `r${el.id}-${k}`,
          tags, outline: g.outline, holes: g.holes, isPart, a: area(g.outline),
        });
      });
      stats.relations++;
    }
  }

  // --- buried geometry -----------------------------------------------------
  // A footprint whose volume lies wholly inside another footprint's volume can
  // never be seen. Drawing it buys nothing and costs a z-fight along every wall
  // the two share, which is most of them.
  //
  // The test is *containment*, and it has to be: the rule this replaced asked
  // whether a part's height was *similar* to its parent's, which is a different
  // question. The Prudential Tower's part repeats the tower's footprint exactly
  // and stops 14.6 m below its roof — plainly a different height, so it was
  // kept. Harmless while the tower was drawn over it, and then the tower, being
  // a landmark, was suppressed in favour of the hand-authored mesh and the
  // invisible slab became the only thing standing there.
  // Everything is a candidate container, not just the untagged parents: parts
  // enclose other parts routinely, and a pair of them sharing a top with one
  // inside the other z-fights exactly as badly as a part inside its building.
  const CELL = 120;
  for (const p of polys) { p._bb = bbox(p.outline); p._c = centroid(p.outline); }
  const grid = new Map();
  for (const p of polys) {
    for (let j = Math.floor(p._bb[1] / CELL); j <= Math.floor(p._bb[3] / CELL); j++) {
      for (let i = Math.floor(p._bb[0] / CELL); i <= Math.floor(p._bb[2] / CELL); i++) {
        const k = `${i},${j}`;
        let a = grid.get(k);
        if (!a) grid.set(k, (a = []));
        a.push(p);
      }
    }
  }

  /** Height of the top of a footprint's walls, metres above local ground. */
  const topOf = (p) => {
    if (p._top === undefined) {
      p._top = resolveHeight(p.tags, p.a, neighbourhoodAt(p._c[0], p._c[1]), p.id).height;
    }
    return p._top;
  };
  /** Named and whole beats unnamed and partial; ties go to the taller. */
  const rank = (p) => (p.tags.name ? 4 : 0) + (p.isPart ? 0 : 2);

  const kept = [];
  for (const p of polys) {
    const pTop = topOf(p);
    const pBase = baseOf(p.tags, pTop);
    let swallowed = null;

    for (let j = Math.floor(p._bb[1] / CELL); j <= Math.floor(p._bb[3] / CELL) && !swallowed; j++) {
      for (let i = Math.floor(p._bb[0] / CELL); i <= Math.floor(p._bb[2] / CELL) && !swallowed; i++) {
        for (const q of grid.get(`${i},${j}`) ?? []) {
          if (q === p) continue;
          // Cheap rejects before the ring test, which is the expensive part.
          if (p._bb[0] < q._bb[0] - 0.5 || p._bb[2] > q._bb[2] + 0.5) continue;
          if (p._bb[1] < q._bb[1] - 0.5 || p._bb[3] > q._bb[3] + 0.5) continue;
          const qTop = topOf(q);
          if (pTop > qTop + 0.5) continue;
          if (pBase < baseOf(q.tags, qTop) - 0.5) continue;
          // Never let a worse-described footprint swallow a better one. The
          // Berkeley Building is named, coloured and given a material, but no
          // height, so it is *inferred* at 16 m — while the unnamed
          // `building:part` describing its pyramidal glass roof declares eight
          // levels and comes out at 26 m. Geometry says the listed building is
          // buried inside an anonymous slab. When the geometry and the tagging
          // disagree that plainly, the tagging is the thing to trust.
          if (rank(p) > rank(q)) continue;
          if (!ringInside(p.outline, q)) continue;
          // Two footprints that enclose each other are the same footprint, and
          // without a tie-break they would swallow each other and both vanish.
          if (Math.abs(p.a - q.a) < 0.5 && ringInside(q.outline, p)) {
            if (rank(p) * 1e6 + pTop >= rank(q) * 1e6 + qTop) continue;
          }
          swallowed = q;
          break;
        }
      }
    }

    if (swallowed) {
      if (p.isPart) stats.partsDropped++; else stats.buriedDropped++;
      continue;
    }
    kept.push(p);
    if (p.isPart) stats.partsKept++;
  }

  // --- identical footprints ------------------------------------------------
  // Separate from the part logic above, which only ever looks at `building:part`.
  // OpenStreetMap also carries plain duplicates: the same structure mapped twice
  // as two `building` ways, or a relation and its outline way both surviving.
  // Two buildings cannot occupy one footprint, so keep the best-described of
  // each set — named first, then whole buildings over parts, then the taller —
  // and drop the rest.
  const DUP_CELL = 8;
  const dupGrid = new Map();
  for (const p of kept) {
    const c = p._c ?? (p._c = centroid(p.outline));
    const k = `${Math.floor(c[0] / DUP_CELL)},${Math.floor(c[1] / DUP_CELL)}`;
    let a = dupGrid.get(k);
    if (!a) dupGrid.set(k, (a = []));
    a.push(p);
  }
  // Best-described wins: named first, then whole buildings over parts, then the
  // taller. Everything else in the set goes.
  const score = (p) => (p.tags.name ? 4 : 0) + (p.isPart ? 0 : 2);
  const dropped = new Set();
  for (const p of kept) {
    if (dropped.has(p)) continue;
    const ci = Math.floor(p._c[0] / DUP_CELL);
    const cj = Math.floor(p._c[1] / DUP_CELL);
    // The 3x3 neighbourhood, because two footprints 3 m apart routinely land on
    // opposite sides of a cell boundary and a single-cell lookup misses them.
    for (let dj = -1; dj <= 1; dj++) {
      for (let di = -1; di <= 1; di++) {
        for (const q of dupGrid.get(`${ci + di},${cj + dj}`) ?? []) {
          if (q === p || dropped.has(q)) continue;
          // 3 m of centroid and 6% of area is inside surveyor noise and far
          // outside any two genuinely distinct buildings.
          if (Math.hypot(q._c[0] - p._c[0], q._c[1] - p._c[1]) >= 3) continue;
          if (Math.abs(q.a - p.a) / Math.max(q.a, p.a) >= 0.06) continue;
          const nb = neighbourhoodAt(p._c[0], p._c[1]);
          const sp = score(p) * 1e6 + resolveHeight(p.tags, p.a, nb, p.id).height;
          const sq = score(q) * 1e6 + resolveHeight(q.tags, q.a, nb, q.id).height;
          dropped.add(sq > sp ? p : q);
          stats.duplicatesDropped++;
          if (sq > sp) break;
        }
        if (dropped.has(p)) break;
      }
      if (dropped.has(p)) break;
    }
  }

  // --- record assembly -----------------------------------------------------
  const out = [];
  for (const p of kept) {
    if (dropped.has(p)) continue;
    if (p.a < MIN_FOOTPRINT_M2) { stats.tooSmall++; continue; }
    const tags = p.tags;
    const [cx, cz] = p._c ?? centroid(p.outline);
    const nb = neighbourhoodAt(cx, cz);

    const { height, levels, source } = resolveHeight(tags, p.a, nb, p.id);
    stats.heightSource[source] = (stats.heightSource[source] || 0) + 1;
    const { shape, roofHeight } = resolveRoof(tags, p.a, levels, nb, p.id);
    const material = resolveMaterial(tags, levels, nb, p.id);
    if (parseMaterial(tags['building:material'] ?? tags['building:facade:material'])) stats.materialTagged++;

    const taggedColour = parseColour(tags['building:colour'] ?? tags['building:color'] ?? tags.colour);
    if (taggedColour != null) stats.colourTagged++;
    const color = taggedColour ?? wallColour(material, p.id);
    const rc = parseColour(tags['roof:colour'] ?? tags['roof:color']);
    const roofColor = rc ?? roofColour(shape, material, p.id);

    let minHeight = parseLength(tags.min_height) ?? 0;
    const minLevel = parseLevels(tags['building:min_level'] ?? tags.min_level);
    if (!minHeight && minLevel) minHeight = minLevel * LEVEL_M;
    if (!(minHeight >= 0) || minHeight >= height) minHeight = 0;

    const name = tags.name || undefined;
    const landmark = matchLandmark(name, cx, cz, tags);
    if (landmark) stats.landmarks.set(landmark, p.id);

    // Outer rings CCW (as seen from above), holes CW.
    ensureWinding(p.outline, true);
    const holes = p.holes ? p.holes.map((h) => ensureWinding(h, false)) : undefined;

    out.push({
      id: p.id,
      outline: p.outline,
      holes,
      height: Math.round(height * 100) / 100,
      minHeight: Math.round(minHeight * 100) / 100,
      ground: Math.round(sampleGround(cx, cz) * 100) / 100,
      levels,
      roof: shape,
      roofHeight: Math.round(roofHeight * 100) / 100,
      material,
      color,
      roofColor,
      name,
      landmark,
      _cx: cx, _cz: cz, _area: p.a, _nb: nb.name,
    });
  }

  log(`  buildings: ${stats.ways} ways + ${stats.relations} multipolygons -> ${out.length} records`);
  log(`    dropped: ${stats.ringsDropped} broken rings, ${stats.tooSmall} sub-${MIN_FOOTPRINT_M2}m2, `
    + `${stats.partsDropped} buried building:parts (${stats.partsKept} kept), `
    + `${stats.buriedDropped} other buried footprints, `
    + `${stats.duplicatesDropped} identical footprints`);
  log(`    height source: ${Object.entries(stats.heightSource).map(([k, v]) => `${k}=${v}`).join(' ')}`);
  log(`    tagged material ${stats.materialTagged}, tagged colour ${stats.colourTagged}`);
  return { buildings: out, stats };
}
