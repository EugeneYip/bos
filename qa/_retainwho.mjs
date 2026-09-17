/**
 * Which module keeps the geometry a moving camera should have freed.
 *
 * Measured on a phone viewport: retained geometry count goes 369 -> 787 and
 * GPU-resident vertex data 149 -> 250 MB over a 45 s flight that circles back
 * past its own start, and neither falls again after 20 s of a completely
 * stationary camera. So eviction is not lagging the camera, it is not
 * reclaiming at all. This groups what is resident by mesh-name prefix at each
 * step, so the leak can be pinned on a module instead of the renderer total.
 */
import { spawn } from 'node:child_process';
import puppeteer from 'puppeteer';
const ROOT = '/Volumes/Projects/bos', PORT = Number(process.env.QA_PORT || 4418);
const UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';
const W = 393, H = 852, DPR = Number(process.env.DPR || 1), SAFE = process.env.SAFE ?? '1';
const srv = spawn('npx', ['vite','preview','--port',String(PORT),'--strictPort','--outDir', process.env.QA_OUTDIR ?? 'dist-fp'],
  { cwd: ROOT, stdio: 'ignore', env: { ...process.env, VITE_BASE: '/' } });
for (let i=0;i<160;i++){ try { if ((await fetch(`http://localhost:${PORT}/`)).ok) break; } catch {} await new Promise(r=>setTimeout(r,250)); }
const b = await puppeteer.launch({ headless: true, protocolTimeout: 900000,
  args: ['--no-sandbox','--enable-gpu','--use-angle=metal','--ignore-gpu-blocklist','--enable-webgl'] });
const pg = await b.newPage();
await pg.emulate({ userAgent: UA,
  viewport: { width: W, height: H, deviceScaleFactor: DPR, isMobile: true, hasTouch: true, isLandscape: false } });
await pg.evaluateOnNewDocument(() => {
  Object.defineProperty(navigator, 'maxTouchPoints', { get: () => 5 });
  try { localStorage.setItem('bh-onboarded','1'); } catch {}
});
const missing = [];
pg.on('response', (r) => { if (r.status() === 404) missing.push(r.url()); });
await pg.goto(`http://localhost:${PORT}/?safe=${SAFE}`, { waitUntil: 'domcontentloaded', timeout: 120000 });
await new Promise(r => setTimeout(r, 1500));
if (missing.some(u => /\/bos\//.test(u))) { await b.close(); srv.kill();
  throw new Error('build made without VITE_BASE=/ -- assets 404 under /bos/'); }
await pg.waitForFunction('window.__ready === true', { timeout: 240000, polling: 500 });
await pg.evaluate(() => window.__debug.settle(240));

// Group by the part of the name before the first ':', which is this repo's
// convention ('buildings:524799', 'water:chunk', 'roads:...').
const GROUP = () => {
  const app = window.__boston;
  const seen = new Set(); const by = {};
  app.ctx.scene.traverse((o) => {
    const g = o.geometry; if (!g || seen.has(g)) return; seen.add(g);
    let bytes = 0;
    for (const n in g.attributes) { const a = g.attributes[n];
      bytes += a.count * a.itemSize * (a.array ? a.array.BYTES_PER_ELEMENT : 4); }
    if (g.index) bytes += g.index.count * (g.index.array?.BYTES_PER_ELEMENT ?? 4);
    const key = (o.name || '(unnamed)').split(':')[0] || '(empty)';
    by[key] = by[key] || { n: 0, mb: 0 };
    by[key].n++; by[key].mb += bytes / 1048576;
  });
  for (const k in by) by[k].mb = +by[k].mb.toFixed(1);
  return { total: seen.size, by };
};

const steps = [];
steps.push({ t: 'boot', ...(await pg.evaluate(GROUP)) });
for (let i = 1; i <= 9; i++) {
  await pg.evaluate((k) => {
    const a = k * 0.9;
    window.__debug.setView([1200*Math.cos(a), 220 + 60*Math.sin(a*0.7), 1200*Math.sin(a)], [0, 40, 0]);
  }, i);
  await pg.evaluate(() => window.__debug.settle(90));
}
steps.push({ t: 'after flight', ...(await pg.evaluate(GROUP)) });
// Return to the opening pose: everything loaded on the far side is now far
// out of range and has no excuse to still be resident.
await pg.evaluate(() => { const a = 0.9;
  window.__debug.setView([1200*Math.cos(a), 220 + 60*Math.sin(a*0.7), 1200*Math.sin(a)], [0, 40, 0]); });
await pg.evaluate(() => window.__debug.settle(240));
await pg.evaluate(() => new Promise(r => setTimeout(r, 15000)));
await pg.evaluate(() => window.__debug.settle(120));
steps.push({ t: 'back at start +15s', ...(await pg.evaluate(GROUP)) });

for (const s of steps) {
  const top = Object.entries(s.by).sort((a, c) => c[1].mb - a[1].mb).slice(0, 8)
    .map(([k, v]) => `${k} n=${v.n} ${v.mb}MB`).join('  ');
  console.log(`${String(s.t).padEnd(20)} total=${s.total}  ${top}`);
}
await b.close(); srv.kill();
