/**
 * Water QA: name what is under given screen pixels, and report its luma.
 *
 * Unlike qa/_pick.mjs this runs at the same 1600x900 the shoot harness uses,
 * so pixel coordinates read straight off a qa/shots/*.png are valid, and it
 * takes the tier / outdir / port from the environment like everything else.
 *
 *   POSE='{"pos":[...],"target":[...],"hour":17.1}' \
 *   PTS='[[520,490,"slab"],[945,625,"wake"]]' \
 *   QA_OUTDIR=dist-w QA_PORT=4411 TIER=high node qa/_w_pick.mjs
 */
import { spawn } from 'node:child_process';
import puppeteer from 'puppeteer';

const ROOT = '/Volumes/Projects/bos';
const PORT = Number(process.env.QA_PORT || 4411);
const OUT = process.env.QA_OUTDIR || 'dist-w';
const TIER = process.env.TIER || 'high';
const W = Number(process.env.QA_W || 1600);
const H = Number(process.env.QA_H || 900);
const POSE = JSON.parse(process.env.POSE);
const PTS = JSON.parse(process.env.PTS || '[]');

const srv = spawn('npx', ['vite', 'preview', '--port', String(PORT), '--strictPort', '--outDir', OUT],
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
await new Promise((r) => setTimeout(r, 6000));
await pg.evaluate((h) => window.__debug.setTime(h), POSE.hour);
await pg.evaluate((p, t) => window.__debug.setView(p, t), POSE.pos, POSE.target);
await new Promise((r) => setTimeout(r, 4000));
await pg.evaluate(() => window.__debug.settle(60));

for (const [x, y, label] of PTS) {
  const hits = await pg.evaluate(([a, c]) => window.__debug.pick(a, c, 6), [x, y]);
  console.log(`(${String(x).padStart(4)},${String(y).padStart(3)}) ${String(label).padEnd(18)}`
    + (hits.length ? hits.map((h) => `${h.name}@${h.dist}m`).join('  |  ') : '(nothing)'));
}
console.log(JSON.stringify(await pg.evaluate(() => window.__debug.stats())));
await b.close();
srv.kill();
