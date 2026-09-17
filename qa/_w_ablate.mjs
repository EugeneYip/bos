/**
 * Water QA: shoot one pose several times in one page session, switching a
 * single shader term off between shots.
 *
 * Needs a build whose water shader was compiled with `?wdbg` (see
 * `WATER_DEBUG` in src/world/Water.ts), which publishes `window.__water`.
 *
 * Auto-exposure still moves a little between arms, so the reported exposure
 * is printed with every shot: divide out, or compare regions inside one arm.
 *
 *   POSE='{"pos":[...],"target":[...],"hour":21.5}' \
 *   ARMS='[["base",{}],["noglow",{"uDbg2":[0,1,0,0.78]}]]' \
 *   QA_OUTDIR=dist-w QA_PORT=4413 TIER=high OUT=/tmp/ab node qa/_w_ablate.mjs
 */
import { spawn } from 'node:child_process';
import puppeteer from 'puppeteer';

const ROOT = '/Volumes/Projects/bos';
const PORT = Number(process.env.QA_PORT || 4413);
const DIST = process.env.QA_OUTDIR || 'dist-w';
const TIER = process.env.TIER || 'high';
const W = Number(process.env.QA_W || 1600);
const H = Number(process.env.QA_H || 900);
const POSE = JSON.parse(process.env.POSE);
const ARMS = JSON.parse(process.env.ARMS || '[["base",{}]]');
const OUT = process.env.OUT || '/tmp/wab';

const srv = spawn('npx', ['vite', 'preview', '--port', String(PORT), '--strictPort', '--outDir', DIST],
  { cwd: ROOT, stdio: 'ignore', env: { ...process.env, VITE_BASE: '/' } });
for (let i = 0; i < 160; i++) {
  try { if ((await fetch(`http://localhost:${PORT}/`)).ok) break; } catch { /* waiting */ }
  await new Promise((r) => setTimeout(r, 250));
}
const b = await puppeteer.launch({
  headless: true, protocolTimeout: 900000,
  args: ['--no-sandbox', '--enable-gpu', '--use-angle=metal', '--enable-unsafe-swiftshader',
    '--ignore-gpu-blocklist', '--enable-webgl', `--window-size=${W},${H}`],
});
const pg = await b.newPage();
await pg.setViewport({ width: W, height: H, deviceScaleFactor: 1 });
// MOBILE in src/core/gpu.ts is a user-agent test, so this is the only way to
// exercise the mobile paths (the coarse water lattice, the attribute release)
// from a desktop harness.
if (process.env.MOBILE_UA) {
  await pg.setUserAgent('Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15'
    + ' (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1');
}
await pg.evaluateOnNewDocument((res) => {
  try {
    localStorage.removeItem('bh-tier');
    localStorage.setItem('bh-onboarded', '1');
    if (res) localStorage.setItem('bh-res', res); else localStorage.removeItem('bh-res');
  } catch { /* private mode */ }
}, process.env.QA_RES ?? '');
await pg.goto(`http://localhost:${PORT}/?q=${TIER}&wdbg=1`, { waitUntil: 'networkidle2', timeout: 180000 });
await pg.waitForFunction('window.__ready === true', { timeout: 300000 });
await pg.waitForFunction('window.__water !== undefined', { timeout: 60000 });
await new Promise((r) => setTimeout(r, 5000));
await pg.evaluate((h) => window.__debug.setTime(h), POSE.hour);
await pg.evaluate((p, t) => window.__debug.setView(p, t), POSE.pos, POSE.target);
await new Promise((r) => setTimeout(r, 4000));
await pg.evaluate(() => window.__debug.settle(60));

for (const [name, sets] of ARMS) {
  await pg.evaluate((s) => {
    window.__water.set('uDbg', [1, 1, 1, 1]);
    window.__water.set('uDbg2', [1, 1, 0, 1]);
    window.__water.set('uReflStrength', 1);
    for (const [k, v] of Object.entries(s)) window.__water.set(k, v);
  }, sets);
  await pg.evaluate(() => window.__debug.settle(45));
  await new Promise((r) => setTimeout(r, 400));
  await pg.evaluate(() => window.__debug.settle(30));
  const probe = await pg.evaluate(() => window.__debug.probe());
  await pg.screenshot({ path: `${OUT}-${name}.png` });
  console.log(`[ablate] ${name.padEnd(12)} exposure=${probe.exposure.toFixed(3)} -> ${OUT}-${name}.png`);
}
await b.close();
srv.kill();
