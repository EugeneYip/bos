#!/usr/bin/env node
/**
 * Statistics over the pixels the traffic actually covers, without knowing
 * where the traffic is.
 *
 * Two runs of this city never put a car in the same place twice, so the
 * obvious measurement — crop the van and count colours — cannot be repeated
 * after a change. This stops the frame loop, captures, hides every vehicle,
 * captures again, hides the people and captures a third time; the pixels that
 * changed are exactly the traffic, because with the loop stopped nothing else
 * in the scene moved at all. The mask covers a different set of cars before
 * and after a change, but it is the same *population*, so the distributions
 * are comparable even though no two pixels are.
 *
 * Reported per population (vehicles, people, and both):
 *   cover     share of the frame the mask covers
 *   uniq/kpx  unique RGB triples per thousand masked pixels — flatness
 *   sd        standard deviation of luma — shading variation
 *   sat       mean (max-min)/max — how far the colour is from grey
 *   dead      share of masked pixels whose weakest channel is <= 2 while the
 *             strongest is >= 30: lit by a tinted diffuse term and nothing
 *             else, which is defect #6 stated as a number
 *   ratio     mean masked luma over mean unmasked luma in the same frame,
 *             the only brightness comparison that survives auto-exposure
 *
 *   QA_PORT=4443 QA_OUTDIR=dist-v node qa/_trafficpx.mjs --view street-night \
 *     --hour 21.4 --tier ultra [--png out-prefix]
 */
import { spawn } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer';
import { PNG } from 'pngjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.QA_PORT || 4443);
const OUTDIR = process.env.QA_OUTDIR || 'dist-v';
const argv = process.argv.slice(2);
const flag = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : d; };
const TIER = flag('tier', 'ultra');
const VIEW = flag('view', 'street-night');
const HOUR = flag('hour', null);
const PNGOUT = flag('png', null);
const W = 1600, H = 900;

