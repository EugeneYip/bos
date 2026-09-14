/**
 * PropSet extraction + synthesis.
 *
 * OSM's Boston tree coverage is patchy (a few thousand points for a city with
 * ~35 000 street trees and vast park canopy), and an empty street reads as a
 * model, not a city. So on top of the surveyed points we synthesise trees along
 * residential-scale streets and inside park polygons, deterministically seeded so
 * every rebuild produces the identical forest, and masked against buildings,
 * water and carriageways so nothing grows through a roof or out of the harbour.
 */
import { lonLatToWorld, WORLD_BOUNDS } from './geo.mjs';
import { GridIndex, bbox, hash32, pointInRing, rng } from './geom.mjs';
import { neighbourhoodAt } from './neighbourhoods.mjs';

const TAU = Math.PI * 2;

/** Point-feature tag -> PropKind. */
function classifyNode(t) {
  if (t.natural === 'tree') return 'tree';
  if (t.highway === 'street_lamp') return 'streetlamp';
  if (t.highway === 'traffic_signals') return 'traffic_signal';
  if (t.amenity === 'bench') return 'bench';
  if (t.barrier === 'bollard') return 'bollard';
  if (t.amenity === 'fountain') return 'fountain';
  if (t.historic === 'memorial' || t.historic === 'monument' || t.tourism === 'artwork' ||
      t.man_made === 'obelisk') return 'statue';
  if (t.man_made === 'mast' || t.man_made === 'communications_tower' ||
      t.man_made === 'water_tower' || t.man_made === 'lighthouse') return 'mast';
  if (t.man_made === 'chimney') return 'chimney';
  if (t.man_made === 'crane') return 'crane';
  if (t.man_made === 'flagpole') return 'flagpole';
  return null;
}

/** Per-kind scale spread; trees get the widest because canopy age varies most. */
const SCALE = {
  tree: [0.62, 1.55], streetlamp: [0.92, 1.08], traffic_signal: [0.95, 1.05],
  bench: [0.94, 1.06], bollard: [0.9, 1.1], fountain: [0.8, 1.3], statue: [0.75, 1.4],
  mast: [0.8, 1.6], chimney: [0.8, 1.7], crane: [0.85, 1.3], flagpole: [0.85, 1.25],
};
const VARIANTS = { tree: 6, streetlamp: 3, bench: 2, statue: 3, bollard: 2 };

/** Road classes that get a synthesised street-tree belt, and how densely. */
const TREE_STREETS = {
  residential: { spacing: 13, prob: 0.86, offset: 2.4 },
  tertiary: { spacing: 14, prob: 0.74, offset: 2.8 },
  secondary: { spacing: 16, prob: 0.55, offset: 3.2 },
  primary: { spacing: 18, prob: 0.40, offset: 3.6 },
  pedestrian: { spacing: 15, prob: 0.55, offset: 2.6 },
};

/** Neighbourhood multiplier — leafy Brookline vs the Financial District. */
const STREET_TREE_BIAS = {
  downtown: 0.28, government_center: 0.3, seaport: 0.45, airport: 0.05, industrial: 0.2,
  fort_point: 0.4, chinatown: 0.35, west_end: 0.5, north_end: 0.3, beacon_hill: 0.7,
  back_bay: 0.95, south_end: 1.0, kendall: 0.6, campus: 0.9, longwood: 0.7,
  fenway: 0.85, mission_hill: 0.9, charlestown: 0.8, triple_decker: 0.95, suburban: 1.15,
};

/** Canopy spacing inside area polygons, metres. */
const AREA_TREE_SPACING = {
  forest: 9, park: 16, cemetery: 19, grass: 30, golf: 38, wetland: 26, pitch: 0,
  plaza: 0, parking: 0, water: 0, river: 0, runway: 0, railyard: 0, pier: 0,
  beach: 0, sand: 0,
};

