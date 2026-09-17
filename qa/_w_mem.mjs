/**
 * Water-specific memory: CPU-side attribute bytes held by the water meshes,
 * the whole-scene figure for context, and the heap after a forced GC.
 *
 *   QA_OUTDIR=dist-w TIER=high node qa/_w_mem.mjs
 *   MOBILE_UA=1 TIER=low ... node qa/_w_mem.mjs
 */
import { spawn } from 'node:child_process';
import puppeteer from 'puppeteer';

const ROOT = '/Volumes/Projects/bos';
const PORT = Number(process.env.QA_PORT || 4394);
const TIER = process.env.TIER || 'high';
const srv = spawn('npx', ['vite', 'preview', '--port', String(PORT), '--strictPort', '--outDir', process.env.QA_OUTDIR ?? 'dist-w'],
  { cwd: ROOT, stdio: 'ignore', env: { ...process.env, VITE_BASE: '/' } });
for (let i = 0; i < 160; i++) {
  try { if ((await fetch(`http://localhost:${PORT}/`)).ok) break; } catch { /* waiting */ }
  await new Promise((r) => setTimeout(r, 250));
}
const UA = process.env.MOBILE_UA
  ? 'Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1'
  : null;
const b = await puppeteer.launch({
  headless: true, protocolTimeout: 900000,
  args: ['--no-sandbox', '--enable-gpu', '--use-angle=metal', '--ignore-gpu-blocklist',
    '--enable-webgl', '--js-flags=--expose-gc', '--window-size=1280,720'],
});
const pg = await b.newPage();
await pg.setViewport({ width: 1280, height: 720 });
if (UA) await pg.setUserAgent(UA);
const logs = [];
pg.on('console', (m) => { const t = m.text(); if (t.includes('[Water]')) logs.push(t); });
await pg.evaluateOnNewDocument(() => { try { localStorage.setItem('bh-onboarded', '1'); } catch { /* private */ } });
await pg.goto(`http://localhost:${PORT}/?q=${TIER}`, { waitUntil: 'networkidle2', timeout: 180000 });
await pg.waitForFunction('window.__ready === true', { timeout: 300000 });
await pg.evaluate(() => window.__debug.settle(300));
await new Promise((r) => setTimeout(r, 6000));
// Sweep the camera so every water chunk is drawn at least once: an attribute
// is only released by `onUpload`, and a chunk that is never rendered is never
// uploaded and so never releases.
for (const [pos, tgt] of [[[0, 2600, 0], [0, 0, 1]], [[0, 2600, 0], [1, 0, 0]],
  [[0, 2600, 0], [0, 0, -1]], [[0, 2600, 0], [-1, 0, 0]]]) {
  await pg.evaluate((p, t) => window.__debug.setView(p, t), pos, tgt);
  await pg.evaluate(() => window.__debug.settle(30));
}
const cdp = await pg.target().createCDPSession();
await cdp.send('HeapProfiler.enable');
await cdp.send('HeapProfiler.collectGarbage');
await cdp.send('HeapProfiler.collectGarbage');
await new Promise((r) => setTimeout(r, 1500));
const r = await pg.evaluate(() => {
  let all = 0, water = 0, waterKept = 0, waterNulled = 0, waterTris = 0;
  const seen = new Set();
  window.__boston.ctx.scene.traverse((o) => {
    const g = o.geometry;
    if (!g || seen.has(g)) return;
    seen.add(g);
    const isWater = (o.name || '').startsWith('water:');
    let bytes = 0;
    for (const k in g.attributes) { const a = g.attributes[k]; if (a && a.array) bytes += a.array.byteLength; }
    if (g.index && g.index.array) bytes += g.index.array.byteLength;
    all += bytes;
    if (isWater) {
      water += bytes;
      waterTris += (g.index ? g.index.count : (g.attributes.position?.count ?? 0)) / 3;
      for (const k in g.attributes) { if (g.attributes[k].array) waterKept++; else waterNulled++; }
    }
  });
  const s = window.__debug.stats();
  return {
    heapMB: Math.round(performance.memory.usedJSHeapSize / 1048576),
    sceneGeoMB: +(all / 1048576).toFixed(1),
    waterGeoMB: +(water / 1048576).toFixed(2),
    waterKept, waterNulled,
    waterTrisK: Math.round(waterTris / 1000),
    waterBodies: s.waterBodies, statWaterTrisK: Math.round((s.waterTris ?? 0) / 1000),
  };
});
console.log(`tier=${TIER}${UA ? ' mobileUA' : ''}`, JSON.stringify(r));
for (const l of logs) console.log(' ', l);
await b.close();
srv.kill();
