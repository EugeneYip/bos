/**
 * Is building-shard eviction reached at all on a moving camera?
 *
 * `qa/_retainwho.mjs` shows building geometry going 37 -> 93 meshes and
 * 29.5 -> 70.7 MB over a 45 s flight, never falling, including 15 s parked
 * back at the opening pose where most of those shards are far outside the
 * keep radius. `reconcile` and `unloadShard` both read correctly, so the
 * question is whether `reconcile` runs. It is gated on TWO conditions --
 * a 30-frame countdown AND the camera having moved 150 m -- and that pair is
 * the one place correct-looking eviction code silently never fires.
 */
import { spawn } from 'node:child_process';
import puppeteer from 'puppeteer';
const ROOT = '/Volumes/Projects/bos', PORT = Number(process.env.QA_PORT || 4441);
const UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';
const SAFE = process.env.SAFE ?? '1';
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
const logs = [];
pg.on('console', (m) => { const t = m.text(); if (/Buildings|safe|streaming/i.test(t)) logs.push(t.slice(0, 150)); });
const missing = [];
pg.on('response', (r) => { if (r.status() === 404) missing.push(r.url()); });
await pg.goto(`http://localhost:${PORT}/?safe=${SAFE}`, { waitUntil: 'domcontentloaded', timeout: 120000 });
await new Promise(r => setTimeout(r, 1500));
if (missing.some(u => /\/bos\//.test(u))) { await b.close(); srv.kill();
  throw new Error('build made without VITE_BASE=/ -- assets 404 under /bos/'); }
await pg.waitForFunction('window.__ready === true', { timeout: 240000, polling: 500 });
await pg.evaluate(() => window.__debug.settle(240));

// Reach into the module: how many shards does it think are loaded, and how
// many does its OWN keep-test say should be?
const PEEK = () => {
  const app = window.__boston;
  const m = app.modules.find((x) => x.name === 'Buildings') ?? null;
  const s = window.__debug.stats();
  const priv = m as unknown as Record<string, unknown> | null;
  return {
    shards: s.buildingShards, tiles: s.buildingTiles,
    streaming: priv ? priv.streaming : '(no module)',
    radius: priv ? priv.radius : null,
    loaded: priv && priv.loadedShards ? (priv.loadedShards as Set<number>).size : null,
    loading: priv && priv.loadingShards ? (priv.loadingShards as Set<number>).size : null,
    countdown: priv ? priv.streamCountdown : null,
  };
};
const out = [{ t: 'boot', ...(await pg.evaluate(PEEK)) }];
for (let i = 1; i <= 9; i++) {
  await pg.evaluate((k) => { const a = k * 0.9;
    window.__debug.setView([1200*Math.cos(a), 220 + 60*Math.sin(a*0.7), 1200*Math.sin(a)], [0, 40, 0]); }, i);
  await pg.evaluate(() => window.__debug.settle(90));
  if (i % 3 === 0) out.push({ t: `step${i}`, ...(await pg.evaluate(PEEK)) });
}
await pg.evaluate(() => { const a = 0.9;
  window.__debug.setView([1200*Math.cos(a), 220 + 60*Math.sin(a*0.7), 1200*Math.sin(a)], [0, 40, 0]); });
await pg.evaluate(() => window.__debug.settle(240));
await pg.evaluate(() => new Promise(r => setTimeout(r, 15000)));
await pg.evaluate(() => window.__debug.settle(120));
out.push({ t: 'back+15s', ...(await pg.evaluate(PEEK)) });
for (const o of out) console.log(JSON.stringify(o));
console.log('--- logs ---');
for (const l of logs.slice(0, 6)) console.log(l);
await b.close(); srv.kill();
