/**
 * Quantitative overlap finder. Rather than hoping a fixed camera pose happens
 * to catch two opposite-direction trolleys meeting, this reads the live
 * instance matrices of every rail InstancedMesh directly out of the scene
 * graph, world-transforms them, and reports the closest pair of *opposite
 * heading* cars on each system — which is exactly the "two directions share a
 * centreline" signature (same-train cars are close but same-heading, so they
 * are excluded). Also reports same-system same-heading closest pairs, which
 * is the vehicle-spacing polish item.
 *
 * Usage: node qa/_transit_overlap.mjs [hour] [settleFrames] [--watch N]
 *   --watch N   repeat the sample N times, `settle(20)` between samples, to
 *               track a close pair's separation over time (closing / passing
 *               / separating) the way a real overlap would move.
 */
import puppeteer from 'puppeteer';

const PORT = 4612;
const HOUR = Number(process.argv[2] || 13);
const SETTLE = Number(process.argv[3] || 90);
const watchIdx = process.argv.indexOf('--watch');
const WATCH = watchIdx >= 0 ? Number(process.argv[watchIdx + 1] || 5) : 1;

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
  // A wide, central, high vantage sees a lot of track at once so trains have
  // plenty of chances to be near each other by the time we sample.
  window.__debug.setView([0, 900, 0], [200, 0, -200]);
}, HOUR);
await page.evaluate((n) => window.__debug.settle(n), SETTLE);

function extractFn() {
  const out = {};
  const scene = window.__boston.ctx.scene;
  scene.traverse((o) => {
    if (!o.isInstancedMesh) return;
    if (!o.name.startsWith('transit:') || !o.name.endsWith(':shell')) return;
    const sys = o.name.split(':')[1];
    const arr = (out[sys] ??= []);
    const e = o.instanceMatrix.array;
    for (let i = 0; i < o.count; i++) {
      const base = i * 16;
      const x = e[base + 12], y = e[base + 13], z = e[base + 14];
      // Forward (local +X, the car's length axis) is column 0 of the
      // rotation part — composeMatrix's yaw-only-plus-grade-tilt quaternion
      // sends local +X to world (hx, hy, hz) to first order, so this is
      // exactly the heading used for spacing/collision analysis.
      const fx = e[base + 0], fz = e[base + 2];
      arr.push({ x, y, z, fx, fz, key: o.name, i });
    }
  });
  return out;
}

function analyze(byS) {
  const report = {};
  for (const sys of Object.keys(byS)) {
    const pts = byS[sys];
    let bestOpp = null, bestSame = null;
    for (let i = 0; i < pts.length; i++) {
      for (let j = i + 1; j < pts.length; j++) {
        const a = pts[i], b = pts[j];
        const dx = a.x - b.x, dz = a.z - b.z;
        const d = Math.hypot(dx, dz);
        const dot = a.fx * b.fx + a.fz * b.fz; // heading similarity
        if (dot < -0.3) { if (!bestOpp || d < bestOpp.d) bestOpp = { d, a, b, dot }; }
        else if (dot > 0.3) { if (!bestSame || (d < bestSame.d && d > 0.01)) bestSame = { d, a, b, dot }; }
      }
    }
    report[sys] = { count: pts.length, bestOpp, bestSame };
  }
  return report;
}

for (let w = 0; w < WATCH; w++) {
  const byS = await page.evaluate(extractFn);
  const rep = analyze(byS);
  console.log(`\n[overlap] --- sample ${w} (t=${(w * 20 / 60).toFixed(1)}s of settle) ---`);
  for (const sys of Object.keys(rep)) {
    const r = rep[sys];
    const fmt = (pair) => pair
      ? `d=${pair.d.toFixed(2)}m dot=${pair.dot.toFixed(2)} A=(${pair.a.x.toFixed(1)},${pair.a.z.toFixed(1)}) B=(${pair.b.x.toFixed(1)},${pair.b.z.toFixed(1)})`
      : 'n/a';
    console.log(`  ${sys.padEnd(10)} cars=${r.count}  opposing-closest: ${fmt(r.bestOpp)}  |  same-dir-closest: ${fmt(r.bestSame)}`);
  }
  if (w < WATCH - 1) await page.evaluate(() => window.__debug.settle(20));
}

await browser.close();
