#!/usr/bin/env node
/**
 * Ground-traffic visual QA: single-shot capture at named viewpoints.
 *
 * Scoped to this task's own port and output directory so it never collides
 * with another agent's QA run: always dist-qa, always :4571. Mirrors
 * qa/shoot.mjs's boot sequence but writes only into qa/shots/ground/.
 *
 *   node qa/_groundshoot.mjs downtown-traffic comm-ave --tag before
 *   node qa/_groundshoot.mjs high-street --no-build --tag after
 *
 * With no viewpoint ids given, shoots the set called out in the brief:
 * downtown-traffic, comm-ave, common-street, street-night, high-street, copley.
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
const DEFAULT_IDS = ['downtown-traffic', 'comm-ave', 'common-street', 'street-night', 'high-street', 'copley'];

const argv = process.argv.slice(2);
const flag = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : d; };
const has = (n) => argv.includes(`--${n}`);
const TAG = flag('tag', '');
const TIER = flag('tier', 'high');
const IDS = argv.filter((a, i) => !a.startsWith('--') && !argv[i - 1]?.startsWith('--'));

function log(...a) { console.log('[ground]', ...a); }

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
  const wanted = IDS.length ? viewpoints.filter((v) => IDS.includes(v.id))
    : viewpoints.filter((v) => DEFAULT_IDS.includes(v.id));
  if (!wanted.length) throw new Error(`no viewpoints matched: ${IDS.join(', ')}`);

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

  const results = [];
  for (const v of wanted) {
    await page.evaluate((vp) => {
      window.__debug.setTime(vp.hour);
      window.__debug.setView(vp.pos, vp.target);
    }, v);
    await page.evaluate(() => window.__debug.settle(60));
    await new Promise((r) => setTimeout(r, 500));

    const name = TAG ? `${v.id}--${TAG}.png` : `${v.id}.png`;
    const file = path.join(OUT, name);
    await page.screenshot({ path: file });
    const stats = await page.evaluate(() => window.__debug.stats());
    results.push({ id: v.id, file, stats });
    log(`shot ${name}  fps=${stats.fps} vehicles=${stats.vehiclesDrawn} peds=${stats.pedestriansDrawn}`);
  }

  await writeFile(
    path.join(OUT, `report${TAG ? `--${TAG}` : ''}.json`),
    JSON.stringify({ when: new Date().toISOString(), results, errors }, null, 2),
  );
  await browser.close();
  server.kill();

  if (errors.length) {
    console.error('\n[ground] PAGE ERRORS:\n' + errors.slice(0, 25).join('\n'));
    process.exit(2);
  }
  log('done ->', OUT);
}

main().catch((e) => { console.error('[ground] FAILED:', e.message); process.exit(1); });
