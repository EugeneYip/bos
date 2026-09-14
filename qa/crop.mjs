#!/usr/bin/env node
/**
 * Crop (and optionally magnify) a region of a PNG so a reviewer can read it at
 * 1:1. Most material defects hide below the thumbnail.
 *
 *   node qa/crop.mjs qa/shots/mat/brick.png 560 0 560 480 out.png [zoom]
 */
import { readFile, writeFile } from 'node:fs/promises';
import { PNG } from 'pngjs';

const [, , src, xs, ys, ws, hs, dst, zs] = process.argv;
const x0 = Number(xs), y0 = Number(ys), w = Number(ws), h = Number(hs);
const zoom = Math.max(1, Math.round(Number(zs ?? 1)));

const png = PNG.sync.read(await readFile(src));
const out = new PNG({ width: w * zoom, height: h * zoom });
for (let y = 0; y < h * zoom; y++) {
  for (let x = 0; x < w * zoom; x++) {
    const sx = Math.min(png.width - 1, x0 + Math.floor(x / zoom));
    const sy = Math.min(png.height - 1, y0 + Math.floor(y / zoom));
    const si = (sy * png.width + sx) * 4;
    const di = (y * out.width + x) * 4;
    out.data[di] = png.data[si];
    out.data[di + 1] = png.data[si + 1];
    out.data[di + 2] = png.data[si + 2];
    out.data[di + 3] = 255;
  }
}
await writeFile(dst, PNG.sync.write(out));
console.log(`[crop] ${src} ${x0},${y0} ${w}x${h} x${zoom} -> ${dst}`);