export function buildProps(elements, areas, buildings, roads, sampleGround, log = console.log) {
  const byKind = new Map();
  const add = (kind, x, y, z, scale, rot, variant) => {
    let s = byKind.get(kind);
    if (!s) byKind.set(kind, (s = { kind, positions: [], scales: [], rotations: [], variants: [] }));
    s.positions.push(x, y, z);
    s.scales.push(scale);
    s.rotations.push(rot);
    s.variants.push(variant);
  };
  const jitterFor = (kind, seed) => {
    const r = rng(seed);
    const [lo, hi] = SCALE[kind] ?? [0.9, 1.1];
    const t = r();
    return {
      scale: lo + (hi - lo) * (kind === 'tree' ? Math.pow(t, 1.35) : t),
      rot: r() * TAU,
      variant: VARIANTS[kind] ? Math.floor(r() * VARIANTS[kind]) : 0,
    };
  };

  const stats = { osmNodes: 0, treeRows: 0, rowTrees: 0, streetTrees: 0, areaTrees: 0, rejected: 0 };

  // --- surveyed point features --------------------------------------------
  for (const el of elements) {
    const t = el.tags || {};
    if (el.type === 'node') {
      const kind = classifyNode(t);
      if (!kind) continue;
      const [x, z] = lonLatToWorld(el.lon, el.lat);
      const j = jitterFor(kind, hash32(`n${el.id}`));
      add(kind, x, sampleGround(x, z), z, j.scale, j.rot, j.variant);
      stats.osmNodes++;
    } else if (el.type === 'way' && t.natural === 'tree_row' && el.geometry) {
      stats.treeRows++;
      // Walk the row at ~8 m, which is roughly the crown spacing of Boston's
      // street plantings.
      let carry = 0;
      const g = el.geometry;
      for (let i = 0; i + 1 < g.length; i++) {
        const [x0, z0] = lonLatToWorld(g[i].lon, g[i].lat);
        const [x1, z1] = lonLatToWorld(g[i + 1].lon, g[i + 1].lat);
        const dx = x1 - x0, dz = z1 - z0;
        const seg = Math.hypot(dx, dz);
        if (seg < 1e-6) continue;
        let d = carry;
        while (d < seg) {
          const u = d / seg;
          const x = x0 + dx * u, z = z0 + dz * u;
          const j = jitterFor('tree', hash32(`r${el.id}:${Math.round(x)}:${Math.round(z)}`));
          add('tree', x, sampleGround(x, z), z, j.scale, j.rot, j.variant);
          stats.rowTrees++;
          d += 8;
        }
        carry = d - seg;
      }
    } else if (el.type === 'way' && el.geometry && el.geometry.length) {
      const kind = classifyNode(t);
      if (!kind) continue;
      // Mapped as an area (a chimney/crane footprint): plant one at its centre.
      let sx = 0, sz = 0, n = 0;
      for (const p of el.geometry) { const [x, z] = lonLatToWorld(p.lon, p.lat); sx += x; sz += z; n++; }
      const x = sx / n, z = sz / n;
      const j = jitterFor(kind, hash32(`w${el.id}`));
      add(kind, x, sampleGround(x, z), z, j.scale, j.rot, j.variant);
      stats.osmNodes++;
    }
  }

  // --- exclusion masks -----------------------------------------------------
  const buildingIdx = new GridIndex(70);
  for (const b of buildings) {
    const bb = bbox(b.outline);
    buildingIdx.insert({ ring: b.outline, bb }, [bb[0] - 1.5, bb[1] - 1.5, bb[2] + 1.5, bb[3] + 1.5]);
  }
  const blockIdx = new GridIndex(120);
  const BLOCKING = new Set(['water', 'river', 'parking', 'runway', 'railyard', 'pier', 'beach', 'sand', 'pitch', 'plaza']);
  for (const a of areas) {
    if (!BLOCKING.has(a.kind)) continue;
    const bb = bbox(a.outline);
    blockIdx.insert({ ring: a.outline, holes: a.holes, bb }, bb);
  }
  const insideAny = (idx, x, z) => {
    for (const it of idx.at(x, z)) {
      if (x < it.bb[0] || x > it.bb[2] || z < it.bb[1] || z > it.bb[3]) continue;
      if (!pointInRing(it.ring, x, z)) continue;
      if (it.holes) { let h = false; for (const hh of it.holes) if (pointInRing(hh, x, z)) h = true; if (h) continue; }
      return true;
    }
    return false;
  };

  // Keep trees out of each other and off the carriageway.
  const treeIdx = new GridIndex(12);
  const existing = byKind.get('tree');
  if (existing) {
    for (let i = 0; i < existing.positions.length; i += 3) {
      const x = existing.positions[i], z = existing.positions[i + 2];
      treeIdx.insert([x, z], [x, z, x, z]);
    }
  }
  const tooClose = (x, z, r) => {
    const r2 = r * r;
    for (const p of treeIdx.near(x, z, r)) {
      const dx = p[0] - x, dz = p[1] - z;
      if (dx * dx + dz * dz < r2) return true;
    }
    return false;
  };
  const { minX, maxX, minZ, maxZ } = WORLD_BOUNDS;
  const plant = (x, z, seedStr, minGap) => {
    if (x < minX + 2 || x > maxX - 2 || z < minZ + 2 || z > maxZ - 2) { stats.rejected++; return false; }
    if (insideAny(buildingIdx, x, z)) { stats.rejected++; return false; }
    if (insideAny(blockIdx, x, z)) { stats.rejected++; return false; }
    if (tooClose(x, z, minGap)) { stats.rejected++; return false; }
    const j = jitterFor('tree', hash32(seedStr));
    add('tree', x, sampleGround(x, z), z, j.scale, j.rot, j.variant);
    treeIdx.insert([x, z], [x, z, x, z]);
    return true;
  };

  // --- synthesised street trees -------------------------------------------
  for (const road of roads) {
    const cfg = TREE_STREETS[road.class];
    if (!cfg || road.bridge || road.tunnel || road.layer !== 0) continue;
    const p = road.path;
    const r = rng(hash32(road.id));
    let carry = r() * cfg.spacing;
    for (let i = 0; i + 3 < p.length; i += 2) {
      const x0 = p[i], z0 = p[i + 1], x1 = p[i + 2], z1 = p[i + 3];
      const dx = x1 - x0, dz = z1 - z0;
      const seg = Math.hypot(dx, dz);
      if (seg < 1e-6) continue;
      const nx = -dz / seg, nz = dx / seg;
      let d = carry;
      while (d < seg) {
        const u = d / seg;
        const bx = x0 + dx * u, bz = z0 + dz * u;
        const nb = neighbourhoodAt(bx, bz);
        const bias = STREET_TREE_BIAS[nb.key] ?? 0.8;
        for (const side of [1, -1]) {
          if (r() > cfg.prob * bias) continue;
          const off = road.width / 2 + cfg.offset + r() * 1.4;
          const x = bx + nx * off * side + (r() - 0.5) * 1.2;
          const z = bz + nz * off * side + (r() - 0.5) * 1.2;
          if (plant(x, z, `st${road.id}:${Math.round(x)}:${Math.round(z)}`, 4.5)) stats.streetTrees++;
        }
        d += cfg.spacing * (0.75 + r() * 0.55);
      }
      carry = Math.max(0, d - seg);
    }
  }

  // --- synthesised park / woodland canopy ---------------------------------
  for (const a of areas) {
    const spacing = AREA_TREE_SPACING[a.kind] ?? 0;
    if (!spacing) continue;
    const bb = bbox(a.outline);
    if ((bb[2] - bb[0]) < spacing || (bb[3] - bb[1]) < spacing) continue;
    const r = rng(hash32(a.id));
    const holes = a.holes;
    for (let z = bb[1] + spacing * 0.5; z < bb[3]; z += spacing) {
      for (let x = bb[0] + spacing * 0.5; x < bb[2]; x += spacing) {
        const px = x + (r() - 0.5) * spacing * 0.8;
        const pz = z + (r() - 0.5) * spacing * 0.8;
        if (r() > (a.kind === 'forest' ? 0.94 : a.kind === 'park' ? 0.72 : 0.5)) continue;
        if (!pointInRing(a.outline, px, pz)) continue;
        if (holes) { let h = false; for (const hh of holes) if (pointInRing(hh, px, pz)) h = true; if (h) continue; }
        if (plant(px, pz, `pk${a.id}:${Math.round(px)}:${Math.round(pz)}`, spacing * 0.42)) stats.areaTrees++;
      }
    }
  }

  const sets = [...byKind.values()].sort((a, b) => b.positions.length - a.positions.length);
  const total = sets.reduce((s, x) => s + x.positions.length / 3, 0);
  log(`  props: ${total} instances across ${sets.length} kinds`);
  log(`    ${sets.map((s) => `${s.kind}=${s.positions.length / 3}`).join(' ')}`);
  log(`    trees: ${stats.osmNodes} surveyed points (all kinds), ${stats.rowTrees} from ${stats.treeRows} tree rows, ` +
      `${stats.streetTrees} synthesised street, ${stats.areaTrees} synthesised canopy, ${stats.rejected} rejected`);
  return { props: sets, stats };
}
