#!/usr/bin/env node
/**
 * Offline geospatial extraction pipeline for the Boston 3D model.
 *
 *   node tools/build-data.mjs
 *
 * Produces `public/data/` conforming to `CityManifest` in src/core/types.ts:
 * a binary terrain heightfield plus sharded JSON for buildings, roads, areas and
 * props, all pre-projected to world metres with core/geo.ts's projection.
 *
 * Sources: OpenStreetMap via Overpass (ODbL) and AWS terrarium elevation tiles.
 * Raw responses are cached under `.cache/` so re-runs are offline and cheap.
 *
 * Flags:
 *   --zoom=14          terrarium zoom level
 *   --spacing=9        terrain post spacing, metres
 *   --out=public/data  output directory
 */
import fs from 'node:fs';
import path from 'node:path';
import { BOUNDS, ORIGIN, WORLD_BOUNDS } from './lib/geo.mjs';
import { stats as netStats } from './lib/overpass.mjs';
import * as Q from './lib/queries.mjs';
import { buildHeightfield, carveWater, makeSampler } from './lib/terrain.mjs';
import { buildCoastWater } from './lib/coastline.mjs';
import { buildAreas } from './lib/areas.mjs';
import { buildRoads } from './lib/roads.mjs';
import { buildBuildings } from './lib/buildings.mjs';
import { buildProps } from './lib/props.mjs';
import { encodeBuildings } from './pack-buildings.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const argv = Object.fromEntries(
  process.argv.slice(2).filter((a) => a.startsWith('--')).map((a) => {
    const [k, v] = a.replace(/^--/, '').split('=');
    return [k, v ?? true];
  }),
);
const OUT = path.resolve(ROOT, argv.out ?? 'public/data');
const ZOOM = Number(argv.zoom ?? 14);
const SPACING = Number(argv.spacing ?? 9);

const t0 = Date.now();
const step = (s) => console.log(`\n[${((Date.now() - t0) / 1000).toFixed(0)}s] ${s}`);

// ---------------------------------------------------------------------------
// Serialisation helpers
// ---------------------------------------------------------------------------

/** Round every number in a flat coordinate array to `d` decimals (cm by default). */
const roundFlat = (arr, d = 2) => {
  const f = 10 ** d;
  const out = new Array(arr.length);
  for (let i = 0; i < arr.length; i++) out[i] = Math.round(arr[i] * f) / f;
  return out;
};

/** Strip pipeline-private `_fields` and round geometry. */
function cleanBuilding(b) {
  return {
    id: b.id,
    outline: roundFlat(b.outline),
    ...(b.holes ? { holes: b.holes.map((h) => roundFlat(h)) } : {}),
    height: b.height,
    minHeight: b.minHeight,
    ground: b.ground,
    levels: b.levels,
    roof: b.roof,
    roofHeight: b.roofHeight,
    material: b.material,
    color: b.color,
    roofColor: b.roofColor,
    ...(b.name ? { name: b.name } : {}),
    ...(b.landmark ? { landmark: b.landmark } : {}),
  };
}
function cleanRoad(r) {
  return {
    id: r.id, class: r.class,
    path: roundFlat(r.path),
    elevation: roundFlat(r.elevation, 1),
    width: r.width, lanes: r.lanes, layer: r.layer,
    bridge: r.bridge, tunnel: r.tunnel, oneway: r.oneway,
    ...(r.name ? { name: r.name } : {}),
    surface: r.surface,
    ...(r.motor ? { motor: r.motor } : {}),
  };
}
function cleanArea(a) {
  return {
    id: a.id, kind: a.kind,
    outline: roundFlat(a.outline),
    ...(a.holes ? { holes: a.holes.map((h) => roundFlat(h)) } : {}),
    elevation: a.elevation, drape: a.drape,
    ...(a.name ? { name: a.name } : {}),
  };
}
function cleanPropSet(p) {
  return {
    kind: p.kind,
    positions: roundFlat(p.positions),
    scales: roundFlat(p.scales, 3),
    rotations: roundFlat(p.rotations, 3),
    ...(p.variants && p.variants.some((v) => v !== 0) ? { variants: p.variants } : {}),
  };
}

