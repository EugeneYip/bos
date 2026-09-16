#!/usr/bin/env node
/**
 * Logan airport visual QA capture. Modelled on `qa/shoot.mjs` but scoped to
 * this task: its own viewpoints (not `qa/viewpoints.json`, which other agents
 * share), a fixed port/outDir per the task's hard constraints, and a
 * `--seq` mode that advances the sim with `__debug.settle(n)` between shots
 * so ground-vehicle motion (taxi, takeoff roll, rollout) is visible across a
 * sequence rather than judged from one frame.
 *
 *   node qa/_logan_shoot.mjs                     # every named viewpoint, once
 *   node qa/_logan_shoot.mjs logan-runway         # one viewpoint
 *   node qa/_logan_shoot.mjs --seq logan-holdshort 300 8   # 8 shots, 300 frames apart
 *   node qa/_logan_shoot.mjs --no-build           # reuse the last dist-qa build
 */
import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SHOTS = path.join(ROOT, 'qa', 'shots', 'logan');
const PORT = 4572;
const OUTDIR = 'dist-qa';

const argv = process.argv.slice(2);
const has = (n) => argv.includes(`--${n}`);
const TIER = 'high';

// Real Logan camera poses, worked out from the actual runway/taxiway/apron
// geometry recovered at runtime (see src/world/airport/layout.ts) — not
// borrowed from qa/viewpoints.json, which belongs to other agents.
const VIEWS = {
  'logan-approach': {
    pos: [900, 300, -1250], target: [4100, 10, -900], hour: 16.0,
    note: 'Wide establishing shot from the North End waterfront across the harbour toward Logan.',
  },
  'logan-0927': {
    pos: [3771, 480, -1550], target: [3771, 5, -644], hour: 12.8,
    note: 'The reconstructed 09/27 crosswind runway (no OSM polygon; see layout.ts header).',
  },
  'logan-runway': {
    pos: [4010, 230, 640], target: [4650, 15, -820], hour: 12.8,
    note: 'Oblique aerial down runway 04R/22L: threshold, touchdown zone, centreline.',
  },
  'logan-threshold': {
    pos: [3970, 70, 520], target: [4230, 8, 60], hour: 12.8,
    note: 'Low approach-path view of the 04R threshold bars and numerals.',
  },
  'logan-apron': {
    pos: [3970, 55, -1060], target: [3880, 45, -1170], hour: 13.5,
    note: 'Apron level near the terminal ramp, control tower and gates.',
  },
  'logan-holdshort': {
    pos: [4260, 45, 470], target: [4190, 10, 300], hour: 13.5,
    note: 'Hold-short pad beside the 04R threshold, for the ground-movement sequence.',
  },
  'logan-taxi-wide': {
    pos: [4550, 260, -700], target: [4250, 10, -200], hour: 13.5,
    note: 'Wide oblique covering apron, taxi route and runway threshold together.',
  },
  'logan-night': {
    pos: [4010, 200, 640], target: [4650, 15, -820], hour: 20.6,
    note: 'Same as logan-runway, after dark, for edge/approach lighting.',
  },
};

function log(...a) { console.log('[logan-qa]', ...a); }

async function ensureBuild() {
  if (has('no-build') && existsSync(path.join(ROOT, OUTDIR, 'index.html'))) return;
  log(`building -> ${OUTDIR}`);
  await new Promise((res, rej) => {
    const p = spawn('npx', ['vite', 'build', '--outDir', OUTDIR], { cwd: ROOT, stdio: 'pipe', env: { ...process.env, VITE_BASE: '/' } });
    let out = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (out += d));
    p.on('exit', (c) => (c === 0 ? res() : rej(new Error(`vite build failed:\n${out.slice(-3000)}`))));
  });
}

