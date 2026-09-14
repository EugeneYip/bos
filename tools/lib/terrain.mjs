/**
 * Terrain heightfield from AWS "terrarium" RGB-encoded elevation tiles.
 *   https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png
 *   elevation = (R * 256 + G + B / 256) - 32768
 *
 * Tiles are cached under `.cache/terrain/` (gitignored). The mosaic is resampled
 * bilinearly onto a regular world-metre grid aligned to BOUNDS and lightly
 * smoothed with a separable binomial kernel — enough to kill the ~1 m NED
 * quantisation staircase without touching Boston's (already modest) hills.
 */
import fs from 'node:fs';
import path from 'node:path';
import { PNG } from 'pngjs';
import { BOUNDS, WORLD_BOUNDS, lonLatToTile, worldToLonLat } from './geo.mjs';

const ROOT = path.resolve(import.meta.dirname, '../..');
const CACHE = path.join(ROOT, '.cache/terrain');
const TILE = 256;
const VOID = -1e9;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchTile(z, x, y) {
  const file = path.join(CACHE, String(z), String(x), `${y}.png`);
  if (fs.existsSync(file) && fs.statSync(file).size > 0) return fs.readFileSync(file);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const url = `https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${z}/${x}/${y}.png`;
  let backoff = 1500;
  for (let attempt = 1; attempt <= 7; attempt++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(60_000) });
      if (res.status === 404) { fs.writeFileSync(file, Buffer.alloc(0)); return Buffer.alloc(0); }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const buf = Buffer.from(await res.arrayBuffer());
      fs.writeFileSync(file, buf);
      return buf;
    } catch (err) {
      if (attempt === 7) throw new Error(`terrarium ${z}/${x}/${y}: ${err.message}`);
      await sleep(backoff);
      backoff *= 1.8;
    }
  }
}

/** Download + decode the tile mosaic covering BOUNDS at `zoom`. */
export async function loadMosaic(zoom = 14, pad = 1) {
  const [x0f, y0f] = lonLatToTile(BOUNDS.west, BOUNDS.north, zoom);
  const [x1f, y1f] = lonLatToTile(BOUNDS.east, BOUNDS.south, zoom);
  const tx0 = Math.floor(x0f) - pad, tx1 = Math.floor(x1f) + pad;
  const ty0 = Math.floor(y0f) - pad, ty1 = Math.floor(y1f) + pad;
  const nx = tx1 - tx0 + 1, ny = ty1 - ty0 + 1;
  const W = nx * TILE, H = ny * TILE;
  console.log(`  terrain: z${zoom} tiles x[${tx0}..${tx1}] y[${ty0}..${ty1}] = ${nx * ny} tiles, mosaic ${W}x${H}`);

  const data = new Float32Array(W * H).fill(VOID);
  const jobs = [];
  for (let ty = ty0; ty <= ty1; ty++) {
    for (let tx = tx0; tx <= tx1; tx++) jobs.push([tx, ty]);
  }
  let done = 0;
  const queue = jobs.slice();
  async function worker() {
    for (;;) {
      const job = queue.shift();
      if (!job) return;
      const [tx, ty] = job;
      const buf = await fetchTile(zoom, tx, ty);
      done++;
      if (buf.length === 0) continue;
      const png = PNG.sync.read(buf);
      const ox = (tx - tx0) * TILE, oy = (ty - ty0) * TILE;
      for (let py = 0; py < TILE; py++) {
        const row = (oy + py) * W + ox;
        for (let px = 0; px < TILE; px++) {
          const k = (py * png.width + px) * 4;
          const e = png.data[k] * 256 + png.data[k + 1] + png.data[k + 2] / 256 - 32768;
          data[row + px] = e < -500 ? VOID : e;
        }
      }
    }
  }
  await Promise.all(Array.from({ length: 6 }, worker));
  console.log(`  terrain: ${done} tiles decoded`);
  return { data, W, H, tx0, ty0, zoom };
}

