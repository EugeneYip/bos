#!/usr/bin/env node
/**
 * Mean colour of the brightest pixels inside a box.
 *
 * A lamp is a handful of pixels surrounded by dark bodywork, so a rectangular
 * mean measures mostly bodywork and says nothing about the lamp. This
 * thresholds on red and reports the core's channel ratios, which is the
 * question that matters for a tail lamp: a red lens that has been driven so
 * far past the display range that the tone mapper desaturates its core to
 * white is no longer a red lamp. It is the same failure the paint had at
 * high coat gain, from the other side.
 *
 *   node qa/_lampcore.mjs shot.png x y w h [redThreshold]
 */
import { readFile } from 'node:fs/promises';
import { PNG } from 'pngjs';

const [, , src, X, Y, W, H, THR] = process.argv;
const p = PNG.sync.read(await readFile(src));
const thr = Number(THR ?? 140);
let n = 0, r = 0, g = 0, b = 0, white = 0;
for (let y = Number(Y); y < Number(Y) + Number(H); y++) {
  for (let x = Number(X); x < Number(X) + Number(W); x++) {
    if (x < 0 || y < 0 || x >= p.width || y >= p.height) continue;
    const i = (y * p.width + x) * 4;
    if (p.data[i] < thr) continue;
    n++; r += p.data[i]; g += p.data[i + 1]; b += p.data[i + 2];
    // A core pixel that has lost its hue entirely: red pinned and green with
    // it, which on a red lens can only be tone-mapper desaturation.
    if (p.data[i] >= 250 && p.data[i + 1] >= 235) white++;
  }
}
if (!n) { console.log(JSON.stringify({ corePx: 0 })); process.exit(0); }
console.log(JSON.stringify({
  corePx: n, r: +(r / n).toFixed(1), g: +(g / n).toFixed(1), b: +(b / n).toFixed(1),
  gOverR: +(g / r).toFixed(3), bOverR: +(b / r).toFixed(3), hueLostPx: white,
}));
