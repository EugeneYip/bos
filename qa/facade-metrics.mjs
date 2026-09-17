#!/usr/bin/env node
/**
 * Measurements for the facade / night-window / landmark-glass defects.
 *
 * Auto-exposure moves under every change and lit windows are most of the light
 * in a night frame, so absolute luma is not comparable between builds. Every
 * figure here is therefore either a *proportion of the frame* or a *ratio
 * between two regions of the same frame*.
 *
 *   node qa/facade-metrics.mjs qa/shots/street-night--tag.png [...]
 *
 * Region names are matched against the shot's basename, so one invocation can
 * take a whole sweep.
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { PNG } from 'pngjs';

const lum = (d, i) => 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];

/** The HUD overlays; never counted. Matches qa/_crit_metrics.mjs. */
const hud = (x, y, W, H) => (y > H - 72) || (y > H - 140 && x < 330) || (y < 112 && x < 430);

/** Regions of interest, per viewpoint, in 1600x900 frame pixels. */
const REGIONS = {
  'street-night': {
    // The critic's window bank.
    bank: [690, 430, 200, 100],
    // A second storefront bank, the one the pavement probes sit under.
    bank_r: [1460, 430, 110, 100],
    // Unglazed facade pier between upper windows: same wall, same distance,
    // nothing emissive. The exposure-invariant reference for the bank.
    wall: [1005, 230, 40, 100],
    // The carriageway under bank_r, stepping away from the shopfront.
    // The road recedes *up* the frame here, so y ascending = nearer camera.
    pave_1: [1430, 576, 165, 12],
    pave_2: [1430, 600, 165, 12],
    pave_3: [1430, 630, 165, 12],
    pave_4: [1430, 668, 165, 12],
  },
  'seaport-night': {},
  'charles-water': {
    // Hancock's long glass face.
    hancock: [1112, 300, 55, 110],
    // An ordinary shell-material tower for comparison.
    ordinary: [1195, 690, 55, 60],
  },
  'backbay-grid': {},
  'golden-hour-dome': {},
};

function region(png, [x0, y0, w, h]) {
  const { width: W, data: d } = png;
  const px = [];
  for (let y = y0; y < y0 + h; y++) {
    for (let x = x0; x < x0 + w; x++) {
      const i = (y * W + x) * 4;
      px.push([d[i], d[i + 1], d[i + 2]]);
    }
  }
  return { px, w, h };
}

function stats(png, rect) {
  const { px, w, h } = region(png, rect);
  const uniq = new Set();
  let sum = 0;
  let sum2 = 0;
  let white = 0;
  let hot = 0;
  for (const [r, g, b] of px) {
    uniq.add((r << 16) | (g << 8) | b);
    const l = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    sum += l;
    sum2 += l * l;
    if (r === 255 && g === 255 && b === 255) white++;
    if (l >= 245) hot++;
  }
  const n = px.length;
  const mean = sum / n;
  const sd = Math.sqrt(Math.max(0, sum2 / n - mean * mean));
  return {
    mean, sd, uniq: uniq.size,
    white: (100 * white) / n,
    hot: (100 * hot) / n,
    ...periodicity(px, w, h),
  };
}

/**
 * Strongest normalised autocorrelation peak along each axis, at lags 3 and up.
 *
 * The signal is high-passed first (a 7-tap box mean is subtracted along the
 * axis). Without that, any smooth ramp — a lit road, a sky gradient — scores
 * ~0.95 at every short lag and the number says nothing. After it, a real
 * window grid still scores > ~0.25 at its pitch and an unstructured mottle
 * scores under ~0.1.
 */