/** Bilinear sample of the mosaic at a lon/lat. Returns 0 over voids. */
function sampleMosaic(m, lon, lat) {
  const [fx, fy] = lonLatToTile(lon, lat, m.zoom);
  // Global pixel coordinates, offset to mosaic space. Tile pixel centres sit at +0.5.
  const gx = (fx - m.tx0) * TILE - 0.5;
  const gy = (fy - m.ty0) * TILE - 0.5;
  const x0 = Math.floor(gx), y0 = Math.floor(gy);
  const dx = gx - x0, dy = gy - y0;
  const cx0 = Math.min(Math.max(x0, 0), m.W - 1), cx1 = Math.min(Math.max(x0 + 1, 0), m.W - 1);
  const cy0 = Math.min(Math.max(y0, 0), m.H - 1), cy1 = Math.min(Math.max(y0 + 1, 0), m.H - 1);
  const a = m.data[cy0 * m.W + cx0], b = m.data[cy0 * m.W + cx1];
  const c = m.data[cy1 * m.W + cx0], d = m.data[cy1 * m.W + cx1];
  if (a === VOID || b === VOID || c === VOID || d === VOID) {
    // fall back to whichever corners are valid
    let s = 0, n = 0;
    for (const v of [a, b, c, d]) if (v !== VOID) { s += v; n++; }
    return n ? s / n : 0;
  }
  return (a * (1 - dx) + b * dx) * (1 - dy) + (c * (1 - dx) + d * dx) * dy;
}

/** Separable 5-tap binomial blur, `passes` times, in place on a copy. */
function smooth(grid, w, h, passes = 1) {
  let src = grid;
  const k = [1 / 16, 4 / 16, 6 / 16, 4 / 16, 1 / 16];
  for (let p = 0; p < passes; p++) {
    const tmp = new Float32Array(w * h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        let s = 0;
        for (let t = -2; t <= 2; t++) {
          const xx = Math.min(w - 1, Math.max(0, x + t));
          s += src[y * w + xx] * k[t + 2];
        }
        tmp[y * w + x] = s;
      }
    }
    const out = new Float32Array(w * h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        let s = 0;
        for (let t = -2; t <= 2; t++) {
          const yy = Math.min(h - 1, Math.max(0, y + t));
          s += tmp[yy * w + x] * k[t + 2];
        }
        out[y * w + x] = s;
      }
    }
    src = out;
  }
  return src;
}

/**
 * Build the world-metre heightfield.
 * Grid post (i,j) sits at x = originX + i*spacingX, z = originZ + j*spacingZ,
 * row-major from the north-west corner (j=0 is the northern edge).
 */
export async function buildHeightfield({ zoom = 14, targetSpacing = 9 } = {}) {
  const m = await loadMosaic(zoom);
  const { minX, minZ, sizeX, sizeZ } = WORLD_BOUNDS;
  const width = Math.round(sizeX / targetSpacing) + 1;
  const height = Math.round(sizeZ / targetSpacing) + 1;
  const spacingX = sizeX / (width - 1);
  const spacingZ = sizeZ / (height - 1);
  console.log(
    `  terrain: grid ${width}x${height} (${spacingX.toFixed(2)}m x ${spacingZ.toFixed(2)}m posts), ` +
    `${((width * height * 4) / 1e6).toFixed(2)} MB raw`,
  );

  const raw = new Float32Array(width * height);
  for (let j = 0; j < height; j++) {
    const z = minZ + j * spacingZ;
    for (let i = 0; i < width; i++) {
      const x = minX + i * spacingX;
      const [lon, lat] = worldToLonLat(x, z);
      raw[j * width + i] = sampleMosaic(m, lon, lat);
    }
  }
  const elevations = smooth(raw, width, height, 1);
  // No land in the modelled extent is below mean sea level, so anything negative
  // is either a void or smoothing overshoot at the shoreline. The water bodies
  // themselves get carved back out by `carveWater` once they are known.
  for (let i = 0; i < elevations.length; i++) if (elevations[i] < 0) elevations[i] = 0;

  return {
    width, height,
    sizeX, sizeZ,
    originX: minX, originZ: minZ,
    spacingX, spacingZ,
    elevations,
  };
}

