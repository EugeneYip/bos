/**
 * Region statistics for water QA.
 *
 * Absolute luma is not comparable across builds (auto-exposure moves), so
 * this prints a *ratio* column as well: the region's mean luma over the mean
 * luma of a reference region named "ref", when one is given. Ratios within
 * one frame are the only thing that survives a rebuild.
 *
 *   node qa/_w_stats.mjs shot.png 'name:x,y,w,h' 'ref:x,y,w,h' ...
 */
import fs from 'node:fs';
import { PNG } from 'pngjs';

const [, , file, ...specs] = process.argv;
const p = PNG.sync.read(fs.readFileSync(file));
const L = (i) => 0.2126 * p.data[i] + 0.7152 * p.data[i + 1] + 0.0722 * p.data[i + 2];

function stats(x0, y0, w, h) {
  const vals = [];
  let r = 0, g = 0, b = 0, n = 0, contrast = 0;
  for (let y = y0; y < Math.min(y0 + h, p.height); y++) {
    for (let x = x0; x < Math.min(x0 + w, p.width); x++) {
      const i = (y * p.width + x) * 4;
      vals.push(L(i));
      r += p.data[i]; g += p.data[i + 1]; b += p.data[i + 2]; n++;
      if (x + 1 < p.width) contrast += Math.abs(L(i) - L(i + 4));
    }
  }
  vals.sort((a, c) => a - c);
  const mean = vals.reduce((s, v) => s + v, 0) / vals.length;
  return {
    mean, med: vals[vals.length >> 1], p05: vals[Math.floor(vals.length * 0.05)],
    p95: vals[Math.floor(vals.length * 0.95)], max: vals[vals.length - 1],
    rgb: [r / n, g / n, b / n], contrast: contrast / n, n,
  };
}

const out = [];
for (const s of specs) {
  const [name, rect] = s.split(':');
  const [x, y, w, h] = rect.split(',').map(Number);
  out.push([name, stats(x, y, w, h)]);
}
const ref = out.find(([n]) => n === 'ref')?.[1];
console.log(file.split('/').pop());
for (const [name, v] of out) {
  console.log(
    `  ${name.padEnd(12)} mean ${v.mean.toFixed(1).padStart(6)}  med ${v.med.toFixed(1).padStart(6)}`
    + `  p05 ${v.p05.toFixed(1).padStart(6)}  p95 ${v.p95.toFixed(1).padStart(6)}  max ${v.max.toFixed(0).padStart(4)}`
    + `  rgb ${v.rgb.map((c) => c.toFixed(0).padStart(3)).join(',')}`
    + `  dx ${v.contrast.toFixed(2).padStart(5)}`
    + (ref ? `  ratio ${(v.mean / ref.mean).toFixed(3)}` : ''),
  );
}
