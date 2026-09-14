#!/usr/bin/env node
/**
 * Far-field terrain: the land beyond the modelled city.
 *
 * The detailed model stops at a 10.4 x 8.7 km box, and until now the world
 * simply ended there. But Boston sits in a bowl — the Blue Hills rise to
 * 195 m just south of Mattapan (Great Blue Hill is the highest point on the
 * Atlantic coastal plain), the Middlesex Fells sit north of Medford, the
 * Arlington and Belmont drumlins are west, and the harbour islands and the
 * open Atlantic are east. All of it is visible from anywhere high in the
 * city, and none of it was there.
 *
 * This fetches the same AWS terrarium tiles at a much lower zoom over a much
 * larger box, resamples to a coarse world-metre grid, and writes a heightfield
 * the runtime drapes around the detailed city.
 *
 *   node tools/build-far.mjs [--km=130] [--zoom=10] [--size=640]
 */
import fs from 'node:fs';
import path from 'node:path';
import { PNG } from 'pngjs';
import {
  ORIGIN, METERS_PER_DEG_LAT, METERS_PER_DEG_LON, lonLatToTile,
} from './lib/geo.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const CACHE = path.join(ROOT, '.cache/terrain');
const OUT = path.join(ROOT, 'public/data');
const TILE = 256;
const VOID = -1e9;

const arg = (n, d) => {
  const m = process.argv.find((a) => a.startsWith(`--${n}=`));
  return m ? Number(m.split('=')[1]) : d;
};
/** Half-extent of the far box, kilometres. 130 reaches Cape Ann and the Blue Hills. */
const KM = arg('km', 130);
const ZOOM = arg('zoom', 10);
/** Output grid resolution. Distant hills need shape, not detail. */
const SIZE = arg('size', 640);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchTile(z, x, y) {
  const file = path.join(CACHE, String(z), String(x), `${y}.png`);
  if (fs.existsSync(file) && fs.statSync(file).size > 0) return fs.readFileSync(file);
  const url = `https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${z}/${x}/${y}.png`;
  let backoff = 400;
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const res = await fetch(url);
      if (res.status === 404) return Buffer.alloc(0);   // off the edge of the set
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const buf = Buffer.from(await res.arrayBuffer());
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, buf);
      return buf;
    } catch (err) {
      if (attempt === 4) { console.warn(`  ${z}/${x}/${y}: ${err.message}`); return Buffer.alloc(0); }
      await sleep(backoff);
      backoff *= 1.8;
    }
  }
  return Buffer.alloc(0);
}

const halfLat = (KM * 1000) / METERS_PER_DEG_LAT;
const halfLon = (KM * 1000) / METERS_PER_DEG_LON;
const box = {
  west: ORIGIN.lon - halfLon, east: ORIGIN.lon + halfLon,
  south: ORIGIN.lat - halfLat, north: ORIGIN.lat + halfLat,
};

const [x0f, y0f] = lonLatToTile(box.west, box.north, ZOOM);
const [x1f, y1f] = lonLatToTile(box.east, box.south, ZOOM);
const tx0 = Math.floor(x0f), tx1 = Math.floor(x1f);
const ty0 = Math.floor(y0f), ty1 = Math.floor(y1f);
const nx = tx1 - tx0 + 1, ny = ty1 - ty0 + 1;
const W = nx * TILE, H = ny * TILE;
console.log(`far terrain: +/-${KM} km, z${ZOOM}, ${nx}x${ny} = ${nx * ny} tiles -> mosaic ${W}x${H}`);

const mosaic = new Float32Array(W * H).fill(VOID);
const jobs = [];
for (let ty = ty0; ty <= ty1; ty++) for (let tx = tx0; tx <= tx1; tx++) jobs.push([tx, ty]);
let done = 0;
let fetched = 0;
const queue = jobs.slice();
async function worker() {
  for (;;) {
    const job = queue.shift();
    if (!job) return;
    const [tx, ty] = job;
    const cached = fs.existsSync(path.join(CACHE, String(ZOOM), String(tx), `${ty}.png`));
    const buf = await fetchTile(ZOOM, tx, ty);
    done++;
    if (!cached) fetched++;
    if (done % 40 === 0) console.log(`  ${done}/${jobs.length} tiles`);
    if (buf.length === 0) continue;
    let png;
    try { png = PNG.sync.read(buf); } catch { return; }
    const ox = (tx - tx0) * TILE, oy = (ty - ty0) * TILE;
    for (let py = 0; py < TILE; py++) {
      const row = (oy + py) * W + ox;
      for (let px = 0; px < TILE; px++) {
        const k = (py * png.width + px) * 4;
        mosaic[row + px] = png.data[k] * 256 + png.data[k + 1] + png.data[k + 2] / 256 - 32768;
      }
    }
  }
}
await Promise.all(Array.from({ length: 8 }, worker));
console.log(`  ${done} tiles decoded (${fetched} newly fetched)`);