const written = [];
function writeJson(name, data) {
  const file = path.join(OUT, name);
  fs.writeFileSync(file, JSON.stringify(data));
  const bytes = fs.statSync(file).size;
  written.push({ name, bytes });
  return name;
}

/** Split a record array across files of at most `per` records each. */
/**
 * Shard spatially, on whole tiles, and report each shard's bounds.
 *
 * `shard` above slices the record array in the order it happens to be in,
 * which puts a building in Charlestown and one in Roslindale in the same
 * file. That is fine when the client loads every shard, and useless the
 * moment it wants to load only what is near the camera -- which is what an
 * iPad needs, since building all 61,574 of them at once is what makes iOS
 * Safari reload the tab.
 *
 * Records are bucketed into the same 500 m tiles the runtime uses, the tiles
 * are walked in Morton order so consecutive shards stay compact, and whole
 * tiles are packed into shards. A tile therefore belongs to exactly one
 * shard, which is what makes unloading one a matter of dropping its tiles
 * rather than rebuilding a neighbour's.
 */
const SHARD_TILE = 500;

function mortonKey(ix, iz) {
  let k = 0;
  for (let b = 0; b < 16; b++) {
    k |= ((ix >> b) & 1) << (2 * b);
    k |= ((iz >> b) & 1) << (2 * b + 1);
  }
  return k;
}

function shardSpatial(prefix, records, per, clean, centroid) {
  const buckets = new Map();
  for (const r of records) {
    const [cx, cz] = centroid(r);
    const ix = Math.floor(cx / SHARD_TILE);
    const iz = Math.floor(cz / SHARD_TILE);
    const key = `${ix},${iz}`;
    const b = buckets.get(key);
    if (b) b.recs.push(r);
    else buckets.set(key, { ix, iz, m: mortonKey(ix + 512, iz + 512), recs: [r] });
  }

  const tiles = [...buckets.values()].sort((a, b) => a.m - b.m);
  const names = [];
  const bounds = [];
  let batch = [];
  let box = null;

  const flush = () => {
    if (!batch.length) return;
    names.push(writeJson(`${prefix}-${String(names.length).padStart(2, '0')}.json`, batch.map(clean)));
    bounds.push([
      Math.round(box[0]), Math.round(box[1]), Math.round(box[2]), Math.round(box[3]),
    ]);
    batch = [];
    box = null;
  };

  for (const t of tiles) {
    const x0 = t.ix * SHARD_TILE, z0 = t.iz * SHARD_TILE;
    const x1 = x0 + SHARD_TILE, z1 = z0 + SHARD_TILE;
    if (batch.length && batch.length + t.recs.length > per) flush();
    batch.push(...t.recs);
    box = box
      ? [Math.min(box[0], x0), Math.min(box[1], z0), Math.max(box[2], x1), Math.max(box[3], z1)]
      : [x0, z0, x1, z1];
  }
  flush();

  const keep = new Set(names);
  for (const f of fs.readdirSync(OUT)) {
    if (new RegExp(`^${prefix}-\\d\\d\\.json$`).test(f) && !keep.has(f)) {
      fs.unlinkSync(path.join(OUT, f));
      console.log(`      swept stale ${f}`);
    }
  }
  const span = bounds.map((b) => Math.round(Math.max(b[2] - b[0], b[3] - b[1])));
  console.log(`  ${prefix}: ${names.length} spatial shards, widest ${Math.max(...span)} m`);
  return { names, bounds };
}

