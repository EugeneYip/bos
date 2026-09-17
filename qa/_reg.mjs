#!/usr/bin/env node
/**
 * Mean RGB and luma of named rectangles in one or more PNGs.
 *
 *   node qa/_reg.mjs a.png b.png -- lawn:100,640,400,200 sky:760,60,60,40
 *
 * Prints each region and, for every pair of regions, their luma ratio — the
 * only quantity that survives a change in auto-exposure, which moves under
 * every edit. A whole-frame mean is printed for the same reason.
 */
import { PNG } from 'pngjs';
import fs from 'node:fs';

const argv = process.argv.slice(2);
const cut = argv.indexOf('--');
const files = cut < 0 ? argv : argv.slice(0, cut);
const specs = cut < 0 ? [] : argv.slice(cut + 1);

const lum = (r, g, b) => 0.2126 * r + 0.7152 * g + 0.0722 * b;

function region(img, x0, y0, w, h) {
  let r = 0, g = 0, b = 0, n = 0;
  for (let y = Math.max(0, y0); y < Math.min(y0 + h, img.height); y++) {
    for (let x = Math.max(0, x0); x < Math.min(x0 + w, img.width); x++) {
      const i = (y * img.width + x) * 4;
      r += img.data[i]; g += img.data[i + 1]; b += img.data[i + 2]; n++;
    }
  }
  return { r: r / n, g: g / n, b: b / n, luma: lum(r / n, g / n, b / n) };
}

for (const f of files) {
  const img = PNG.sync.read(fs.readFileSync(f));
  const all = region(img, 0, 0, img.width, img.height);
  console.log(`\n== ${f}  frame luma ${all.luma.toFixed(2)}`);
  const out = [];
  for (const s of specs) {
    const [name, box] = s.includes(':') ? s.split(':') : [s, s];
    const [x, y, w, h] = box.split(',').map(Number);
    const v = region(img, x, y, w, h);
    out.push({ name, v });
    console.log(
      `  ${name.padEnd(14)} rgb ${v.r.toFixed(1).padStart(6)} ${v.g.toFixed(1).padStart(6)} `
      + `${v.b.toFixed(1).padStart(6)}   luma ${v.luma.toFixed(2).padStart(6)}`
      + `   /frame ${(v.luma / all.luma).toFixed(3)}`,
    );
  }
  if (out.length > 1) {
    const base = out[0];
    for (const o of out.slice(1)) {
      console.log(`  ratio ${o.name}/${base.name} = ${(o.v.luma / base.v.luma).toFixed(3)}`);
    }
  }
}
