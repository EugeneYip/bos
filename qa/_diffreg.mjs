/**
 * Region metrics between two frames of the same session.
 *
 *   node qa/_diffreg.mjs base.png notrees.png -- 620,430,340,200,common 150,250,340,200,cambridge
 *
 * Reports, per region: mean luma of each frame, the mean absolute difference,
 * the share of pixels that moved by more than 3/255, and the mean green
 * excess (G - (R+B)/2) of the first frame. "How much canopy reads" is the
 * combination of the last three: a canopy that is present but grey, or green
 * but only over 2 % of the pixels, is not a canopy.
 */
import { PNG } from 'pngjs';
import fs from 'node:fs';

const argv = process.argv.slice(2);
const cut = argv.indexOf('--');
const [fa, fb] = argv.slice(0, cut);
const regions = argv.slice(cut + 1).map((s) => s.split(','));
const A = PNG.sync.read(fs.readFileSync(fa));
const B = PNG.sync.read(fs.readFileSync(fb));
const L = (d, i) => 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];

for (const [xs, ys, ws, hs, label] of regions) {
  const x0 = +xs, y0 = +ys, w = +ws, h = +hs;
  let la = 0, lb = 0, dsum = 0, moved = 0, green = 0, n = 0;
  for (let y = y0; y < y0 + h; y++) {
    for (let x = x0; x < x0 + w; x++) {
      const i = (y * A.width + x) * 4;
      const a = L(A.data, i), b = L(B.data, i);
      la += a; lb += b; dsum += Math.abs(a - b);
      if (Math.abs(a - b) > 3) moved++;
      green += A.data[i + 1] - (A.data[i] + A.data[i + 2]) / 2;
      n++;
    }
  }
  console.log(`${String(label).padEnd(12)} L(a)=${(la / n).toFixed(1)} L(b)=${(lb / n).toFixed(1)}`
    + `  meanAbsD=${(dsum / n).toFixed(2)}  moved>3=${((moved / n) * 100).toFixed(1)}%`
    + `  greenExcess=${(green / n).toFixed(2)}`);
}
