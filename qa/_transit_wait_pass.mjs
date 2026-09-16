/**
 * Holds a fixed, known-clear camera pose (no trees in the way, unlike the
 * auto-search in `_transit_catch.mjs`) and settles in a loop, checking the
 * live scene each step for a pair of opposite-heading cars on the named
 * system both within `radius` metres of the pose's target. Screenshots the
 * moment it finds one, plus a short settle-advancing burst after, so the
 * pass is visible across frames from a pose we already know reads well.
 *
 * Usage:
 *   POSE='{"pos":[...],"target":[...],"hour":13}' node qa/_transit_wait_pass.mjs <system> <name> [radius] [maxSettleSteps]
 */
import puppeteer from 'puppeteer';

const PORT = 4612;
const SYS = process.argv[2] || 'green';
const NAME = process.argv[3] || 'wait';
const RADIUS = Number(process.argv[4] || 120);
const MAX_STEPS = Number(process.argv[5] || 150);
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
await page.evaluate(() => window.__debug.settle(30));

const found = await page.evaluate(async (sys, tx, tz, radius, maxSteps) => {
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
  for (let s = 0; s < maxSteps; s++) {
    const pts = extract().filter((p) => Math.hypot(p.x - tx, p.z - tz) < radius);
    for (let i = 0; i < pts.length; i++) {
      for (let j = i + 1; j < pts.length; j++) {
        const a = pts[i]; const b = pts[j];
        const dot = a.fx * b.fx + a.fz * b.fz;
        if (dot < -0.3) return { step: s, d: Math.hypot(a.x - b.x, a.z - b.z), a, b };
      }
    }
    await window.__debug.settle(3);
  }
  return null;
}, SYS, POSE.target[0], POSE.target[2], RADIUS, MAX_STEPS);

console.log(`[wait-pass] ${found ? `found at step ${found.step}, d=${found.d.toFixed(2)}m` : 'not found within budget'}`);
if (found) console.log(JSON.stringify(found));

for (let s = 0; s < 8; s++) {
  const file = `/Volumes/Projects/bos/qa/shots/transit/${NAME}-${String(s).padStart(2, '0')}.png`;
  await page.screenshot({ path: file });
  console.log(`[wait-pass] wrote ${file}`);
  await page.evaluate(() => window.__debug.settle(6));
}

await browser.close();
