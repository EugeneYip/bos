#!/usr/bin/env node
/**
 * What the traffic costs, in milliseconds of frame time.
 *
 * Absolute fps on this machine is useless for an A/B: several agents build and
 * shoot concurrently, and the same build measured twice came back 20 and 23.
 * So this measures the *difference* the traffic makes inside one session —
 * hide it, measure, show it, measure, alternating several times — and reports
 * the *fastest* frame of each arm rather than the mean. External load only
 * ever makes a frame slower, so the left edge of the distribution is the one
 * statistic that survives a load average of 174; the mean of the same samples
 * swung by 30 ms and once made the traffic look free.
 *
 *   QA_PORT=4447 QA_OUTDIR=dist-v node qa/_trafficperf.mjs --view downtown-traffic \
 *     [--tier ultra] [--reps 4] [--ms 2200]
 */
import { spawn, execSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.QA_PORT || 4447);
const OUTDIR = process.env.QA_OUTDIR || 'dist-v';
const argv = process.argv.slice(2);
const flag = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : d; };
const TIER = flag('tier', 'ultra');
const VIEW = flag('view', 'downtown-traffic');
const HOUR = flag('hour', null);
const REPS = Number(flag('reps', '4'));
const MS = Number(flag('ms', '2200'));

// A previous run's preview server can still hold the port. `--strictPort`
// makes the new one fail, the poll below then finds the *old* server healthy,
// and the whole measurement silently reports the old build — which is how a
// before and an after came back byte-identical once.
try {
  execSync(`lsof -ti tcp:${PORT} | xargs -r kill -9`, { stdio: 'ignore', shell: '/bin/bash' });
} catch { /* nothing listening */ }

const srv = spawn('npx', ['vite', 'preview', '--port', String(PORT), '--strictPort', '--outDir', OUTDIR], {
  cwd: ROOT, stdio: 'ignore', env: { ...process.env, VITE_BASE: '/' },
});
for (let i = 0; i < 160; i++) {
  try { if ((await fetch(`http://localhost:${PORT}/`)).ok) break; } catch { /* waiting */ }
  await new Promise((r) => setTimeout(r, 250));
}
const browser = await puppeteer.launch({
  headless: true, protocolTimeout: 900000,
  args: ['--no-sandbox', '--enable-gpu', '--use-angle=metal', '--enable-unsafe-swiftshader',
    '--ignore-gpu-blocklist', '--enable-webgl', '--window-size=1600,900', '--hide-scrollbars'],
});
const page = await browser.newPage();
await page.setViewport({ width: 1600, height: 900, deviceScaleFactor: 1 });
await page.evaluateOnNewDocument(() => { try { localStorage.setItem('bh-onboarded', '1'); } catch { /* */ } });
await page.goto(`http://localhost:${PORT}/?q=${TIER}`, { waitUntil: 'networkidle2', timeout: 180000 });
await page.waitForFunction('window.__ready === true', { timeout: 300000 });

const vps = JSON.parse(await readFile(path.join(ROOT, 'qa/viewpoints.json'), 'utf8'));
const vp = vps.find((v) => v.id === VIEW);
const hour = HOUR !== null ? Number(HOUR) : vp.hour;
await page.evaluate((v, h) => { window.__debug.setView(v.pos, v.target); window.__debug.setTime(h); }, vp, hour);
await page.evaluate(() => window.__debug.settle(120));
await new Promise((r) => setTimeout(r, 1500));

/** Mean and 95th-percentile frame time over `ms` of wall clock, in ms. */
const sample = (ms) => page.evaluate((d) => new Promise((resolve) => {
  const t = [];
  let last = performance.now();
  const stop = last + d;
  const step = () => {
    const now = performance.now();
    t.push(now - last);
    last = now;
    if (now < stop) requestAnimationFrame(step);
    else {
      t.sort((a, b) => a - b);
      const keep = t.slice(0, Math.max(1, Math.floor(t.length * 0.97)));
      const mean = keep.reduce((s, v) => s + v, 0) / keep.length;
      const lo = t.slice(0, Math.max(1, Math.ceil(t.length * 0.1)));
      const p10 = lo.reduce((s, v) => s + v, 0) / lo.length;
      const r = window.__boston.ctx.renderer.info.render;
      resolve({ mean, p10, min: t[0], n: t.length, calls: r.calls, tris: r.triangles });
    }
  };
  requestAnimationFrame(step);
}), ms);

const on = [], off = [];
for (let i = 0; i < REPS; i++) {
  await page.evaluate(() => {
    window.__debug.toggle('traffic:', true);
    window.__debug.toggle('pedestrians', true);
  });
  await page.evaluate(() => window.__debug.settle(20));
  on.push(await sample(MS));
  await page.evaluate(() => {
    window.__debug.toggle('traffic:', false);
    window.__debug.toggle('pedestrians', false);
  });
  await page.evaluate(() => window.__debug.settle(20));
  off.push(await sample(MS));
}
await browser.close(); srv.kill();

const best = (a) => Math.min(...a);
const onMs = best(on.map((s) => s.p10));
const offMs = best(off.map((s) => s.p10));
console.log(JSON.stringify({
  view: VIEW, hour, tier: TIER, outdir: OUTDIR, reps: REPS,
  fastestFrameWithTraffic: +onMs.toFixed(2),
  fastestFrameWithoutTraffic: +offMs.toFixed(2),
  trafficMs: +(onMs - offMs).toFixed(2),
  callsWith: on[0].calls, callsWithout: off[0].calls,
  trisWith: on[0].tris, trisWithout: off[0].tris,
  onP10: on.map((s) => +s.p10.toFixed(2)), offP10: off.map((s) => +s.p10.toFixed(2)),
  onMean: on.map((s) => +s.mean.toFixed(2)), offMean: off.map((s) => +s.mean.toFixed(2)),
}, null, 2));
