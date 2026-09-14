#!/usr/bin/env node
/**
 * Warms `.cache/osm/` with every Overpass tile the build needs. Safe to re-run:
 * cached tiles are skipped, so an interrupted run resumes where it left off.
 * `tools/build-data.mjs` calls the same functions and will hit the cache.
 */
import { stats } from './lib/overpass.mjs';
import * as Q from './lib/queries.mjs';

const t0 = Date.now();
const only = process.argv.slice(2).filter((a) => !a.startsWith('-'));
const want = (n) => only.length === 0 || only.includes(n);

const out = {};
if (want('coast')) { console.log('[coastline]'); out.coast = await Q.fetchCoastline(); }
if (want('areas')) { console.log('[areas]'); out.areas = await Q.fetchAreas(); }
if (want('props')) { console.log('[props]'); out.props = await Q.fetchProps(); }
if (want('roads')) { console.log('[roads]'); out.roads = await Q.fetchRoads(); }
if (want('buildings')) { console.log('[buildings]'); out.buildings = await Q.fetchBuildings(); }

for (const [k, v] of Object.entries(out)) console.log(`${k.padEnd(10)} ${v.length} elements`);
console.log(
  `cache hits ${stats.cacheHits}, network ${stats.fetches}, retries ${stats.retries}, ` +
  `${(stats.bytes / 1e6).toFixed(1)} MB, ${((Date.now() - t0) / 1000).toFixed(0)}s`,
);
