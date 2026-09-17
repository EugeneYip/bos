/**
 * High-frequency contrast of a region, normalised by its own mean.
 *
 * A tiling lattice is *structure*, so it survives the auto-exposure that makes
 * absolute luma incomparable across builds: subtract a box-blurred copy of the
 * region from itself and the low-frequency shading (sun, shadow, slope) goes
 * with it, leaving the repeat. Dividing by the region mean removes what is
 * left of the exposure.
 *
 *   node qa/_hf.mjs a.png b.png -- 0,600,500,260,lawn
 *
 * Also reports the strongest horizontal and vertical period found by
 * autocorrelation over 4..64 px, which is what distinguishes a repeating
 * lattice from ordinary grain.
 */
import { PNG } from 'pngjs';
import fs from 'node:fs';

const argv = process.argv.slice(2);
const cut = argv.indexOf('--');
const files = argv.slice(0, cut);
const regions = argv.slice(cut + 1).map((s) => s.split(','));
const BLUR = Number(process.env.BLUR || 9);

for (const f of files) {
  const img = PNG.sync.read(fs.readFileSync(f));
  const out = [];
  for (const [xs, ys, ws, hs, label] of regions) {
    const x0 = +xs, y0 = +ys, w = +ws, h = +hs;
    const lum = new Float64Array(w * h);
    let mean = 0;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = ((y0 + y) * img.width + (x0 + x)) * 4;
        const v = 0.2126 * img.data[i] + 0.7152 * img.data[i + 1] + 0.0722 * img.data[i + 2];
        lum[y * w + x] = v;
        mean += v;
      }
    }
    mean /= w * h;
    // Separable box blur, clamped at the edges.
    const tmp = new Float64Array(w * h);
    const hi = new Float64Array(w * h);
    const r = BLUR >> 1;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        let s = 0, n = 0;
        for (let k = -r; k <= r; k++) {
          const xx = Math.min(w - 1, Math.max(0, x + k));
          s += lum[y * w + xx]; n++;
        }
        tmp[y * w + x] = s / n;
      }
    }
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        let s = 0, n = 0;
        for (let k = -r; k <= r; k++) {
          const yy = Math.min(h - 1, Math.max(0, y + k));
          s += tmp[yy * w + x]; n++;
        }
        hi[y * w + x] = lum[y * w + x] - s / n;
      }
    }
    let v2 = 0;
    for (let i = 0; i < hi.length; i++) v2 += hi[i] * hi[i];
    const std = Math.sqrt(v2 / hi.length);

    // Horizontal autocorrelation of the high-pass, normalised.
    const best = (axis) => {
      let bp = 0, bv = -1;
      for (let p = 4; p <= 64; p++) {
        let s = 0, n = 0;
        for (let y = 0; y < h; y++) {
          for (let x = 0; x < w; x++) {
            const xx = axis === 0 ? x + p : x;
            const yy = axis === 0 ? y : y + p;
            if (xx >= w || yy >= h) continue;
            s += hi[y * w + x] * hi[yy * w + xx]; n++;
          }
        }
        const c = s / n / (std * std);
        if (c > bv) { bv = c; bp = p; }
      }
      return `${bp}px:${bv.toFixed(2)}`;
    };
    out.push(`${label} hf=${(std / mean * 100).toFixed(2)}% L=${mean.toFixed(1)}`
      + ` acX=${best(0)} acY=${best(1)}`);
  }
  console.log(`${f.replace(/^.*\//, '').padEnd(40)} ${out.join('  |  ')}`);
}