// --- resample onto a regular world-metre grid -------------------------------
const sizeX = 2 * KM * 1000;
const sizeZ = 2 * KM * 1000;
const originX = -KM * 1000;
const originZ = -KM * 1000;
const out = new Float32Array(SIZE * SIZE);
const n = 2 ** ZOOM;

for (let j = 0; j < SIZE; j++) {
  const z = originZ + (j / (SIZE - 1)) * sizeZ;
  const lat = ORIGIN.lat - z / METERS_PER_DEG_LAT;
  for (let i = 0; i < SIZE; i++) {
    const x = originX + (i / (SIZE - 1)) * sizeX;
    const lon = ORIGIN.lon + x / METERS_PER_DEG_LON;
    const [fx, fy] = lonLatToTile(lon, lat, ZOOM);
    // Global pixel space, then into mosaic space. Tile centres sit at +0.5.
    const gx = fx * TILE - tx0 * TILE - 0.5;
    const gy = fy * TILE - ty0 * TILE - 0.5;
    const ix = Math.floor(gx), iy = Math.floor(gy);
    if (ix < 0 || iy < 0 || ix >= W - 1 || iy >= H - 1) { out[j * SIZE + i] = 0; continue; }
    const tx = gx - ix, tz = gy - iy;
    const g = (a, b) => { const v = mosaic[b * W + a]; return v === VOID ? 0 : v; };
    const a = g(ix, iy), b = g(ix + 1, iy), c = g(ix, iy + 1), d = g(ix + 1, iy + 1);
    out[j * SIZE + i] = (a + (b - a) * tx) + ((c + (d - c) * tx) - (a + (b - a) * tx)) * tz;
  }
  void n;
}

// Light smoothing: at this post spacing the tile seams matter more than detail.
const smooth = (grid, passes) => {
  const tmp = new Float32Array(grid.length);
  for (let p = 0; p < passes; p++) {
    for (let j = 0; j < SIZE; j++) for (let i = 0; i < SIZE; i++) {
      const l = grid[j * SIZE + Math.max(i - 1, 0)];
      const r = grid[j * SIZE + Math.min(i + 1, SIZE - 1)];
      tmp[j * SIZE + i] = (l + 2 * grid[j * SIZE + i] + r) / 4;
    }
    for (let j = 0; j < SIZE; j++) for (let i = 0; i < SIZE; i++) {
      const u = tmp[Math.max(j - 1, 0) * SIZE + i];
      const d = tmp[Math.min(j + 1, SIZE - 1) * SIZE + i];
      grid[j * SIZE + i] = (u + 2 * tmp[j * SIZE + i] + d) / 4;
    }
  }
};
smooth(out, 1);

let min = Infinity, max = -Infinity, sea = 0;
for (const v of out) { if (v < min) min = v; if (v > max) max = v; if (v <= 0.5) sea++; }

const spacing = sizeX / (SIZE - 1);
const header = {
  width: SIZE, height: SIZE, sizeX, sizeZ, originX, originZ,
  spacingX: spacing, spacingZ: spacing,
  bin: 'far-terrain.bin', dtype: 'float32', endian: 'little',
  layout: 'row-major from north-west; index = j*width + i; x = originX + i*spacingX, z = originZ + j*spacingZ',
  min, max, seaFraction: sea / out.length,
};
fs.mkdirSync(OUT, { recursive: true });
const buf = Buffer.alloc(out.length * 4);
for (let i = 0; i < out.length; i++) buf.writeFloatLE(out[i], i * 4);
fs.writeFileSync(path.join(OUT, 'far-terrain.bin'), buf);
fs.writeFileSync(path.join(OUT, 'far-terrain.json'), JSON.stringify(header));

console.log(`far terrain: ${SIZE}x${SIZE} @ ${spacing.toFixed(0)} m, ` +
  `${(buf.length / 1048576).toFixed(1)} MB, elevation ${min.toFixed(0)}..${max.toFixed(0)} m, ` +
  `${(100 * sea / out.length).toFixed(0)}% at or below sea level`);

// Sanity: the named hills should be there.
const probe = (name, lat, lon) => {
  const x = (lon - ORIGIN.lon) * METERS_PER_DEG_LON;
  const z = -(lat - ORIGIN.lat) * METERS_PER_DEG_LAT;
  const i = Math.round((x - originX) / spacing);
  const j = Math.round((z - originZ) / spacing);
  const v = (i >= 0 && j >= 0 && i < SIZE && j < SIZE) ? out[j * SIZE + i] : NaN;
  console.log(`  ${name.padEnd(22)} ${v.toFixed(0)} m`);
};
probe('Great Blue Hill', 42.2119, -71.1147);
probe('Middlesex Fells', 42.4450, -71.1020);
probe('Prospect Hill, Waltham', 42.3870, -71.2730);
probe('Wachusett (far west)', 42.4885, -71.8862);
probe('open Atlantic', 42.3000, -70.5000);
