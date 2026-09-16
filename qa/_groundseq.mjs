#!/usr/bin/env node
/**
 * Ground-traffic movement sequence: one fixed viewpoint, N frames apart in
 * simulated time, so a vehicle's progress, braking and turning across a
 * junction are visible frame to frame. A single still cannot show movement;
 * this is the standard the brief asks for instead.
 *
 * Scoped to this task's own port and output directory: always dist-qa,
 * always :4571, always qa/shots/ground/.
 *
 *   node qa/_groundseq.mjs downtown-traffic --tag after --n 8 --step 40
 *   node qa/_groundseq.mjs comm-ave --no-build --tag before
 */
import { spawn } from 'node:child_process';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'qa', 'shots', 'ground');
const PORT = 4571;
const OUTDIR = 'dist-qa';

const argv = process.argv.slice(2);
const flag = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : d; };
const has = (n) => argv.includes(`--${n}`);
const ID = argv.find((a, i) => !a.startsWith('--') && !argv[i - 1]?.startsWith('--')) || 'downtown-traffic';
const TAG = flag('tag', 'seq');
const TIER = flag('tier', 'high');
const N = Number(flag('n', 6));
const STEP = Number(flag('step', 45));

function log(...a) { console.log('[groundseq]', ...a); }

async function ensureBuild() {
  if (has('no-build') && existsSync(path.join(ROOT, OUTDIR, 'index.html'))) return;
  log(`building -> ${OUTDIR}`);
  await new Promise((res, rej) => {
    const p = spawn('npx', ['vite', 'build', '--outDir', OUTDIR], {
      cwd: ROOT, stdio: 'pipe', env: { ...process.env, VITE_BASE: '/' },
    });
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
    try { const r = await fetch(`http://localhost:${PORT}/`); if (r.ok) return p; } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  p.kill();
  throw new Error('preview server did not start');
}

async function main() {
  await mkdir(OUT, { recursive: true });
  const viewpoints = JSON.parse(await readFile(path.join(ROOT, 'qa', 'viewpoints.json'), 'utf8'));
  const v = viewpoints.find((x) => x.id === ID);
  if (!v) throw new Error(`no such viewpoint: ${ID}`);

  await ensureBuild();
  const server = await startServer();
  log(`serving on :${PORT}`);

  const browser = await puppeteer.launch({
    headless: true,
    args: [
      '--no-sandbox', '--enable-gpu', '--use-angle=metal', '--enable-unsafe-swiftshader',
      '--ignore-gpu-blocklist', '--enable-webgl', '--window-size=1600,900',
      '--hide-scrollbars', '--mute-audio',
    ],
  });
  const errors = [];
  const page = await browser.newPage();
  await page.setViewport({ width: 1600, height: 900, deviceScaleFactor: 1 });
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.evaluateOnNewDocument(() => {
    try { localStorage.setItem('bh-onboarded', '1'); } catch { /* private mode */ }
  });
  await page.goto(`http://localhost:${PORT}/?q=${TIER}`, { waitUntil: 'networkidle2', timeout: 180000 });
  await page.waitForFunction('window.__ready === true', { timeout: 300000 });
  await page.waitForFunction('window.__debug !== undefined', { timeout: 30000 });
  log('app ready');

  // Camera parked once; time then advances with the sim clock so vehicles
  // already on screen are the ones whose progress we are watching.
  await page.evaluate((vp) => {
    window.__debug.setTime(vp.hour);
    window.__debug.setView(vp.pos, vp.target);
  }, v);
  await page.evaluate(() => window.__debug.settle(60));
  await new Promise((r) => setTimeout(r, 500));

  const results = [];
  for (let i = 0; i < N; i++) {
    const name = `${ID}--${TAG}--t${String(i).padStart(2, '0')}.png`;
    await page.screenshot({ path: path.join(OUT, name) });
    const stats = await page.evaluate(() => window.__debug.stats());
    results.push({ i, file: name, stats });
    log(`t${i}  fps=${stats.fps} vehicles=${stats.vehiclesDrawn} peds=${stats.pedestriansDrawn}`);
    if (i < N - 1) await page.evaluate((n) => window.__debug.settle(n), STEP);
  }

  await writeFile(
    path.join(OUT, `report--${ID}--${TAG}.json`),
    JSON.stringify({ when: new Date().toISOString(), id: ID, n: N, step: STEP, results, errors }, null, 2),
  );
  await browser.close();
  server.kill();

  if (errors.length) {
    console.error('\n[groundseq] PAGE ERRORS:\n' + errors.slice(0, 25).join('\n'));
    process.exit(2);
  }
  log('done ->', OUT);
}

main().catch((e) => { console.error('[groundseq] FAILED:', e.message); process.exit(1); });
