/**
 * Count building tiles that no shard can ever unload.
 *
 * `qa/_shardtrace.mjs` shows `loadedShards` going both up AND down (4, 10, 8,
 * 12, 10) while the tile count only ever rises (32, 91, 92, 102, 102). So
 * eviction runs, and removes nothing: between the last two samples two shards
 * were unloaded and zero tiles went with them.
 *
 * `Buildings.assembleTiles` sets `shard: shardOf?.get(key) ?? -1`, and
 * `unloadShard(i)` skips any tile whose `t.shard !== i`. A tile that got -1 is
 * therefore unevictable for every index, forever -- and because its shard is
 * dropped from `loadedShards` anyway, `reconcile` will count that shard as
 * missing next time it comes into range and load a SECOND copy of its tiles.
 * That compounds, which is the shape of the graph.
 *
 * This counts tiles by shard id, so -1 shows up if it is there.
 */
import { spawn } from 'node:child_process';
import puppeteer from 'puppeteer';
const ROOT = '/Volumes/Projects/bos', PORT = Number(process.env.QA_PORT || 4461);
const UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';
const srv = spawn('npx', ['vite','preview','--port',String(PORT),'--strictPort','--outDir', process.env.QA_OUTDIR ?? 'dist-fp'],
  { cwd: ROOT, stdio: 'ignore', env: { ...process.env, VITE_BASE: '/' } });
for (let i=0;i<160;i++){ try { if ((await fetch(`http://localhost:${PORT}/`)).ok) break; } catch {} await new Promise(r=>setTimeout(r,250)); }
const b = await puppeteer.launch({ headless: true, protocolTimeout: 900000,
  args: ['--no-sandbox','--enable-gpu','--use-angle=metal','--ignore-gpu-blocklist','--enable-webgl'] });
const pg = await b.newPage();
await pg.emulate({ userAgent: UA,
  viewport: { width: 393, height: 852, deviceScaleFactor: 1, isMobile: true, hasTouch: true, isLandscape: false } });
await pg.evaluateOnNewDocument(() => {
  Object.defineProperty(navigator, 'maxTouchPoints', { get: () => 5 });
  try { localStorage.setItem('bh-onboarded','1'); } catch {}
});
const missing = [];
pg.on('response', (r) => { if (r.status() === 404) missing.push(r.url()); });
await pg.goto(`http://localhost:${PORT}/?safe=1`, { waitUntil: 'domcontentloaded', timeout: 120000 });
await new Promise(r => setTimeout(r, 1500));
if (missing.some(u => /\/bos\//.test(u))) { await b.close(); srv.kill();
  throw new Error('build made without VITE_BASE=/ -- assets 404 under /bos/'); }
await pg.waitForFunction('window.__ready === true', { timeout: 240000, polling: 500 });
await pg.evaluate(() => window.__debug.settle(240));

const TALLY = () => {
  const m = window.__boston.modules.find((x) => x.name === 'Buildings');
  const tiles = m && m.tiles ? m.tiles : [];
  const byShard = {};
  const keyDup = {};
  for (const t of tiles) {
    const k = String(t.shard);
    byShard[k] = (byShard[k] || 0) + 1;
    const kk = String(t.key);
    keyDup[kk] = (keyDup[kk] || 0) + 1;
  }
  const dupKeys = Object.entries(keyDup).filter(([, n]) => n > 1);
  return {
    tiles: tiles.length,
    loaded: m && m.loadedShards ? [...m.loadedShards].sort((a, c) => a - c) : null,
    orphans: byShard['-1'] || 0,
    shardsPresentInTiles: Object.keys(byShard).filter((k) => k !== '-1').length,
    duplicateKeyCount: dupKeys.length,
    worstDuplicate: dupKeys.sort((a, c) => c[1] - a[1])[0] || null,
  };
};
console.log('boot        ' + JSON.stringify(await pg.evaluate(TALLY)));
for (let i = 1; i <= 9; i++) {
  await pg.evaluate((k) => { const a = k * 0.9;
    window.__debug.setView([1200*Math.cos(a), 220 + 60*Math.sin(a*0.7), 1200*Math.sin(a)], [0, 40, 0]); }, i);
  await pg.evaluate(() => window.__debug.settle(90));
}
console.log('after flight ' + JSON.stringify(await pg.evaluate(TALLY)));
await pg.evaluate(() => { const a = 0.9;
  window.__debug.setView([1200*Math.cos(a), 220 + 60*Math.sin(a*0.7), 1200*Math.sin(a)], [0, 40, 0]); });
await pg.evaluate(() => window.__debug.settle(240));
await pg.evaluate(() => new Promise(r => setTimeout(r, 15000)));
await pg.evaluate(() => window.__debug.settle(120));
console.log('back+15s     ' + JSON.stringify(await pg.evaluate(TALLY)));
await b.close(); srv.kill();
