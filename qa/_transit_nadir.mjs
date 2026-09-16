/**
 * Clean near-nadir shot centred on an explicit world (x,z), high enough that
 * a single street tree's ~15-20 m canopy is small in frame instead of
 * covering the whole shot the way a steep trackside angle does (see
 * `_transit_catch.mjs`'s note on this). Takes a settle-advancing sequence so
 * two opposing cars closing/passing/separating is visible across frames.
 *
 * Usage: node qa/_transit_nadir.mjs <x> <z> [hour] [steps] [settleFrames] [height]
 */
import puppeteer from 'puppeteer';

const PORT = 4612;
const X = Number(process.argv[2]);
const Z = Number(process.argv[3]);
const HOUR = Number(process.argv[4] || 13);
const STEPS = Number(process.argv[5] || 6);
const SETTLE = Number(process.argv[6] || 8);
const HEIGHT = Number(process.argv[7] || 220);
if (!Number.isFinite(X) || !Number.isFinite(Z)) throw new Error('usage: node qa/_transit_nadir.mjs <x> <z> [hour] [steps] [settleFrames] [height]');

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

await page.evaluate((x, z, h, hour) => {
  window.__debug.setTime(hour);
  window.__debug.setView([x + 6, h, z + 6], [x, 2, z]);
}, X, Z, HEIGHT, HOUR);
await page.evaluate(() => window.__debug.settle(20));

console.log(`[nadir] centre=(${X},${Z}) height=${HEIGHT} hour=${HOUR}`);
for (let s = 0; s < STEPS; s++) {
  const file = `/Volumes/Projects/bos/qa/shots/transit/nadir-${String(s).padStart(2, '0')}.png`;
  await page.screenshot({ path: file });
  console.log(`[nadir] wrote ${file}`);
  await page.evaluate((n) => window.__debug.settle(n), SETTLE);
}

await browser.close();