async function startServer() {
  const p = spawn('npx', ['vite', 'preview', '--port', String(PORT), '--strictPort', '--outDir', OUTDIR], {
    cwd: ROOT, stdio: 'pipe', env: { ...process.env, VITE_BASE: '/' },
  });
  p.stdout.on('data', () => {}); p.stderr.on('data', () => {});
  for (let i = 0; i < 160; i++) {
    try { const r = await fetch(`http://localhost:${PORT}/`); if (r.ok) return p; } catch { /* waiting */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  p.kill(); throw new Error('preview server did not start');
}

const server = await startServer();
const browser = await puppeteer.launch({
  headless: true,
  args: ['--no-sandbox', '--enable-gpu', '--use-angle=metal', '--enable-unsafe-swiftshader',
    '--ignore-gpu-blocklist', '--enable-webgl', `--window-size=${W},${H}`, '--hide-scrollbars'],
});
const page = await browser.newPage();
await page.setViewport({ width: W, height: H, deviceScaleFactor: 1 });
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
await page.evaluateOnNewDocument(() => { try { localStorage.setItem('bh-onboarded', '1'); } catch { /* */ } });
// Seed the world.
//
// Every car's colour, lane and position comes out of Math.random at boot, so
// two runs put a different fleet on a different street and no statistic over
// 'the vehicles in this frame' means the same thing twice — one run of this
// script found 10% of the frame covered in bodywork and the next found 0.03%.
// Replacing the generator before any module loads makes the whole city
// reproducible, so a before and an after describe the same cars.
await page.evaluateOnNewDocument((seed) => {
  let s = seed >>> 0;
  Math.random = () => {
    s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0;
    return s / 4294967296;
  };
}, Number(process.env.QA_SEED || 0x2f6e2b1));
await page.goto(`http://localhost:${PORT}/?q=${TIER}`, { waitUntil: 'networkidle2', timeout: 180000 });
await page.waitForFunction('window.__ready === true', { timeout: 300000 });

const vps = JSON.parse(await readFile(path.join(ROOT, 'qa/viewpoints.json'), 'utf8'));
const vp = vps.find((v) => v.id === VIEW);
if (!vp) throw new Error(`no viewpoint ${VIEW}`);
const hour = HOUR !== null ? Number(HOUR) : vp.hour;
await page.evaluate((v, h) => { window.__debug.setView(v.pos, v.target); window.__debug.setTime(h); }, vp, hour);
await page.evaluate(() => window.__debug.settle(90));
await new Promise((r) => setTimeout(r, 1200));
await page.evaluate(() => window.__debug.settle(40));

const shot = async () => PNG.sync.read(Buffer.from(await page.screenshot({ type: 'png' })));
const probe = await page.evaluate(() => ({ ...window.__debug.probe(), ...window.__debug.stats() }));

/**
 * Stop the world, then draw frames by hand.
 *
 * With the frame loop still turning, the canopy and the water moved between
 * the two captures and a third of the mask came back as leaves. `running` is
 * the app's own latch; with it down no module steps, so the only difference
 * between two captures is the thing that was toggled between them, and the
 * mask is exact rather than thresholded.
 */
await page.evaluate(() => { window.__boston.running = false; });
const redraw = () => page.evaluate(() => {
  const app = window.__boston;
  if (app.renderOverride) app.renderOverride(1 / 60);
  else app.ctx.renderer.render(app.ctx.scene, app.ctx.camera);
});
await redraw();

const full = await shot();
await page.evaluate(() => { window.__debug.toggle('traffic:', false); });
await redraw();
const noCars = await shot();
await page.evaluate(() => { window.__debug.toggle('pedestrians', false); });
await redraw();
const noneAt = await shot();

await browser.close(); server.kill();

const diff = (a, b, i) => Math.abs(a.data[i] - b.data[i]) + Math.abs(a.data[i + 1] - b.data[i + 1])
  + Math.abs(a.data[i + 2] - b.data[i + 2]);
const THRESH = 26;

function stats(mask) {
  const uniq = new Set();
  let n = 0, sl = 0, sl2 = 0, sat = 0, dead = 0, sr = 0, sg = 0, sb = 0;
  let outN = 0, outL = 0;
  for (let p = 0; p < W * H; p++) {
    const i = p * 4;
    const r = full.data[i], g = full.data[i + 1], b = full.data[i + 2];
    const l = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    if (!mask[p]) { outN++; outL += l; continue; }
    uniq.add((r << 16) | (g << 8) | b);
    n++; sl += l; sl2 += l * l; sr += r; sg += g; sb += b;
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
    if (mx > 0) sat += (mx - mn) / mx;
    if (mx >= 30 && mn <= 2) dead++;
  }
  if (!n) return { n: 0 };
  const mean = sl / n;
  return {
    n, cover: +((n / (W * H)) * 100).toFixed(2),
    uniqPerKpx: +((uniq.size / n) * 1000).toFixed(1),
    luma: +mean.toFixed(1),
    sd: +Math.sqrt(Math.max(0, sl2 / n - mean * mean)).toFixed(2),
    sat: +(sat / n).toFixed(3),
    deadPct: +((dead / n) * 100).toFixed(2),
    rgb: [+(sr / n).toFixed(1), +(sg / n).toFixed(1), +(sb / n).toFixed(1)],
    ratioToRest: +(mean / Math.max(outL / Math.max(outN, 1), 0.01)).toFixed(2),
  };
}

const veh = new Uint8Array(W * H);
const ped = new Uint8Array(W * H);
const both = new Uint8Array(W * H);
for (let p = 0; p < W * H; p++) {
  const i = p * 4;
  if (diff(full, noCars, i) > THRESH) { veh[p] = 1; both[p] = 1; }
  else if (diff(noCars, noneAt, i) > THRESH) { ped[p] = 1; both[p] = 1; }
}

const out = {
  view: VIEW, hour, tier: TIER,
  exposure: probe.exposure, sunElev: probe.sunElev ?? probe['sky.elev'],
  drawCalls: probe.drawCalls ?? probe.calls ?? null,
  vehicles: stats(veh), pedestrians: stats(ped), all: stats(both),
};
console.log(JSON.stringify(out, null, 2));
if (errors.length) console.error('ERRORS', errors.slice(0, 6));

if (PNGOUT) {
  await writeFile(`${PNGOUT}-full.png`, PNG.sync.write(full));
  const m = new PNG({ width: W, height: H });
  for (let p = 0; p < W * H; p++) {
    const i = p * 4;
    m.data[i] = veh[p] ? 255 : 0;
    m.data[i + 1] = ped[p] ? 255 : 0;
    m.data[i + 2] = 0; m.data[i + 3] = 255;
  }
  await writeFile(`${PNGOUT}-mask.png`, PNG.sync.write(m));
}
