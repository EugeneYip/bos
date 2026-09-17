/**
 * Water QA: shoot one pose twice in a single page session, once with a named
 * object group visible and once hidden, so a feature can be attributed to the
 * module that draws it.
 *
 * One session means one auto-exposure history and one set of baked LUTs, so
 * the two frames are comparable in a way that two builds never are. Boats and
 * cars still move between them, so compare regions, not whole frames.
 *
 *   POSE='{"pos":[...],"target":[...],"hour":17.1}' HIDE=water \
 *   QA_OUTDIR=dist-w QA_PORT=4412 TIER=high OUT=/tmp/x node qa/_w_toggle.mjs
 */
import { spawn } from 'node:child_process';
import puppeteer from 'puppeteer';

const ROOT = '/Volumes/Projects/bos';
const PORT = Number(process.env.QA_PORT || 4412);
const DIST = process.env.QA_OUTDIR || 'dist-w';
const TIER = process.env.TIER || 'high';
const W = Number(process.env.QA_W || 1600);
const H = Number(process.env.QA_H || 900);
const POSE = JSON.parse(process.env.POSE);
const HIDE = (process.env.HIDE || 'water').split(',');
const OUT = process.env.OUT || '/tmp/wtoggle';

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
await pg.evaluateOnNewDocument((res) => {
  try {
    localStorage.removeItem('bh-tier');
    localStorage.setItem('bh-onboarded', '1');
    if (res) localStorage.setItem('bh-res', res); else localStorage.removeItem('bh-res');
  } catch { /* private mode */ }
}, process.env.QA_RES ?? '');
await pg.goto(`http://localhost:${PORT}/?q=${TIER}`, { waitUntil: 'networkidle2', timeout: 180000 });
await pg.waitForFunction('window.__ready === true', { timeout: 300000 });
await new Promise((r) => setTimeout(r, 5000));
await pg.evaluate((h) => window.__debug.setTime(h), POSE.hour);
await pg.evaluate((p, t) => window.__debug.setView(p, t), POSE.pos, POSE.target);
await new Promise((r) => setTimeout(r, 4000));
await pg.evaluate(() => window.__debug.settle(60));
await pg.screenshot({ path: `${OUT}-on.png` });

for (const h of HIDE) {
  const n = await pg.evaluate((m) => window.__debug.toggle(m, false), h);
  console.log(`[toggle] hid ${n} objects matching "${h}"`);
}
await pg.evaluate(() => window.__debug.settle(40));
await pg.screenshot({ path: `${OUT}-off.png` });
console.log(`[toggle] wrote ${OUT}-on.png ${OUT}-off.png`);
await b.close();
srv.kill();
