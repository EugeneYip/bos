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
  hash32, rand1,
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
    ways: 0, relations: 0, ringsDropped: 0, tooSmall: 0, partsDropped: 0,
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

  // --- building:part de-duplication ----------------------------------------
  // Parts are only useful when they describe a volume the parent does not: a
  // tower on a podium, a spire. A part that merely repeats its parent's shape and
  // height is noise, and rendering both produces z-fighting on every wall.
  const parents = polys.filter((p) => !p.isPart);
  const parentGrid = new Map();
  const CELL = 120;
  const keyOf = (x, z) => `${Math.floor(x / CELL)},${Math.floor(z / CELL)}`;
  for (const p of parents) {
    p._bb = bbox(p.outline);
    p._c = centroid(p.outline);
    for (let j = Math.floor(p._bb[1] / CELL); j <= Math.floor(p._bb[3] / CELL); j++) {
      for (let i = Math.floor(p._bb[0] / CELL); i <= Math.floor(p._bb[2] / CELL); i++) {
        const k = `${i},${j}`;
        let a = parentGrid.get(k);
        if (!a) parentGrid.set(k, (a = []));
        a.push(p);
      }
    }
  }
  const kept = [];
  for (const p of polys) {
    if (!p.isPart) { kept.push(p); continue; }
    const c = centroid(p.outline);
    const cands = parentGrid.get(keyOf(c[0], c[1])) || [];
    let parent = null;
    for (const q of cands) {
      if (c[0] < q._bb[0] || c[0] > q._bb[2] || c[1] < q._bb[1] || c[1] > q._bb[3]) continue;
      if (!parent || q.a < parent.a) parent = q;
    }
    if (!parent) { kept.push(p); stats.partsKept++; continue; }
    const nbP = neighbourhoodAt(c[0], c[1]);
    const hPart = resolveHeight(p.tags, p.a, nbP, p.id).height;
    const hParent = resolveHeight(parent.tags, parent.a, nbP, parent.id).height;
    const sameShape = Math.abs(p.a - parent.a) / Math.max(p.a, parent.a) < 0.08;
    if (sameShape && Math.abs(hPart - hParent) < 2.5) { stats.partsDropped++; continue; }
    if (Math.abs(hPart - hParent) < 1.5) { stats.partsDropped++; continue; }
    kept.push(p); stats.partsKept++;
  }

  // --- record assembly -----------------------------------------------------
  const out = [];
  for (const p of kept) {
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
    const landmark = matchLandmark(name, cx, cz);
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
  log(`    dropped: ${stats.ringsDropped} broken rings, ${stats.tooSmall} sub-${MIN_FOOTPRINT_M2}m2, ${stats.partsDropped} duplicate building:parts (${stats.partsKept} parts kept)`);
  log(`    height source: ${Object.entries(stats.heightSource).map(([k, v]) => `${k}=${v}`).join(' ')}`);
  log(`    tagged material ${stats.materialTagged}, tagged colour ${stats.colourTagged}`);
  return { buildings: out, stats };
}
