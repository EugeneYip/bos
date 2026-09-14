/**
 * AreaRecord extraction: water, parks, land use, the airfield, railyards, piers.
 *
 * Two sources are merged: tagged polygons from Overpass (ways and multipolygon
 * relations) and the harbour polygon assembled from `natural=coastline`
 * (see coastline.mjs).
 */
import { lonLatToWorld } from './geo.mjs';
import {
  area, assembleRings, assignHoles, centroid, cleanRing, ensureWinding, pointInRing, simplify,
} from './geom.mjs';

/** The Charles is impounded behind the New Charles River Dam, ~0.6 m above MSL. */
export const CHARLES_LEVEL = 0.6;
/** Everything below the dam is tidal; we model mean tide level at chart datum. */
export const TIDAL_LEVEL = 0;

/**
 * Envelope of the impounded Charles basin, from the dam upstream to the western
 * edge of BOUNDS. Water polygons whose centroid falls inside sit at CHARLES_LEVEL.
 */
const CHARLES_BASIN_LL = [
  [-71.0690, 42.3648], [-71.0706, 42.3742], [-71.0860, 42.3722], [-71.1010, 42.3690],
  [-71.1180, 42.3672], [-71.1320, 42.3660], [-71.1320, 42.3470], [-71.1130, 42.3512],
  [-71.0980, 42.3530], [-71.0860, 42.3540], [-71.0740, 42.3556], [-71.0678, 42.3580],
];
const CHARLES_BASIN = (() => {
  const f = [];
  for (const [lon, lat] of CHARLES_BASIN_LL) { const [x, z] = lonLatToWorld(lon, lat); f.push(x, z); }
  return f;
})();

/** @returns {import('../../src/core/types').AreaKind|null} */
export function classifyArea(t) {
  const water = t.water;
  if (t.natural === 'water' || t.waterway === 'riverbank' || t.waterway === 'dock' || t.waterway === 'canal') {
    if (water === 'river' || water === 'stream' || water === 'canal' || t.waterway === 'riverbank' || t.waterway === 'canal') return 'river';
    return 'water';
  }
  if (t.landuse === 'reservoir' || t.landuse === 'basin') return 'water';
  if (t.leisure === 'swimming_pool' || t.leisure === 'water_park' || t.leisure === 'marina') return 'water';

  if (t.aeroway === 'runway' || t.aeroway === 'taxiway' || t.aeroway === 'apron' || t.aeroway === 'helipad') return 'runway';
  if (t.landuse === 'railway') return 'railyard';
  if (t.man_made === 'pier' || t.man_made === 'breakwater' || t.man_made === 'groyne') return 'pier';

  if (t.leisure === 'golf_course') return 'golf';
  if (t.leisure === 'pitch' || t.leisure === 'track' || t.leisure === 'playground' ||
      t.leisure === 'stadium' || t.leisure === 'sports_centre') return 'pitch';
  if (t.leisure === 'park' || t.leisure === 'garden' || t.leisure === 'common' ||
      t.leisure === 'dog_park' || t.leisure === 'nature_reserve') return 'park';

  if (t.landuse === 'cemetery' || t.amenity === 'grave_yard') return 'cemetery';
  if (t.landuse === 'forest' || t.natural === 'wood') return 'forest';
  if (t.natural === 'beach') return 'beach';
  if (t.natural === 'sand' || t.natural === 'shingle' || t.natural === 'mud') return 'sand';
  if (t.natural === 'wetland') return 'wetland';
  if (t.natural === 'scrub' || t.natural === 'grassland') return 'grass';
  if (t.amenity === 'parking') return 'parking';
  if (t.highway === 'pedestrian' || t.place === 'square') return 'plaza';
  if (/^(grass|meadow|village_green|recreation_ground|flowerbed|allotments|orchard|farmland|plant_nursery|greenfield|brownfield)$/.test(t.landuse || '')) return 'grass';
  return null;
}

const WATER_KINDS = new Set(['water', 'river']);
/** Ordering used when two polygons overlap; higher wins visually downstream. */
const KIND_PRIORITY = {
  water: 10, river: 10, runway: 9, pier: 8, railyard: 7, plaza: 6, parking: 5,
  pitch: 4, golf: 3, cemetery: 3, beach: 3, sand: 3, wetland: 3, park: 2, forest: 2, grass: 1,
};

const MIN_AREA = { default: 60, water: 120, river: 120, park: 60, grass: 80, parking: 120, pitch: 60 };

/**
 * @param {object[]} elements  raw Overpass elements from the AREA query
 * @param {{outer:{lon:number,lat:number}[],holes:{lon:number,lat:number}[][]}[]} coastPolys
 * @param {(x:number,z:number)=>number} sampleGround
 */
