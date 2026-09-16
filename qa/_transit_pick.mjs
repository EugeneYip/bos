/**
 * Attribute specific pixels at a viewpoint using window.__debug.pick, and
 * optionally dump live train head positions via ctx internals. Faster than
 * screenshot-reading when I already know roughly which pixel to check.
 *
 * Usage:
 *   node qa/_transit_pick.mjs <viewpointId> "x,y" "x,y" ...
 *   POSE='{"pos":[...],"target":[...],"hour":16.4}' node qa/_transit_pick.mjs custom "640,360"
 */
import fs from 'node:fs';
import puppeteer from 'puppeteer';

const ROOT = '/Volumes/Projects/bos';
const PORT = 4612;
const vp = JSON.parse(fs.readFileSync(`${ROOT}/qa/viewpoints.json`, 'utf8'));

const ID = process.argv[2] || 'comm-ave';
const POINTS = process.argv.slice(3).length ? process.argv.slice(3) : ['640,360'];
const POSE = process.env.POSE ? JSON.parse(process.env.POSE) : null;
const v = POSE ? { id: ID, ...POSE } : vp.find((x) => x.id === ID);
if (!v) throw new Error(`unknown viewpoint ${ID}`);

for (let i = 0; i < 60; i++) {
  try { if ((await fetch(`http://localhost:${PORT}/`)).ok) break; } catch { /* not up */ }
  await new Promise((r) => setTimeout(r, 250));
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
await page.goto(`http://localhost:${PORT}/?q=high`, { waitUntil: 'networkidle2', timeout: 180000 });
await page.waitForFunction('window.__ready === true', { timeout: 300000 });
await page.waitForFunction('window.__debug !== undefined', { timeout: 30000 });

await page.evaluate((vv) => {
  window.__debug.setTime(vv.hour ?? 13);
  window.__debug.setView(vv.pos, vv.target);
}, v);
await page.evaluate(() => window.__debug.settle(60));

console.log(`[transit-pick] ${v.id} pos=${JSON.stringify(v.pos)} target=${JSON.stringify(v.target)} hour=${v.hour}`);

for (const p of POINTS) {
  const [x, y] = p.split(',').map(Number);
  const hits = await page.evaluate((xx, yy) => window.__debug.pick(xx, yy, 8), x, y);
  console.log(`[transit-pick] (${x},${y}) ->`, JSON.stringify(hits));
}

const stats = await page.evaluate(() => window.__debug.stats());
console.log('[transit-pick] stats', JSON.stringify(stats));

await browser.close();
