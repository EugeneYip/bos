#!/usr/bin/env node
/**
 * Region and mask statistics over a screenshot.
 *
 * Two screenshots of this city are never comparable pixel-for-pixel — the
 * traffic has moved and the post chain is stochastic — so every claim about
 * a render has to be a *distribution* over a region, or a ratio between two
 * regions of the same frame.
 *
 *   node qa/_pxstats.mjs rect  shot.png x y w h
 *   node qa/_pxstats.mjs ratio shot.png x1 y1 w1 h1 x2 y2 w2 h2
 *   node qa/_pxstats.mjs dead  shot.png [y0]      # near-monochrome pixels
 *
 * 'dead' counts pixels whose green and blue have collapsed to nothing while
 * red has not — the signature of a surface lit only by a tinted diffuse term
 * with no achromatic specular anywhere, which is what defect #6 measured on
 * the vans at night.
 */
import { readFile } from 'node:fs/promises';
import { PNG } from 'pngjs';

const [, , mode, src, ...rest] = process.argv;
const png = PNG.sync.read(await readFile(src));
const at = (x, y) => (y * png.width + x) * 4;

function rect(x0, y0, w, h) {
  const uniq = new Set();
  let n = 0, sr = 0, sg = 0, sb = 0, sl = 0, sl2 = 0;
  let sat = 0, minL = 255, maxL = 0;
  for (let y = y0; y < y0 + h; y++) {
    for (let x = x0; x < x0 + w; x++) {
      if (x < 0 || y < 0 || x >= png.width || y >= png.height) continue;
      const i = at(x, y);
      const r = png.data[i], g = png.data[i + 1], b = png.data[i + 2];
      uniq.add((r << 16) | (g << 8) | b);
      const l = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      n++; sr += r; sg += g; sb += b; sl += l; sl2 += l * l;
      const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
      sat += mx > 0 ? (mx - mn) / mx : 0;
      if (l < minL) minL = l;
      if (l > maxL) maxL = l;
    }
  }
  const mean = sl / n;
  return {
    n, uniq: uniq.size, uniqPerKpx: +((uniq.size / n) * 1000).toFixed(1),
    r: +(sr / n).toFixed(1), g: +(sg / n).toFixed(1), b: +(sb / n).toFixed(1),
    luma: +mean.toFixed(1), sd: +Math.sqrt(Math.max(0, sl2 / n - mean * mean)).toFixed(2),
    sat: +(sat / n).toFixed(3), minL: +minL.toFixed(0), maxL: +maxL.toFixed(0),
  };
}

if (mode === 'rect') {
  const [x, y, w, h] = rest.map(Number);
  console.log(JSON.stringify(rect(x, y, w, h)));
} else if (mode === 'ratio') {
  const v = rest.map(Number);
  const a = rect(v[0], v[1], v[2], v[3]);
  const b = rect(v[4], v[5], v[6], v[7]);
  console.log(JSON.stringify({ a, b, lumaRatio: +(a.luma / Math.max(b.luma, 0.01)).toFixed(2) }));
} else if (mode === 'dead') {
  const y0 = Number(rest[0] ?? 0);
  let dead = 0, lit = 0, total = 0;
  let sumMinOverMax = 0;
  for (let y = y0; y < png.height; y++) {
    for (let x = 0; x < png.width; x++) {
      const i = at(x, y);
      const r = png.data[i], g = png.data[i + 1], b = png.data[i + 2];
      const mx = Math.max(r, g, b);
      if (mx < 24) continue;                 // the truly dark, not the defect
      total++;
      const mn = Math.min(r, g, b);
      sumMinOverMax += mn / mx;
      if (mx >= 30 && mn <= 2) dead++;
      if (mx >= 30 && mn > 2) lit++;
    }
  }
  console.log(JSON.stringify({
    total, dead, lit,
    deadPct: +((dead / Math.max(total, 1)) * 100).toFixed(3),
    meanMinOverMax: +(sumMinOverMax / Math.max(total, 1)).toFixed(4),
  }));
} else {
  console.error('modes: rect | ratio | dead');
  process.exit(2);
}