function periodicity(px, w, h) {
  const g = px.map(([r, gg, b]) => 0.2126 * r + 0.7152 * gg + 0.0722 * b);
  const axis = (len, other, at) => {
    if (len < 12) return { peak: 0, lag: 0 };
    // High-pass each line.
    const hp = [];
    const R = 3;
    for (let o = 0; o < other; o++) {
      const line = new Float64Array(len);
      for (let i = 0; i < len; i++) {
        let s = 0;
        let n = 0;
        for (let k = -R; k <= R; k++) {
          const j = i + k;
          if (j < 0 || j >= len) continue;
          s += at(j, o);
          n++;
        }
        line[i] = at(i, o) - s / n;
      }
      hp.push(line);
    }
    let best = 0;
    let bestLag = 0;
    for (let lag = 3; lag <= Math.floor(len / 2); lag++) {
      let num = 0;
      let d1 = 0;
      let d2 = 0;
      for (const line of hp) {
        for (let i = 0; i + lag < len; i++) {
          num += line[i] * line[i + lag];
          d1 += line[i] * line[i];
          d2 += line[i + lag] * line[i + lag];
        }
      }
      const c = num / Math.sqrt(Math.max(1e-9, d1 * d2));
      if (c > best) { best = c; bestLag = lag; }
    }
    return { peak: best, lag: bestLag };
  };
  const hx = axis(w, h, (i, o) => g[o * w + i]);
  const vy = axis(h, w, (i, o) => g[i * w + o]);
  return { hPeak: hx.peak, hLag: hx.lag, vPeak: vy.peak, vLag: vy.lag };
}

function global(png) {
  const { width: W, height: H, data: d } = png;
  let n = 0;
  let sum = 0;
  let white = 0;
  let hot = 0;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      if (hud(x, y, W, H)) continue;
      const i = (y * W + x) * 4;
      n++;
      sum += lum(d, i);
      if (d[i] === 255 && d[i + 1] === 255 && d[i + 2] === 255) white++;
      if (lum(d, i) >= 245) hot++;
    }
  }
  return { mean: sum / n, white: (100 * white) / n, hot: (100 * hot) / n };
}

const f2 = (v) => v.toFixed(2);

for (const file of process.argv.slice(2)) {
  let png;
  try { png = PNG.sync.read(await readFile(file)); } catch (e) { console.log(`${file}: ${e.message}`); continue; }
  const base = path.basename(file);
  const key = Object.keys(REGIONS).find((k) => base.startsWith(k));
  const g = global(png);
  console.log(`\n${base}  ${png.width}x${png.height}`);
  console.log(`  FRAME  mean ${f2(g.mean)}  pure-white ${f2(g.white)}%  luma>=245 ${f2(g.hot)}%`);
  if (!key) continue;
  const r = REGIONS[key];
  const s = {};
  for (const [name, rect] of Object.entries(r)) {
    s[name] = stats(png, rect);
    const v = s[name];
    console.log(
      `  ${name.padEnd(10)} mean ${f2(v.mean).padStart(6)}  sd ${f2(v.sd).padStart(6)}`
      + `  white ${f2(v.white).padStart(6)}%  uniqRGB ${String(v.uniq).padStart(5)}`
      + `  hPeak ${v.hPeak.toFixed(3)}@${v.hLag}  vPeak ${v.vPeak.toFixed(3)}@${v.vLag}`,
    );
  }
  // Exposure-invariant ratios.
  if (s.bank && s.wall) {
    console.log(`  RATIO  bank/wall ${(s.bank.mean / s.wall.mean).toFixed(2)}`
      + `  bank/frame ${(s.bank.mean / g.mean).toFixed(2)}`);
  }
  if (s.pave_1 && s.pave_4) {
    console.log(
      `  FALLOFF ${f2(s.pave_1.mean)} ${f2(s.pave_2.mean)} ${f2(s.pave_3.mean)} ${f2(s.pave_4.mean)}`
      + `   p1/p4 ${(s.pave_1.mean / s.pave_4.mean).toFixed(3)}`
      + `   p1/wall ${(s.pave_1.mean / (s.wall?.mean || 1)).toFixed(3)}`,
    );
  }
  if (s.hancock && s.ordinary) {
    console.log(
      `  GLASS  hancock sd ${f2(s.hancock.sd)} vs ordinary sd ${f2(s.ordinary.sd)}`
      + `   uniq ${s.hancock.uniq} vs ${s.ordinary.uniq}`,
    );
  }
}