export function buildAreas(elements, coastPolys, sampleGround, log = console.log) {
  const stats = { ways: 0, relations: 0, skippedMembers: 0, unclassified: 0, tooSmall: 0, byKind: {} };
  const out = [];

  // Ways that belong to a multipolygon we are about to process must not also be
  // emitted on their own, or every river gets drawn twice.
  const memberWays = new Set();
  for (const el of elements) {
    if (el.type !== 'relation' || (el.tags || {}).type !== 'multipolygon') continue;
    if (!classifyArea(el.tags || {})) continue;
    for (const m of el.members || []) if (m.type === 'way') memberWays.add(m.ref);
  }

  const toWorld = (geom) => {
    const flat = [];
    for (const p of geom) { const [x, z] = lonLatToWorld(p.lon, p.lat); flat.push(x, z); }
    return cleanRing(flat);
  };

  const push = (id, kind, outline, holes, tags) => {
    const a = area(outline);
    const floor = MIN_AREA[kind] ?? MIN_AREA.default;
    if (a < floor) { stats.tooSmall++; return; }
    // Big smooth natural boundaries tolerate more simplification than a tennis court.
    const tol = a > 2e5 ? 1.6 : a > 2e4 ? 1.0 : 0.5;
    let ring = simplify(outline, tol);
    if (ring.length < 6) { stats.tooSmall++; return; }
    ensureWinding(ring, true);
    const hs = (holes || [])
      .map((h) => simplify(h, tol))
      .filter((h) => h.length >= 6 && area(h) > floor * 0.5)
      .map((h) => ensureWinding(h, false));
    const [cx, cz] = centroid(ring);

    let elevation, drape;
    if (WATER_KINDS.has(kind)) {
      drape = false;
      elevation = pointInRing(CHARLES_BASIN, cx, cz) ? CHARLES_LEVEL : TIDAL_LEVEL;
    } else if (kind === 'pier') {
      drape = false;
      elevation = Math.max(sampleGround(cx, cz), 2.0);
    } else {
      drape = true;
      elevation = sampleGround(cx, cz);
    }
    stats.byKind[kind] = (stats.byKind[kind] || 0) + 1;
    out.push({
      id, kind, outline: ring,
      holes: hs.length ? hs : undefined,
      elevation: Math.round(elevation * 100) / 100,
      drape,
      name: (tags && tags.name) || undefined,
      _area: a, _cx: cx, _cz: cz,
      _prio: KIND_PRIORITY[kind] ?? 0,
    });
  };

  for (const el of elements) {
    const tags = el.tags || {};
    const kind = classifyArea(tags);
    if (!kind) { stats.unclassified++; continue; }
    if (el.type === 'way') {
      if (memberWays.has(el.id)) { stats.skippedMembers++; continue; }
      if (!el.geometry || el.geometry.length < 4) continue;
      const ring = toWorld(el.geometry);
      if (ring.length < 6) continue;
      push(`w${el.id}`, kind, ring, null, tags);
      stats.ways++;
    } else if (el.type === 'relation') {
      if (tags.type !== 'multipolygon') continue;
      const outerG = [], innerG = [];
      for (const m of el.members || []) {
        if (m.type !== 'way' || !m.geometry || m.geometry.length < 2) continue;
        (m.role === 'inner' ? innerG : outerG).push(m.geometry);
      }
      const outers = assembleRings(outerG).map(toWorld).filter((r) => r.length >= 6);
      const inners = assembleRings(innerG).map(toWorld).filter((r) => r.length >= 6);
      if (!outers.length) continue;
      assignHoles(outers, inners).forEach((g, k) => {
        push(k === 0 ? `r${el.id}` : `r${el.id}-${k}`, kind, g.outline, g.holes, tags);
      });
      stats.relations++;
    }
  }

  // --- harbour ------------------------------------------------------------
  let coastIdx = 0;
  for (const p of coastPolys) {
    const outer = toWorld(p.outer);
    if (outer.length < 6) continue;
    const holes = p.holes.map(toWorld).filter((h) => h.length >= 6);
    const ring = simplify(outer, 1.6);
    ensureWinding(ring, true);
    const hs = holes.map((h) => ensureWinding(simplify(h, 1.6), false)).filter((h) => h.length >= 6);
    const a = area(ring);
    stats.byKind.water = (stats.byKind.water || 0) + 1;
    out.push({
      id: `coast${coastIdx++}`, kind: 'water', outline: ring,
      holes: hs.length ? hs : undefined,
      elevation: TIDAL_LEVEL, drape: false,
      name: 'Boston Harbor',
      _area: a, _cx: centroid(ring)[0], _cz: centroid(ring)[1], _prio: 11,
    });
  }

  out.sort((a, b) => b._area - a._area);
  log(`  areas: ${stats.ways} ways + ${stats.relations} multipolygons (+${coastPolys.length} coastline) -> ${out.length} records`);
  log(`    ${Object.entries(stats.byKind).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}=${v}`).join(' ')}`);
  log(`    skipped ${stats.skippedMembers} relation member ways, ${stats.tooSmall} below minimum area`);
  return { areas: out, stats };
}