function shard(prefix, records, per, clean) {
  const names = [];
  const n = Math.max(1, Math.ceil(records.length / per));
  const size = Math.ceil(records.length / n);
  for (let i = 0; i < n; i++) {
    const slice = records.slice(i * size, (i + 1) * size).map(clean);
    names.push(writeJson(`${prefix}-${String(i).padStart(2, '0')}.json`, slice));
  }
  // A rebuild that drops records can need fewer shards than the last one, and
  // the surplus files stay on disk. The manifest stops the app loading them, so
  // nothing breaks — they simply ship, megabytes of superseded city that
  // nobody ever reads. Sweep them.
  const keep = new Set(names);
  for (const f of fs.readdirSync(OUT)) {
    if (new RegExp(`^${prefix}-\\d\\d\\.json$`).test(f) && !keep.has(f)) {
      fs.unlinkSync(path.join(OUT, f));
      console.log(`      swept stale ${f}`);
    }
  }
  return names;
}

// ---------------------------------------------------------------------------
// Pipeline
// ---------------------------------------------------------------------------

fs.mkdirSync(OUT, { recursive: true });

step('terrain');
const terrain = await buildHeightfield({ zoom: ZOOM, targetSpacing: SPACING });
let ground = makeSampler(terrain);

step('coastline + areas');
const coastEls = await Q.fetchCoastline();
const coastPolys = buildCoastWater(coastEls.filter((e) => e.type === 'way'), BOUNDS);
const areaEls = await Q.fetchAreas();
const { areas } = buildAreas(areaEls, coastPolys, ground);

step('carving water into the heightfield');
const carved = carveWater(terrain, areas, 1.6);
ground = makeSampler(terrain);
console.log(`  terrain: ${carved} posts submerged (${((100 * carved) / terrain.elevations.length).toFixed(1)}% of the grid)`);

step('roads');
const roadEls = await Q.fetchRoads();
const { roads } = buildRoads(roadEls, ground);

step('buildings');
const bldEls = await Q.fetchBuildings();
const { buildings, stats: bStats } = buildBuildings(bldEls, ground);

step('props');
const propEls = await Q.fetchProps();
const { props } = buildProps(propEls, areas, buildings, roads, ground);

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

step('writing');

// Terrain: raw Float32 little-endian + a JSON sidecar. A 1.1M-post grid as a
// JSON array would be ~10 MB of text and seconds of parse time; the .bin is a
// single typed-array copy.
const binName = 'terrain.bin';
const buf = Buffer.alloc(terrain.elevations.length * 4);
let tMin = Infinity, tMax = -Infinity, tSum = 0;
for (let i = 0; i < terrain.elevations.length; i++) {
  const v = terrain.elevations[i];
  buf.writeFloatLE(v, i * 4);
  if (v < tMin) tMin = v;
  if (v > tMax) tMax = v;
  tSum += v;
}
fs.writeFileSync(path.join(OUT, binName), buf);
written.push({ name: binName, bytes: buf.length });

const terrainMeta = {
  width: terrain.width,
  height: terrain.height,
  sizeX: Math.round(terrain.sizeX * 1000) / 1000,
  sizeZ: Math.round(terrain.sizeZ * 1000) / 1000,
  originX: Math.round(terrain.originX * 1000) / 1000,
  originZ: Math.round(terrain.originZ * 1000) / 1000,
  // Extras beyond TerrainData: everything needed to load the .bin without
  // recomputing anything. spacing* == size* / (dim - 1).
  spacingX: terrain.spacingX,
  spacingZ: terrain.spacingZ,
  bin: binName,
  dtype: 'float32',
  endian: 'little',
  layout: 'row-major from north-west; index = j*width + i; x = originX + i*spacingX, z = originZ + j*spacingZ',
  min: Math.round(tMin * 100) / 100,
  max: Math.round(tMax * 100) / 100,
  mean: Math.round((tSum / terrain.elevations.length) * 100) / 100,
};
const terrainName = writeJson('terrain.json', terrainMeta);

