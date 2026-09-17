/**
 * Average pixel value in a small box, for one or more PNGs and points.
 *
 *   node qa/_px.mjs a.png b.png -- 1165,430 800,560
 *
 * Also prints a whole-frame mean so ratios inside one frame can be compared
 * across builds (absolute luma cannot be: auto-exposure moves).
 */
import { PNG } from 'pngjs';
import fs from 'node:fs';

const argv = process.argv.slice(2);
const cut = argv.indexOf('--');
const files = cut < 0 ? argv : argv.slice(0, cut);
const pts = cut < 0 ? [] : argv.slice(cut + 1);
const R = Number(process.env.R || 3);

function avg(img, x, y, r) {
  let s = [0, 0, 0], n = 0;
  for (let dy = -r; dy <= r; dy++) {
    for (let dx = -r; dx <= r; dx++) {
      const xx = x + dx, yy = y + dy;
      if (xx < 0 || yy < 0 || xx >= img.width || yy >= img.height) continue;
      const i = (yy * img.width + xx) * 4;
      s[0] += img.data[i]; s[1] += img.data[i + 1]; s[2] += img.data[i + 2]; n++;
    }
  }
  return s.map((v) => +(v / n).toFixed(1));
}

for (const f of files) {
  const img = PNG.sync.read(fs.readFileSync(f));
  let tot = 0;
  for (let i = 0; i < img.data.length; i += 4) {
    tot += 0.2126 * img.data[i] + 0.7152 * img.data[i + 1] + 0.0722 * img.data[i + 2];
  }
  const mean = tot / (img.data.length / 4);
  const out = pts.map((c) => {
    const [x, y] = c.split(',').map(Number);
    const a = avg(img, x, y, R);
    const l = 0.2126 * a[0] + 0.7152 * a[1] + 0.0722 * a[2];
    return `${c}=[${a}] L=${l.toFixed(1)} r=${(l / mean).toFixed(2)}`;
  });
  console.log(`${f.replace(/^.*\//, '').padEnd(42)} frameL=${mean.toFixed(2)}  ${out.join('  ')}`);
}
