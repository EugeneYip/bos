/** High-frequency energy of a presented frame: mean |laplacian| of luma.
 *
 * Same metric as qa/crit2/_sparkband.mjs, which is what the critic used to
 * measure that the low-resolution path loses 72-76% of the detail. Kept
 * separate because this one is about the *whole* frame and reports a
 * mean-normalised figure too: auto-exposure can settle a shade differently
 * between runs, and |laplacian| scales with overall brightness.
 *
 *   node qa/respath/_hf.mjs qa/respath/shots/charles-water--{before,after}.png
 *
 * Images must be the same dimensions to be comparable -- shoot both at the
 * same DPR and CSS size.
 */
import fs from 'node:fs';
import { PNG } from 'pngjs';

const BANDS = [['top', 0.05, 0.35], ['mid', 0.35, 0.65], ['low', 0.65, 0.95]];
const rows = [];

console.log('file'.padEnd(34) + ' size        band  hf      hf/mean  sd     mean');
for (const f of process.argv.slice(2)) {
  if (!fs.existsSync(f)) { console.log(f, 'missing'); continue; }
  const a = PNG.sync.read(fs.readFileSync(f));
  const W = a.width, H = a.height;
  const L = (x, y) => { const i = (y * W + x) * 4; return 0.2126 * a.data[i] + 0.7152 * a.data[i + 1] + 0.0722 * a.data[i + 2]; };
  const one = (y0, y1) => {
    let n = 0, hf = 0, s = 0, s2 = 0;
    for (let y = Math.max(1, y0); y < Math.min(H - 1, y1); y++) {
      for (let x = 1; x < W - 1; x++) {
        const c = L(x, y);
        hf += Math.abs(4 * c - L(x - 1, y) - L(x + 1, y) - L(x, y - 1) - L(x, y + 1));
        s += c; s2 += c * c; n++;
      }
    }
    const mu = s / n;
    return { hf: hf / n, mean: mu, sd: Math.sqrt(Math.max(0, s2 / n - mu * mu)) };
  };
  const name = f.split('/').pop();
  const all = one(1, H - 1);
  rows.push({ file: name, w: W, h: H, band: 'all', ...all });
  console.log(`${name.padEnd(34)} ${`${W}x${H}`.padEnd(11)} ${'all'.padEnd(5)} `
    + `${all.hf.toFixed(3).padStart(7)} ${(all.hf / all.mean).toFixed(4).padStart(8)} ${all.sd.toFixed(2).padStart(6)} ${all.mean.toFixed(1).padStart(6)}`);
  for (const [nm, f0, f1] of BANDS) {
    const r = one(Math.round(H * f0), Math.round(H * f1));
    rows.push({ file: name, w: W, h: H, band: nm, ...r });
    console.log(`${''.padEnd(34)} ${''.padEnd(11)} ${nm.padEnd(5)} `
      + `${r.hf.toFixed(3).padStart(7)} ${(r.hf / r.mean).toFixed(4).padStart(8)} ${r.sd.toFixed(2).padStart(6)} ${r.mean.toFixed(1).padStart(6)}`);
  }
}

// Pair up <id>--before / <id>--after and report the delta that matters.
const key = (r) => `${r.file.replace(/--[a-z0-9]+\.png$/, '')}|${r.band}`;
const before = new Map(rows.filter((r) => /--before\d*\.png$/.test(r.file)).map((r) => [key(r), r]));
const after = rows.filter((r) => /--after\d*\.png$/.test(r.file));
if (before.size && after.length) {
  console.log('\npose                       band  hf before -> after      delta');
  for (const r of after) {
    const b = before.get(key(r));
    if (!b) continue;
    const d = (r.hf / b.hf - 1) * 100;
    console.log(`${key(r).split('|')[0].padEnd(26)} ${r.band.padEnd(5)} `
      + `${b.hf.toFixed(3).padStart(8)} -> ${r.hf.toFixed(3).padStart(8)}   ${(d >= 0 ? '+' : '') + d.toFixed(1)}%`
      + (b.w !== r.w || b.h !== r.h ? `   !! size ${b.w}x${b.h} vs ${r.w}x${r.h}` : ''));
  }
}
