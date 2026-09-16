/**
 * Finds a live pair of opposite-heading cars on one system that are
 * unrealistically close together (the "sharing a centreline" signature),
 * drops the camera trackside at that exact spot, and shoots a settle()
 * sequence so the pass-through is visible across frames — a still frame
 * cannot show a motion bug, but four frames advancing by a few frames each
 * can.
 *
 * Usage: node qa/_transit_catch.mjs <system> [hour] [searchSettle]
 *   system: green | red | orange | blue | commuter-coach | commuter-loco
 */
import puppeteer from 'puppeteer';

const PORT = 4612;
const SYS = process.argv[2] || 'red';
const HOUR = Number(process.argv[3] || 13);
const SEARCH_SETTLE = Number(process.argv[4] || 90);

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

await page.evaluate((h) => {
  window.__debug.setTime(h);
  window.__debug.setView([0, 900, 0], [200, 0, -200]);
}, HOUR);
await page.evaluate((n) => window.__debug.settle(n), SEARCH_SETTLE);

// Search across a handful of samples for the closest opposing pair, since a
// single instant might not have one close by chance.
const best = await page.evaluate(async (sys) => {
  function extract() {
    const arr = [];
    window.__boston.ctx.scene.traverse((o) => {
      if (!o.isInstancedMesh || o.name !== `transit:${sys}:shell`) return;
      const e = o.instanceMatrix.array;
      for (let i = 0; i < o.count; i++) {
        const b = i * 16;
        arr.push({ x: e[b + 12], y: e[b + 13], z: e[b + 14], fx: e[b + 0], fz: e[b + 2] });
      }
    });
    return arr;
  }
  let best = null;
  for (let s = 0; s < 40; s++) {
    const pts = extract();
    for (let i = 0; i < pts.length; i++) {
      for (let j = i + 1; j < pts.length; j++) {
        const a = pts[i], b = pts[j];
        const dot = a.fx * b.fx + a.fz * b.fz;
        if (dot >= -0.3) continue;
        const d = Math.hypot(a.x - b.x, a.z - b.z);
        if (!best || d < best.d) best = { d, a, b, dot, sample: s };
      }
    }
    await new Promise((r) => requestAnimationFrame(r));
    await window.__debug.settle(4);
  }
  return best;
}, SYS);

if (!best) {
  console.log(`[catch] no opposing pair found for ${SYS} in the search window — try a longer search or a system with more trains.`);
  await browser.close();
  process.exit(0);
}
console.log(`[catch] ${SYS}: closest opposing pair d=${best.d.toFixed(2)}m dot=${best.dot.toFixed(2)} ` +
  `A=(${best.a.x.toFixed(1)},${best.a.y.toFixed(1)},${best.a.z.toFixed(1)}) ` +
  `B=(${best.b.x.toFixed(1)},${best.b.y.toFixed(1)},${best.b.z.toFixed(1)}) (search sample ${best.sample})`);

const mx = (best.a.x + best.b.x) / 2, mz = (best.a.z + best.b.z) / 2, my = (best.a.y + best.b.y) / 2;
const px = -best.a.fz, pz = best.a.fx; // perpendicular to travel
// Steep and a little high so street trees (~15-20m canopy) don't sit between
// the camera and the cars — a trackside eye-level shot here mostly frames
// leaves, per the first pass of this script.
const camPos = [mx + px * 16 + best.a.fx * 4, my + 42, mz + pz * 16 + best.a.fz * 4];
const target = [mx, my + 1.5, mz];

await page.evaluate((p, t, h) => {
  window.__debug.setTime(h);
  window.__debug.setView(p, t);
}, camPos, target, HOUR);
await page.evaluate(() => window.__debug.settle(6));

for (let s = 0; s < 6; s++) {
  const file = `/Volumes/Projects/bos/qa/shots/transit/catch-${SYS}-${String(s).padStart(2, '0')}.png`;
  await page.screenshot({ path: file });
  console.log(`[catch] wrote ${file}`);
  await page.evaluate(() => window.__debug.settle(8));
}

await browser.close();
