/**
 * Peak JS heap during load, with the heap marked at each world module's own
 * console line, so a peak can be attributed to a module instead of guessed at.
 *
 *   MOBILE_UA=1 QA_OUTDIR=dist-p QA_PORT=4440 node qa/_vegpeak.mjs
 */
import { spawn } from 'node:child_process';
import puppeteer from 'puppeteer';

const ROOT = '/Volumes/Projects/bos';
const PORT = Number(process.env.QA_PORT || 4440);
const UA = process.env.MOBILE_UA
  ? 'Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1'
  : null;
const srv = spawn('npx', ['vite', 'preview', '--port', String(PORT), '--strictPort', '--outDir',
  process.env.QA_OUTDIR ?? 'dist-p'], { cwd: ROOT, stdio: 'ignore', env: { ...process.env, VITE_BASE: '/' } });
for (let i = 0; i < 200; i++) {
  try { if ((await fetch(`http://localhost:${PORT}/`)).ok) break; } catch { /* waiting */ }
  await new Promise((r) => setTimeout(r, 250));
}
const b = await puppeteer.launch({ headless: true, protocolTimeout: 900000,
  args: ['--no-sandbox', '--enable-gpu', '--use-angle=metal', '--ignore-gpu-blocklist',
    '--enable-webgl', '--js-flags=--expose-gc', '--window-size=1180,820'] });
const pg = await b.newPage();
await pg.setViewport({ width: 1180, height: 820, deviceScaleFactor: 2 });
if (UA) await pg.setUserAgent(UA);
const marks = [];
pg.on('console', async (m) => {
  const t = m.text();
  if (!/^\[(Parks|Vegetation|Buildings|Roads|Terrain|Water|Traffic|Transit|People|Props|Landmarks|Sky|VegDiag)\]/.test(t)) return;
  try {
    const h = await pg.evaluate(() => Math.round(performance.memory.usedJSHeapSize / 1048576));
    marks.push(`${String(h).padStart(4)}MB  ${t.slice(0, 118)}`);
  } catch { /* page gone */ }
});
await pg.evaluateOnNewDocument(() => {
  try { localStorage.setItem('bh-onboarded', '1'); } catch { /* private */ }
  window.__peak = 0; window.__trace = [];
  const t0 = performance.now();
  setInterval(() => {
    const m = performance.memory?.usedJSHeapSize || 0;
    if (m > window.__peak) window.__peak = m;
    window.__trace.push([Math.round(performance.now() - t0), Math.round(m / 1048576)]);
  }, 150);
});
await pg.goto(`http://localhost:${PORT}/${process.env.Q ? `?q=${process.env.Q}` : ''}`,
  { waitUntil: 'networkidle2', timeout: 180000 });
await pg.waitForFunction('window.__ready === true', { timeout: 300000 });
await pg.evaluate(() => window.__debug.settle(400));
await new Promise((r) => setTimeout(r, 9000));
const cdp = await pg.target().createCDPSession();
await cdp.send('HeapProfiler.enable');
await cdp.send('HeapProfiler.collectGarbage');
await cdp.send('HeapProfiler.collectGarbage');
await new Promise((r) => setTimeout(r, 1500));
const r = await pg.evaluate(() => {
  let bytes = 0; const seen = new Set(); const per = {};
  window.__boston.ctx.scene.traverse((o) => {
    const g = o.geometry; if (!g || seen.has(g)) return; seen.add(g);
    let n = 0;
    for (const k in g.attributes) { const a = g.attributes[k]; if (a?.array) n += a.array.byteLength; }
    if (g.index?.array) n += g.index.array.byteLength;
    bytes += n;
    const key = (o.name || '?').replace(/\d+$/, '').replace(/:\d+$/, '');
    per[key] = (per[key] || 0) + n;
  });
  const top = Object.entries(per).sort((a, c) => c[1] - a[1]).slice(0, 12)
    .map(([k, v]) => `${k}=${(v / 1048576).toFixed(1)}`).join(' ');
  const s = window.__debug.stats();
  return { peakMB: Math.round(window.__peak / 1048576),
    settledMB: Math.round(performance.memory.usedJSHeapSize / 1048576),
    cpuGeoMB: +(bytes / 1048576).toFixed(1), top,
    trees: s.trees, parkTris: s.parkTris, fps: s.fps,
    curve: window.__trace.filter((_, i) => i % 6 === 0).map((p) => p[1]).join(',') };
});
for (const m of marks) console.log(m);
console.log(JSON.stringify(r, null, 1));
await b.close(); srv.kill();
