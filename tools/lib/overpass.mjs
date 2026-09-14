/**
 * Tiled, cached, rate-limit-tolerant Overpass client.
 *
 * Every raw tile response is written to `.cache/osm/` (gitignored) keyed by a hash
 * of the exact query text, so re-runs never touch the network and we never hammer
 * the public endpoints. Delete `.cache/osm` to force a refetch.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const ROOT = path.resolve(import.meta.dirname, '../..');
export const CACHE_DIR = path.join(ROOT, '.cache/osm');

const ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.osm.ch/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
];

const POLITE_DELAY_MS = 1200;
const MAX_ATTEMPTS = 10;

let lastRequestAt = 0;
let endpointCursor = 0;
export const stats = { cacheHits: 0, fetches: 0, retries: 0, bytes: 0 };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function cachePath(key, query) {
  const h = crypto.createHash('sha1').update(query).digest('hex').slice(0, 12);
  return path.join(CACHE_DIR, `${key}.${h}.json`);
}

/**
 * Some public mirrors answer with a syntactically valid but *empty* document
 * (`timestamp_osm_base: "34"`, zero elements) when their database is not loaded.
 * Silently caching those would punch holes in the city, so every response — fresh
 * or cached — must carry a plausible OSM base timestamp.
 */
function validate(json) {
  const ts = json && json.osm3s && json.osm3s.timestamp_osm_base;
  if (!ts) throw new Error('response has no osm3s.timestamp_osm_base');
  const t = Date.parse(ts);
  if (!Number.isFinite(t) || t < Date.parse('2020-01-01')) {
    throw new Error(`bogus timestamp_osm_base ${JSON.stringify(ts)} (mirror has no data loaded)`);
  }
  if (!Array.isArray(json.elements)) throw new Error('response has no elements array');
  return t;
}

/**
 * Run one Overpass query. Returns the parsed `{ elements: [...] }` object.
 * @param {string} key   human-readable cache key, e.g. `bld_z0_x03_y02`
 * @param {string} query full Overpass QL
 */
export async function overpass(key, query) {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  const file = cachePath(key, query);
  if (fs.existsSync(file)) {
    try {
      const txt = fs.readFileSync(file, 'utf8');
      const json = JSON.parse(txt);
      validate(json);
      stats.cacheHits++;
      stats.bytes += txt.length;
      return json;
    } catch (e) {
      console.log(`    ${key}: discarding bad cache entry (${e.message})`);
      fs.rmSync(file, { force: true }); // corrupt/empty cache entry -> refetch
    }
  }

  let backoff = 4000;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const url = ENDPOINTS[endpointCursor % ENDPOINTS.length];
    const wait = POLITE_DELAY_MS - (Date.now() - lastRequestAt);
    if (wait > 0) await sleep(wait);
    lastRequestAt = Date.now();
    const t0 = Date.now();
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'User-Agent': 'boston-3d/1.0 (offline city extraction; contact via github)',
          'Accept-Encoding': 'gzip, deflate',
        },
        body: 'data=' + encodeURIComponent(query),
        signal: AbortSignal.timeout(300_000),
      });
      if (res.status === 429 || res.status === 504 || res.status === 503 || res.status === 502) {
        throw new Error(`HTTP ${res.status}`);
      }
      if (!res.ok) throw new Error(`HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
      const txt = await res.text();
      if (txt.includes('<remark>') || txt.trimStart().startsWith('<')) {
        throw new Error(`server remark: ${txt.slice(0, 200)}`);
      }
      const json = JSON.parse(txt);
      if (json.remark) throw new Error(`remark: ${json.remark}`);
      const baseTs = validate(json);
      fs.writeFileSync(file, txt);
      stats.fetches++;
      stats.bytes += txt.length;
      stats.oldest = Math.min(stats.oldest ?? baseTs, baseTs);
      stats.newest = Math.max(stats.newest ?? baseTs, baseTs);
      const secs = ((Date.now() - t0) / 1000).toFixed(1);
      process.stdout.write(
        `    ${key}: ${json.elements.length} elements, ${(txt.length / 1e6).toFixed(2)} MB, ${secs}s ` +
        `[${new URL(url).hostname}]\n`,
      );
      // Round-robin endpoints on success too, to spread the load.
      endpointCursor++;
      return json;
    } catch (err) {
      stats.retries++;
      endpointCursor++;
      const msg = String(err && err.message ? err.message : err).slice(0, 140);
      if (attempt === MAX_ATTEMPTS) throw new Error(`${key}: gave up after ${attempt}: ${msg}`);
      process.stdout.write(`    ${key}: attempt ${attempt} failed (${msg}); retry in ${(backoff / 1000) | 0}s\n`);
      await sleep(backoff + Math.random() * 1000);
      backoff = Math.min(backoff * 1.8, 120_000);
    }
  }
  throw new Error('unreachable');
}

/** Split a lat/lon bbox into a grid of cells no larger than `step` degrees. */
export function tileBBox(bounds, stepLat, stepLon = stepLat) {
  const nx = Math.ceil((bounds.east - bounds.west) / stepLon);
  const ny = Math.ceil((bounds.north - bounds.south) / stepLat);
  const dx = (bounds.east - bounds.west) / nx;
  const dy = (bounds.north - bounds.south) / ny;
  const out = [];
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      out.push({
        i, j,
        south: bounds.south + j * dy,
        north: bounds.south + (j + 1) * dy,
        west: bounds.west + i * dx,
        east: bounds.west + (i + 1) * dx,
      });
    }
  }
  return out;
}

export const bboxStr = (b) =>
  `${b.south.toFixed(6)},${b.west.toFixed(6)},${b.north.toFixed(6)},${b.east.toFixed(6)}`;

/**
 * Fetch a themed query across a tiling of `bounds`, de-duplicating elements by
 * type+id (ways straddling a tile edge come back in both tiles).
 * @param {string} prefix          cache-key prefix
 * @param {object} bounds
 * @param {number} step            tile size in degrees
 * @param {(bbox:string)=>string} build  builds the QL for one tile
 */
export async function fetchTiled(prefix, bounds, step, build, { concurrency = 2 } = {}) {
  const tiles = tileBBox(bounds, step);
  console.log(`  ${prefix}: ${tiles.length} tiles of ${step}deg`);
  const seen = new Map();
  let done = 0;
  const queue = tiles.slice();

  async function worker() {
    for (;;) {
      const t = queue.shift();
      if (!t) return;
      const key = `${prefix}_x${String(t.i).padStart(2, '0')}_y${String(t.j).padStart(2, '0')}`;
      const json = await overpass(key, build(bboxStr(t)));
      for (const el of json.elements) {
        const id = `${el.type[0]}${el.id}`;
        if (!seen.has(id)) seen.set(id, el);
      }
      done++;
      if (done % 10 === 0 || done === tiles.length) {
        console.log(`  ${prefix}: ${done}/${tiles.length} tiles, ${seen.size} unique elements`);
      }
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, concurrency) }, worker));
  return [...seen.values()];
}