/** Bilinear terrain lookup in world metres. */
export function makeSampler(t) {
  const { width, height, originX, originZ, spacingX, spacingZ, elevations } = t;
  return function sample(x, z) {
    let fx = (x - originX) / spacingX;
    let fz = (z - originZ) / spacingZ;
    fx = Math.min(Math.max(fx, 0), width - 1.0001);
    fz = Math.min(Math.max(fz, 0), height - 1.0001);
    const i = fx | 0, j = fz | 0;
    const dx = fx - i, dz = fz - j;
    const a = elevations[j * width + i], b = elevations[j * width + i + 1];
    const c = elevations[(j + 1) * width + i], d = elevations[(j + 1) * width + i + 1];
    return (a * (1 - dx) + b * dx) * (1 - dz) + (c * (1 - dx) + d * dx) * dz;
  };
}

/**
 * Push the heightfield down under water polygons so the sea floor sits below the
 * water plane instead of z-fighting with it, with a feathered edge that reads as
 * a shoreline. Even-odd scanline fill, so holes (islands) are excluded for free.
 *
 * @param {{width:number,height:number,originX:number,originZ:number,spacingX:number,spacingZ:number,elevations:Float32Array}} t
 * @param {{outline:number[],holes?:number[][],kind:string}[]} areas
 * @param {number} depth  metres to drop fully-submerged posts
 */
export function carveWater(t, areas, depth = 1.6) {
  const { width, height, originX, originZ, spacingX, spacingZ } = t;
  const mask = new Float32Array(width * height);
  const xs = [];
  let filled = 0;
  for (const a of areas) {
    if (a.kind !== 'water' && a.kind !== 'river') continue;
    const rings = [a.outline, ...(a.holes || [])];
    let minZ = Infinity, maxZ = -Infinity;
    for (let i = 1; i < a.outline.length; i += 2) {
      if (a.outline[i] < minZ) minZ = a.outline[i];
      if (a.outline[i] > maxZ) maxZ = a.outline[i];
    }
    const j0 = Math.max(0, Math.floor((minZ - originZ) / spacingZ));
    const j1 = Math.min(height - 1, Math.ceil((maxZ - originZ) / spacingZ));
    for (let j = j0; j <= j1; j++) {
      const z = originZ + j * spacingZ;
      xs.length = 0;
      for (const ring of rings) {
        const n = ring.length / 2;
        for (let i = 0, k = n - 1; i < n; k = i++) {
          const zi = ring[i * 2 + 1], zk = ring[k * 2 + 1];
          if ((zi > z) !== (zk > z)) {
            xs.push(ring[k * 2] + ((z - zk) / (zi - zk)) * (ring[i * 2] - ring[k * 2]));
          }
        }
      }
      if (xs.length < 2) continue;
      xs.sort((p, q) => p - q);
      for (let s = 0; s + 1 < xs.length; s += 2) {
        const i0 = Math.max(0, Math.ceil((xs[s] - originX) / spacingX));
        const i1 = Math.min(width - 1, Math.floor((xs[s + 1] - originX) / spacingX));
        for (let i = i0; i <= i1; i++) { if (!mask[j * width + i]) filled++; mask[j * width + i] = 1; }
      }
    }
  }
  // Feather: two box passes so the bank slopes over ~4 posts (~36 m).
  let m = mask;
  for (let pass = 0; pass < 2; pass++) {
    const o = new Float32Array(width * height);
    for (let j = 0; j < height; j++) {
      for (let i = 0; i < width; i++) {
        let s = 0, n = 0;
        for (let dj = -1; dj <= 1; dj++) {
          const jj = j + dj; if (jj < 0 || jj >= height) continue;
          for (let di = -1; di <= 1; di++) {
            const ii = i + di; if (ii < 0 || ii >= width) continue;
            s += m[jj * width + ii]; n++;
          }
        }
        o[j * width + i] = s / n;
      }
    }
    m = o;
  }
  for (let i = 0; i < t.elevations.length; i++) t.elevations[i] -= depth * m[i];
  return filled;
}
