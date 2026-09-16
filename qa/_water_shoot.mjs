#!/usr/bin/env node
/**
 * Water/vessel visual-QA capture harness (agent-local, mirrors qa/shoot.mjs).
 *
 * Does NOT modify qa/shoot.mjs or qa/viewpoints.json. Reads a shot list from
 * a JSON file (array of {id,pos,target,hour,dayOfYear?,tag?,settle?,wait?,
 * postSettle?}) and writes PNGs to qa/shots/water/.
 *
 *   node qa/_water_shoot.mjs qa/_water_shots.json --tag before
 *   QA_PORT=4552 QA_OUTDIR=dist-qa node qa/_water_shoot.mjs shots.json
 *
 * Assumes a `vite preview` server is already up on QA_PORT against
 * QA_OUTDIR; if it isn't, this spawns one itself (dist must already be built
 * with `VITE_BASE=/ npx vite build --outDir dist-qa`).
 */
import { spawn } from 'node:child_process';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'qa', 'shots', 'water');
const PORT = Number(process.env.QA_PORT || 4552);
const OUTDIR = process.env.QA_OUTDIR || 'dist-qa';

const argv = process.argv.slice(2);
const flag = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : d; };
const WIDTH = Number(flag('width', 1600));
const HEIGHT = Number(flag('height', 900));
const TAG = flag('tag', '');
const TIER = flag('tier', 'ultra');
const POST = flag('post', '');
const shotsFile = argv.find((a) => !a.startsWith('--') && argv[argv.indexOf(a) - 1] !== '--tag'
  && argv[argv.indexOf(a) - 1] !== '--tier' && argv[argv.indexOf(a) - 1] !== '--width'
  && argv[argv.indexOf(a) - 1] !== '--height');

function log(...a) { console.log('[water-qa]', ...a); }

async function ensureServer() {
  try {
    const r = await fetch(`http://localhost:${PORT}/`);
    if (r.ok) { log(`reusing server on :${PORT}`); return null; }
  } catch { /* not up */ }
  if (!existsSync(path.join(ROOT, OUTDIR, 'index.html'))) {
    throw new Error(`${OUTDIR}/index.html missing — build first with: VITE_BASE=/ npx vite build --outDir ${OUTDIR}`);
  }
  log(`starting preview server :${PORT} from ${OUTDIR}`);
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
  if (!shotsFile) throw new Error('usage: node qa/_water_shoot.mjs <shots.json> [--tag t] [--tier ultra]');
  await mkdir(OUT, { recursive: true });
  const shots = JSON.parse(await readFile(path.resolve(ROOT, shotsFile), 'utf8'));

  const server = await ensureServer();

  const browser = await puppeteer.launch({
    headless: 'shell' === process.env.QA_HEADLESS ? 'shell' : true,
    timeout: 90000,
    protocolTimeout: 300000,
    args: [
      '--no-sandbox',
      '--enable-gpu',
      '--use-angle=metal',
      '--enable-unsafe-swiftshader',
      '--ignore-gpu-blocklist',
      '--enable-webgl',
      '--enable-webgl2-compute-context',
      `--window-size=${WIDTH},${HEIGHT}`,
      '--hide-scrollbars',
      '--mute-audio',
    ],
  });

  const errors = [];
  const page = await browser.newPage();
  await page.setViewport({ width: WIDTH, height: HEIGHT, deviceScaleFactor: 1 });
  page.on('console', (m) => { if (m.type() === 'error') { errors.push(m.text()); if (process.env.QA_VERBOSE) log('console-error:', m.text()); } });
  page.on('pageerror', (e) => { errors.push(String(e)); if (process.env.QA_VERBOSE) log('pageerror:', String(e)); });

  log('loading app…');
  await page.evaluateOnNewDocument(() => {
    try { localStorage.setItem('bh-onboarded', '1'); } catch { /* private mode */ }
  });
  await page.goto(`http://localhost:${PORT}/?q=${TIER}${POST ? `&post=${POST}` : ''}`, { waitUntil: 'networkidle2', timeout: 180000 });
  try {
    await page.waitForFunction('window.__ready === true', { timeout: 420000 });
    await page.waitForFunction('window.__debug !== undefined', { timeout: 420000 });
  } catch (e) {
    log('boot wait failed:', e.message, '— errors so far:', errors.slice(0, 10));
    throw e;
  }
  log('app ready');

  const results = [];
  for (const v of shots) {
    await page.evaluate((vp) => {
      window.__debug.setTime(vp.hour, vp.dayOfYear);
      window.__debug.setView(vp.pos, vp.target);
    }, v);
    await page.evaluate((n) => window.__debug.settle(n), v.settle ?? 45);
    await new Promise((r) => setTimeout(r, v.wait ?? 500));
    await page.evaluate((vp) => {
      window.__debug.setTime(vp.hour, vp.dayOfYear);
      window.__debug.setView(vp.pos, vp.target);
    }, v);
    await page.evaluate((n) => window.__debug.settle(n), v.settle ?? 30);
    // Optional extra settle *without* resetting the view again, so a boat can
    // swim into frame and its wake can build up before the shutter.
    if (v.postSettle) await page.evaluate((n) => window.__debug.settle(n), v.postSettle);

    const name = TAG ? `${v.id}--${TAG}.png` : `${v.id}.png`;
    const file = path.join(OUT, name);
    await page.screenshot({ path: file });
    const stats = await page.evaluate(() => window.__debug.stats());
    results.push({ id: v.id, file, stats });
    log(`shot ${name}  fps=${stats.fps} low=${stats['fps.low']} calls=${stats.calls} tris=${stats.tris} water=${stats['water.ms']}`);
  }

  await writeFile(path.join(OUT, `report${TAG ? `-${TAG}` : ''}.json`),
    JSON.stringify({ when: new Date().toISOString(), results, errors }, null, 2));
  await browser.close();
  if (server) server.kill();

  if (errors.length) {
    console.error('\n[water-qa] PAGE ERRORS:\n' + errors.slice(0, 25).join('\n'));
  }
  log('done ->', OUT);
}

main().catch((e) => { console.error('[water-qa] FAILED:', e.message); process.exit(1); });
