#!/usr/bin/env node
/**
 * Deterministic visual-QA capture harness.
 *
 * Boots the production build in headless Chrome with a real GPU-backed WebGL2
 * context, drives the camera to each viewpoint in qa/viewpoints.json through
 * the `window.__debug` API, and writes PNGs to qa/shots/.
 *
 *   node qa/shoot.mjs                        # all viewpoints
 *   node qa/shoot.mjs skyline-charles zakim  # a subset
 *   node qa/shoot.mjs --tag before           # suffix the filenames
 *   node qa/shoot.mjs --tier high            # force a quality tier (default ultra)
 *   node qa/shoot.mjs --width 1920 --height 1080
 *
 * Exits non-zero if the app fails to boot or logs a WebGL/JS error, so the
 * critic loop can distinguish "ugly" from "broken".
 */
import { spawn } from 'node:child_process';
import { mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SHOTS = path.join(ROOT, 'qa', 'shots');
// Each agent gets its own port + dist dir so concurrent QA runs never collide.
const PORT = Number(process.env.QA_PORT || 4319);
const OUTDIR = process.env.QA_OUTDIR || 'dist';

const argv = process.argv.slice(2);
const flag = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : d; };
const has = (n) => argv.includes(`--${n}`);
const WIDTH = Number(flag('width', 1600));
const HEIGHT = Number(flag('height', 900));
const TAG = flag('tag', '');
const TIER = flag('tier', 'ultra');
const POST = flag('post', '');
const ONLY = argv.filter((a) => !a.startsWith('--') && argv[argv.indexOf(a) - 1]?.startsWith('--') !== true);

function log(...a) { console.log('[qa]', ...a); }

async function ensureBuild() {
  if (has('no-build') && existsSync(path.join(ROOT, OUTDIR, 'index.html'))) return;
  log(`building -> ${OUTDIR}`);
  await new Promise((res, rej) => {
    const p = spawn('npx', ['vite', 'build', '--outDir', OUTDIR, '--emptyOutDir'], { cwd: ROOT, stdio: 'pipe', env: { ...process.env, VITE_BASE: '/' } });
    let out = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (out += d));
    p.on('exit', (c) => (c === 0 ? res() : rej(new Error(`vite build failed:\n${out.slice(-3000)}`))));
  });
}

/**
 * Serve `OUTDIR`, and prove it is ours before returning.
 *
 * `--strictPort` makes vite refuse a taken port -- but it exits, and the
 * readiness probe below is perfectly happy to be answered by whatever *else*
 * is listening there. A long session leaves preview servers behind on other
 * ports, and the failure mode is silent and vicious: the harness reports on a
 * build from an hour ago, or from another agent's tree, and every conclusion
 * drawn from the shots is wrong. It has already produced one 'the fix had no
 * effect' that was simply the wrong bundle.
 *
 * So the build gets a nonce written into it and the probe insists on reading
 * that exact nonce back.
 */
async function startServer() {
  const nonce = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  await writeFile(path.join(ROOT, OUTDIR, 'qa-build-id.txt'), nonce);

  const p = spawn('npx', ['vite', 'preview', '--port', String(PORT), '--strictPort', '--outDir', OUTDIR], {
    cwd: ROOT, stdio: 'pipe', env: { ...process.env, VITE_BASE: '/' },
  });
  let err = '';
  p.stdout.on('data', () => {});
  p.stderr.on('data', (d) => { err += d; });

  for (let i = 0; i < 120; i++) {
    try {
      const r = await fetch(`http://localhost:${PORT}/qa-build-id.txt`);
      if (r.ok && (await r.text()).trim() === nonce) return p;
      if (r.ok) {
        p.kill();
        throw new Error(
          `port ${PORT} is serving somebody else's build — another preview server is `
          + `already listening there. Pick a different QA_PORT, or kill it.`,
        );
      }
    } catch (e) {
      if (String(e.message).includes('serving somebody')) throw e;
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  p.kill();
  throw new Error(`preview server did not start on ${PORT}${err ? `:\n${err.slice(-500)}` : ''}`);
}

async function main() {
  await mkdir(SHOTS, { recursive: true });
  const viewpoints = JSON.parse(await readFile(path.join(ROOT, 'qa', 'viewpoints.json'), 'utf8'));
  const wanted = ONLY.length ? viewpoints.filter((v) => ONLY.includes(v.id)) : viewpoints;
  if (!wanted.length) throw new Error(`no viewpoints matched: ${ONLY.join(', ')}`);

  await ensureBuild();
  const server = await startServer();
  log(`serving on :${PORT}`);

  const browser = await puppeteer.launch({
    headless: 'shell' === process.env.QA_HEADLESS ? 'shell' : true,
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
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(String(e)));

  log('loading app…');
  // Pre-dismiss the first-run onboarding card so it never covers a capture.
  await page.evaluateOnNewDocument((res) => {
    try {
      localStorage.setItem('bh-onboarded', '1');
      // QA_RES drives the HUD's own Resolution control, which is independent
      // of the quality tier and is where upscaling artefacts show.
      if (res) localStorage.setItem('bh-res', res);
    } catch { /* private mode */ }
  }, process.env.QA_RES ?? '');
  await page.goto(`http://localhost:${PORT}/?q=${TIER}${POST ? `&post=${POST}` : ''}`, { waitUntil: 'networkidle2', timeout: 180000 });
  await page.waitForFunction('window.__ready === true', { timeout: 300000 });
  await page.waitForFunction('window.__debug !== undefined', { timeout: 30000 });
  log('app ready');

  const results = [];
  for (const v of wanted) {
    await page.evaluate((vp) => {
      window.__debug.setTime(vp.hour);
      window.__debug.setView(vp.pos, vp.target);
    }, v);
    // Let TAA/streaming/LOD converge.
    await page.evaluate(() => window.__debug.settle(45));
    await new Promise((r) => setTimeout(r, 700));
    await page.evaluate((vp) => {
      window.__debug.setTime(vp.hour);
      window.__debug.setView(vp.pos, vp.target);
    }, v);
    await page.evaluate(() => window.__debug.settle(30));

    const name = TAG ? `${v.id}--${TAG}.png` : `${v.id}.png`;
    const file = path.join(SHOTS, name);
    await page.screenshot({ path: file });
    const stats = await page.evaluate(() => window.__debug.stats());
    results.push({ id: v.id, file, stats });
    log(`shot ${name}  fps=${stats.fps} calls=${stats.calls} tris=${stats.tris}`);
  }

  await writeFile(path.join(SHOTS, 'report.json'), JSON.stringify({ when: new Date().toISOString(), results, errors }, null, 2));
  await browser.close();
  server.kill();

  if (errors.length) {
    console.error('\n[qa] PAGE ERRORS:\n' + errors.slice(0, 25).join('\n'));
    process.exit(2);
  }
  log('done ->', SHOTS);
}

main().catch((e) => { console.error('[qa] FAILED:', e.message); process.exit(1); });
