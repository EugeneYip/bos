#!/usr/bin/env node
/**
 * Material-inspector capture harness (Materials module).
 *
 * Boots the Vite dev server on its own port, drives
 * `src/materials/qa/inspector.html` through `window.__mat`, and writes one
 * six-panel contact sheet per surface family to qa/shots/mat/.
 *
 *   QA_PORT=4331 node qa/shoot-mat.mjs                 # every family
 *   QA_PORT=4331 node qa/shoot-mat.mjs brick glass     # a subset
 *   QA_PORT=4331 node qa/shoot-mat.mjs --grid          # contact sheet only
 *   QA_PORT=4331 node qa/shoot-mat.mjs --tag before    # suffix filenames
 *
 * Exit 2 means the page threw — that is a broken build, not a styling note.
 */
import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SHOTS = path.join(ROOT, 'qa', 'shots', 'mat');
const PORT = Number(process.env.QA_PORT || 4331);

const argv = process.argv.slice(2);
const flag = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : d; };
const has = (n) => argv.includes(`--${n}`);
const TAG = flag('tag', '');
const TIER = flag('tier', 'ultra');
const ONLY = argv.filter((a, i) => !a.startsWith('--') && !(argv[i - 1] || '').startsWith('--'));

const W = 1680;
const H = 1020;

function log(...a) { console.log('[mat]', ...a); }

async function startServer() {
  const p = spawn('npx', ['vite', '--port', String(PORT), '--strictPort', '--host', '127.0.0.1'], {
    cwd: ROOT, stdio: 'pipe', env: { ...process.env, VITE_BASE: '/' },
  });
  p.stdout.on('data', () => {});
  p.stderr.on('data', (d) => process.env.QA_VERBOSE && process.stderr.write(d));
  for (let i = 0; i < 160; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/src/materials/qa/inspector.html`);
      if (r.ok) return p;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  p.kill();
  throw new Error('vite dev server did not start');
}

async function main() {
  await mkdir(SHOTS, { recursive: true });
  const server = await startServer();
  log(`serving on :${PORT}`);

  const browser = await puppeteer.launch({
    headless: true,
    args: [
      '--no-sandbox', '--enable-gpu', '--use-angle=metal', '--enable-unsafe-swiftshader',
      '--ignore-gpu-blocklist', '--enable-webgl', `--window-size=${W},${H}`,
      '--hide-scrollbars', '--mute-audio',
    ],
  });

  const errors = [];
  const page = await browser.newPage();
  await page.setViewport({ width: W, height: H, deviceScaleFactor: 1 });
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(String(e)));

  const url = `http://127.0.0.1:${PORT}/src/materials/qa/inspector.html?q=${TIER}&m=brick`;
  log('loading', url);
  await page.goto(url, { waitUntil: 'networkidle2', timeout: 180000 });
  await page.waitForFunction('window.__ready === true', { timeout: 180000 });

  const probe = await page.evaluate(() => window.__mat.probe('brick'));
  log('probe', JSON.stringify(probe));

  const all = await page.evaluate(() => window.__mat.names());
  const names = ONLY.length ? all.filter((n) => ONLY.includes(n)) : all;
  const results = [];

  if (!has('no-grid')) {
    const info = await page.evaluate(() => window.__mat.grid());
    await new Promise((r) => setTimeout(r, 350));
    const file = path.join(SHOTS, TAG ? `_all--${TAG}.png` : '_all.png');
    await page.screenshot({ path: file });
    log('shot _all.png', JSON.stringify(info));
    results.push({ id: '_all', file, info });
  }

  if (!has('grid')) {
    for (const name of names) {
      const info = await page.evaluate((n) => window.__mat.show(n), name);
      await new Promise((r) => setTimeout(r, 180));
      const file = path.join(SHOTS, TAG ? `${name}--${TAG}.png` : `${name}.png`);
      await page.screenshot({ path: file });
      results.push({ id: name, file, info });
      log(`shot ${name}.png  tile=${info.tile}m res=${info.res} vram=${info.vram}`);
    }
  }

  const stats = await page.evaluate(() => window.__mat.stats());
  await writeFile(
    path.join(SHOTS, 'report.json'),
    JSON.stringify({ when: new Date().toISOString(), tier: TIER, stats, results, errors }, null, 2),
  );

  await browser.close();
  server.kill();

  if (errors.length) {
    console.error('\n[mat] PAGE ERRORS:\n' + errors.slice(0, 25).join('\n'));
    process.exit(2);
  }
  log('done ->', SHOTS, JSON.stringify(stats));
}

main().catch((e) => { console.error('[mat] FAILED:', e.message); process.exit(1); });