// 1,200 records a shard rather than 9,000. The count is chosen for spatial
// granularity, not file size: at 9,000 the city came out as seven shards
// spanning four to ten kilometres each, so a 2.6 km streaming radius reached
// nearly all of them and nothing was saved.
// Buildings ship packed, not as JSON: 16.56 MB -> 5.96 MB for the same 61,597
// records, and no `JSON.parse` object graph on the client. `shardSpatial`
// still writes the JSON (it is the readable source of truth for the packer and
// for diffing a data change), and `packBuildingShards` below converts each one
// and rewrites the manifest entry. See tools/pack-buildings.mjs.
const buildingShards = shardSpatial('buildings', buildings, 1200, cleanBuilding, (b) => {
  // The centre of the outline's bounding box, which is exactly what
  // `buildShard` buckets on at runtime. The two have to agree: if a record
  // lands in a tile outside its own shard's reported bounds, the client can
  // decide that shard is far away and unload a tile that is under the camera.
  const o = b.outline;
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (let i = 0; i < o.length; i += 2) {
    if (o[i] < minX) minX = o[i];
    if (o[i] > maxX) maxX = o[i];
    if (o[i + 1] < minZ) minZ = o[i + 1];
    if (o[i + 1] > maxZ) maxZ = o[i + 1];
  }
  return [(minX + maxX) * 0.5, (minZ + maxZ) * 0.5];
});
// Convert each shard to the packed form and hand the manifest those names.
// The JSON stays on disk as the readable source; only the .bin is fetched.
const buildingFiles = buildingShards.names.map((name) => {
  const src = JSON.parse(fs.readFileSync(path.join(OUT, name), 'utf8'));
  const bin = encodeBuildings(src);
  const out = name.replace(/\.json$/, '.bin');
  fs.writeFileSync(path.join(OUT, out), Buffer.from(bin));
  written.push({ name: out, bytes: bin.byteLength });
  return out;
});
{
  const j = buildingShards.names.reduce((a, n) => a + fs.statSync(path.join(OUT, n)).size, 0);
  const b = buildingFiles.reduce((a, n) => a + fs.statSync(path.join(OUT, n)).size, 0);
  console.log(`  buildings: packed ${(j / 1048576).toFixed(2)} MB of JSON -> `
    + `${(b / 1048576).toFixed(2)} MB of .bin (${(100 * b / j).toFixed(0)}%)`);
}
const roadFiles = shard('roads', roads, 12000, cleanRoad);
const areaFiles = shard('areas', areas, 6000, cleanArea);
// Trees dwarf everything else, so they get their own shard(s) and the long tail
// of street furniture shares one file.
const treeSets = props.filter((p) => p.kind === 'tree');
const otherSets = props.filter((p) => p.kind !== 'tree');
const propFiles = [];
for (const [i, s] of treeSets.entries()) propFiles.push(writeJson(`props-trees-${i}.json`, [cleanPropSet(s)]));
if (otherSets.length) propFiles.push(writeJson('props-misc.json', otherSets.map(cleanPropSet)));

const attribution = [
  'Map data © OpenStreetMap contributors, available under the Open Database License (ODbL) v1.0 — https://www.openstreetmap.org/copyright',
  'Elevation data: Terrarium RGB tiles from the AWS Open Data "elevation-tiles-prod" bucket (Mapzen/Tilezen), derived from USGS 3DEP/NED, NOAA and SRTM sources, public domain.',
];