async function startServer() {
  const p = spawn('npx', ['vite', 'preview', '--port', String(PORT), '--strictPort', '--outDir', OUTDIR], {
    cwd: ROOT, stdio: 'pipe', env: { ...process.env, VITE_BASE: '/' },
  });
  p.stdout.on('data', () => {});
  p.stderr.on('data', () => {});
  for (let i = 0; i < 120; i++) {
    try {
      const r = await fetch(`http://localhost:${PORT}/`);
      if (r.ok) return p;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  p.kill();
  throw new Error('preview server did not start');
}

async function main() {
  await mkdir(SHOTS, { recursive: true });

  await ensureBuild();
  const server = await startServer();
  log(`serving on :${PORT}`);

  const browser = await puppeteer.launch({
    headless: true,
    args: [
      '--no-sandbox', '--enable-gpu', '--use-angle=metal', '--enable-unsafe-swiftshader',
      '--ignore-gpu-blocklist', '--enable-webgl', '--enable-webgl2-compute-context',
      '--window-size=1600,900', '--hide-scrollbars', '--mute-audio',
    ],
  });

  const errors = [];
  const page = await browser.newPage();
  await page.setViewport({ width: 1600, height: 900, deviceScaleFactor: 1 });
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.evaluateOnNewDocument(() => { try { localStorage.setItem('bh-onboarded', '1'); } catch { /* private mode */ } });

  log('loading app… (this environment boots slowly — allow a couple of minutes)');
  await page.goto(`http://localhost:${PORT}/?q=${TIER}`, { waitUntil: 'networkidle2', timeout: 180000 });
  await page.waitForFunction('window.__ready === true', { timeout: 300000 });
  await page.waitForFunction('window.__debug !== undefined', { timeout: 30000 });
  log('app ready');

  const results = [];

  const seqIdx = argv.indexOf('--seq');
  if (seqIdx >= 0) {
    const id = argv[seqIdx + 1];
    const frames = Number(argv[seqIdx + 2] || 240);
    const count = Number(argv[seqIdx + 3] || 6);
    const v = VIEWS[id];
    if (!v) throw new Error(`unknown viewpoint: ${id}`);
    await page.evaluate((vp) => { window.__debug.setTime(vp.hour); window.__debug.setView(vp.pos, vp.target); }, v);
    await page.evaluate(() => window.__debug.settle(45));
    for (let i = 0; i < count; i++) {
      await page.evaluate((vp) => { window.__debug.setView(vp.pos, vp.target); }, v);
      const name = `${id}--seq${String(i).padStart(2, '0')}.png`;
      const file = path.join(SHOTS, name);
      await page.screenshot({ path: file });
      const stats = await page.evaluate(() => window.__debug.stats());
      results.push({ id: name, file, stats });
      log(`shot ${name}  fps=${stats.fps}`);
      await page.evaluate((f) => window.__debug.settle(f), frames);
    }
  } else {
    const ids = argv.filter((a) => !a.startsWith('--') && VIEWS[a]);
    const wanted = ids.length ? ids : Object.keys(VIEWS);
    for (const id of wanted) {
      const v = VIEWS[id];
      await page.evaluate((vp) => { window.__debug.setTime(vp.hour); window.__debug.setView(vp.pos, vp.target); }, v);
      await page.evaluate(() => window.__debug.settle(60));
      await new Promise((r) => setTimeout(r, 500));
      await page.evaluate((vp) => { window.__debug.setTime(vp.hour); window.__debug.setView(vp.pos, vp.target); }, v);
      await page.evaluate(() => window.__debug.settle(30));

      const name = `${id}.png`;
      const file = path.join(SHOTS, name);
      await page.screenshot({ path: file });
      const stats = await page.evaluate(() => window.__debug.stats());
      results.push({ id, file, stats });
      log(`shot ${name}  fps=${stats.fps} calls=${stats.calls} tris=${stats.tris}`);
    }
  }

  await writeFile(path.join(SHOTS, 'report.json'), JSON.stringify({ when: new Date().toISOString(), results, errors }, null, 2));
  await browser.close();
  server.kill();

  if (errors.length) {
    console.error('[logan-qa] console/page errors during capture:');
    for (const e of errors) console.error('  ', e);
    process.exitCode = 2;
  }
}

main().catch((err) => { console.error(err); process.exitCode = 1; });
