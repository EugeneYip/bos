/**
 * Census of the bright tail inside a region.
 *
 * Boats move between frames, so a wake never lands in the same rectangle
 * twice and a fixed-rect mean cannot measure one. What is stable is the
 * *distribution*: how many pixels of a water band sit far above the water
 * around them, and how bright the brightest of them are.
 *
 *   node qa/_w_bright.mjs shot.png x,y,w,h [threshold]
 */
import fs from 'node:fs';
import { PNG } from 'pngjs';

const [, , file, rect, thrArg] = process.argv;
const [x0, y0, w, h] = rect.split(',').map(Number);
const p = PNG.sync.read(fs.readFileSync(file));
const L = (i) => 0.2126 * p.data[i] + 0.7152 * p.data[i + 1] + 0.0722 * p.data[i + 2];

const vals = [];
for (let y = y0; y < Math.min(y0 + h, p.height); y++) {
  for (let x = x0; x < Math.min(x0 + w, p.width); x++) vals.push(L((y * p.width + x) * 4));
}
vals.sort((a, b) => a - b);
const q = (f) => vals[Math.min(vals.length - 1, Math.floor(vals.length * f))];
const med = q(0.5);
const thr = thrArg ? Number(thrArg) : med * 2;
const over = vals.filter((v) => v > thr);
console.log(
  `${file.split('/').pop().padEnd(28)} n=${vals.length}`
  + `  med ${med.toFixed(1)}  p99 ${q(0.99).toFixed(1)}  p99.9 ${q(0.999).toFixed(1)}`
  + `  max ${vals[vals.length - 1].toFixed(0)}`
  + `  >${thr.toFixed(0)}: ${over.length} px (${(100 * over.length / vals.length).toFixed(2)}%)`
  + `  mean-of-those ${(over.reduce((s, v) => s + v, 0) / Math.max(over.length, 1)).toFixed(1)}`,
);
