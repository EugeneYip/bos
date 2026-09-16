/**
 * Motion-sequence capture for Transit QA. A same-track overlap is a motion
 * bug: two trolleys converging and interpenetrating only shows up across
 * frames, never in one still. This drives one fixed camera pose and takes a
 * burst of shots with `__debug.settle(n)` between them, plus `pick()` at a
 * grid of screen points on the last frame so pixels can be attributed to
 * named meshes without diffing images.
 *
 * Usage:
 *   node qa/_transit_seq.mjs <viewpointId> [steps] [settleFrames]
 *   POSE='{"pos":[x,y,z],"target":[x,y,z],"hour":16.4}' node qa/_transit_seq.mjs custom 8 10
 *
 * Assumes a preview server is already running on :4612 (per task instructions).
 * Shots land in qa/shots/transit/<id>-seq-NN.png.
 */
import fs from 'node:fs';
import puppeteer from 'puppeteer';

const ROOT = '/Volumes/Projects/bos';
const PORT = 4612;
const vp = JSON.parse(fs.readFileSync(`${ROOT}/qa/viewpoints.json`, 'utf8'));

const ID = process.argv[2] || 'comm-ave';
const STEPS = Number(process.argv[3] || 8);
const SETTLE = Number(process.argv[4] || 12);
const POSE = process.env.POSE ? JSON.parse(process.env.POSE) : null;
const v = POSE ? { id: ID, ...POSE } : vp.find((x) => x.id === ID);
if (!v) throw new Error(`unknown viewpoint ${ID}`);

for (let i = 0; i < 60; i++) {
  try { if ((await fetch(`http://localhost:${PORT}/`)).ok) break; } catch { /* not up */ }
  await new Promise((r) => setTimeout(r, 250));
  if (i === 59) throw new Error(`nothing listening on :${PORT} - start the preview server first`);
}

const browser = await puppeteer.launch({
  headless: true, protocolTimeout: 900000,
  args: ['--no-sandbox', '--enable-gpu', '--use-angle=metal', '--enable-unsafe-swiftshader',
    '--ignore-gpu-blocklist', '--enable-webgl', '--window-size=1280,720'],
});
const page = await browser.newPage();
await page.setViewport({ width: 1280, height: 720 });
await page.evaluateOnNewDocument(() => {
  try { localStorage.setItem('bh-onboarded', '1'); } catch { /* private */ }
});
const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push(String(e)));

await page.goto(`http://localhost:${PORT}/?q=high`, { waitUntil: 'networkidle2', timeout: 180000 });
await page.waitForFunction('window.__ready === true', { timeout: 300000 });
await page.waitForFunction('window.__debug !== undefined', { timeout: 30000 });

await page.evaluate((vv) => {
  window.__debug.setTime(vv.hour ?? 13);
  window.__debug.setView(vv.pos, vv.target);
}, v);
await page.evaluate(() => window.__debug.settle(60));

console.log(`[transit-seq] ${v.id} pos=${JSON.stringify(v.pos)} target=${JSON.stringify(v.target)} hour=${v.hour}`);
const stats0 = await page.evaluate(() => window.__debug.stats());
console.log('[transit-seq] stats', JSON.stringify(stats0));

for (let s = 0; s < STEPS; s++) {
  const file = `${ROOT}/qa/shots/transit/${v.id}-seq-${String(s).padStart(2, '0')}.png`;
  await page.screenshot({ path: file });
  console.log(`[transit-seq] wrote ${file}`);
  await page.evaluate((n) => window.__debug.settle(n), SETTLE);
}

if (errors.length) {
  console.error('[transit-seq] PAGE ERRORS:\n' + errors.slice(0, 25).join('\n'));
}

await browser.close();