const treeCount = props.filter((p) => p.kind === 'tree').reduce((s, p) => s + p.positions.length / 3, 0);
const manifest = {
  version: 1,
  generated: new Date().toISOString(),
  bounds: { south: BOUNDS.south, west: BOUNDS.west, north: BOUNDS.north, east: BOUNDS.east },
  origin: { lat: ORIGIN.lat, lon: ORIGIN.lon },
  attribution,
  counts: {
    buildings: buildings.length,
    buildingHoles: buildings.reduce((s, b) => s + (b.holes ? b.holes.length : 0), 0),
    landmarks: buildings.filter((b) => b.landmark).length,
    roads: roads.length,
    roadKm: Math.round(roads.reduce((s, r) => s + r._len, 0) / 1000),
    areas: areas.length,
    props: props.reduce((s, p) => s + p.positions.length / 3, 0),
    trees: treeCount,
    terrainPosts: terrain.width * terrain.height,
  },
  files: {
    terrain: terrainName,
    buildings: buildingFiles,
    roads: roadFiles,
    areas: areaFiles,
    props: propFiles,
  },
  /**
   * Axis-aligned world bounds of each building shard, [x0, z0, x1, z1].
   * Lets the client load only the shards near the camera.
   */
  shardBounds: { buildings: buildingShards.bounds },
  // Additive metadata; the runtime may ignore all of it.
  world: {
    minX: Math.round(WORLD_BOUNDS.minX * 100) / 100,
    maxX: Math.round(WORLD_BOUNDS.maxX * 100) / 100,
    minZ: Math.round(WORLD_BOUNDS.minZ * 100) / 100,
    maxZ: Math.round(WORLD_BOUNDS.maxZ * 100) / 100,
  },
  landmarkIds: Object.fromEntries(
    buildings.filter((b) => b.landmark).map((b) => [b.landmark, b.id]),
  ),
};
writeJson('manifest.json', manifest);

fs.writeFileSync(path.join(OUT, 'ATTRIBUTION.md'), `# Data attribution

Everything in this directory is derived data. Redistribution of the model must
carry the notices below.

## OpenStreetMap — Open Database License (ODbL) v1.0

Building footprints, heights, materials, roads, railways, water bodies, parks,
land use, the coastline and all point features (trees, street furniture,
landmarks) are derived from **OpenStreetMap**.

> Map data © OpenStreetMap contributors, available under the
> [Open Database License](https://opendatacommons.org/licenses/odbl/) (ODbL) v1.0.
> See <https://www.openstreetmap.org/copyright>.

ODbL is a share-alike licence. Any **Derivative Database** produced from this data
must be offered under ODbL, and any **Produced Work** (for example a rendered
image or an interactive 3D scene) must carry the attribution above in a place
users can find it.

Retrieved via the public Overpass API (${new Date().toISOString().slice(0, 10)}).

## Elevation — AWS Open Data "elevation-tiles-prod" (public domain)

Terrain is decoded from Terrarium RGB tiles served from
\`s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png\` (the
Mapzen/Tilezen elevation tile set, now hosted by the AWS Open Data programme).
The underlying measurements come from USGS 3DEP/NED, NOAA coastal DEMs and SRTM,
all of which are in the public domain. No attribution is legally required, but
crediting the source is customary:

> Elevation data courtesy of the U.S. Geological Survey, NOAA and NASA, via the
> Mapzen/Tilezen terrain tiles hosted on AWS Open Data.

## Synthesised content

Street trees and park canopy beyond what OpenStreetMap records, and the
neighbourhood-derived building materials, colours and heights used where OSM
carries no tag, are generated by \`tools/build-data.mjs\`. They are plausible,
deterministic inventions — not survey data — and must not be treated as such.
`);
written.push({
  name: 'ATTRIBUTION.md',
  bytes: fs.statSync(path.join(OUT, 'ATTRIBUTION.md')).size,
});

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

step('done');
let total = 0;
for (const w of written.sort((a, b) => b.bytes - a.bytes)) {
  total += w.bytes;
  console.log(`  ${(w.bytes / 1e6).toFixed(2).padStart(8)} MB  ${w.name}`);
}
console.log(`  ${(total / 1e6).toFixed(2).padStart(8)} MB  TOTAL (${written.length} files)`);
console.log(
  `\nOverpass: ${netStats.cacheHits} cache hits, ${netStats.fetches} network fetches, ` +
  `${netStats.retries} retries`,
);
if (netStats.oldest) {
  console.log(
    `OSM base timestamps: ${new Date(netStats.oldest).toISOString()} .. ${new Date(netStats.newest).toISOString()}`,
  );
}
console.log(`landmarks tagged: ${[...bStats.landmarks.entries()].map(([k, v]) => `${k}(${v})`).join(', ') || 'none'}`);
console.log(`\nRun \`node tools/verify-data.mjs\` for the full quality report.`);
