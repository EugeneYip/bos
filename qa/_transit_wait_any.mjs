/**
 * Like `_transit_wait_pass.mjs` but waits for just one car of the named
 * system within `radius` of the pose's target (not an opposing pair) --
 * useful for a clean close-up of stock/pantograph/wire detail rather than
 * an overlap check.
 *
 * Usage: POSE='{"pos":[...],"target":[...],"hour":13}' node qa/_transit_wait_any.mjs <system> <name> [radius] [maxSteps]
 */
import puppeteer from 'puppeteer';

const PORT = 4612;
const SYS = process.argv[2] || 'green';
const NAME = process.argv[3] || 'wait';
const RADIUS = Number(process.argv[4] || 60);
const MAX_STEPS = Number(process.argv[5] || 200);
const POSE = process.env.POSE ? JSON.parse(process.env.POSE) : null;
if (!POSE) throw new Error('set POSE env var');

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

await page.evaluate((p) => {
  window.__debug.setTime(p.hour ?? 13);
  window.__debug.setView(p.pos, p.target);
}, POSE);
await page.evaluate(() => window.__debug.settle(20));

const found = await page.evaluate(async (sys, tx, tz, radius, maxSteps) => {
  function extract() {
    const arr = [];
    window.__boston.ctx.scene.traverse((o) => {
      if (!o.isInstancedMesh || o.name !== `transit:${sys}:shell`) return;
      const e = o.instanceMatrix.array;
      for (let i = 0; i < o.count; i++) {
        const b = i * 16;
        arr.push({ x: e[b + 12], y: e[b + 13], z: e[b + 14] });
      }
    });
    return arr;
  }
  for (let s = 0; s < maxSteps; s++) {
    const pts = extract().filter((p) => Math.hypot(p.x - tx, p.z - tz) < radius);
    if (pts.length) return { step: s, n: pts.length, p: pts[0] };
    await window.__debug.settle(3);
  }
  return null;
}, SYS, POSE.target[0], POSE.target[2], RADIUS, MAX_STEPS);

console.log(`[wait-any] ${found ? `found ${found.n} at step ${found.step}: ${JSON.stringify(found.p)}` : 'not found within budget'}`);

for (let s = 0; s < 6; s++) {
  const file = `/Volumes/Projects/bos/qa/shots/transit/${NAME}-${String(s).padStart(2, '0')}.png`;
  await page.screenshot({ path: file });
  console.log(`[wait-any] wrote ${file}`);
  await page.evaluate(() => window.__debug.settle(5));
}

await browser.close();
