#!/usr/bin/env node
/**
 * Interface smoke test.
 *
 *   node qa/ui-check.mjs            # builds, serves, drives the interface
 *   node qa/ui-check.mjs --no-build
 *
 * `shoot.mjs` photographs the city; it cannot see the interface in front of it.
 * That blind spot cost something real: every segmented control in the panel —
 * quality preset, weather, camera mode — fired its change handler correctly and
 * then left the highlight exactly where it was, so the quality preset worked
 * while looking permanently stuck on whatever the GPU probe had chosen. A
 * screenshot of the city would never have shown it.
 *
 * So this walks the panels, clicks every option of every radio group, and
 * checks that the selection follows the click. Exits non-zero if it does not.
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.QA_PORT || 4380);
const OUTDIR = process.env.QA_OUTDIR || 'dist';
const noBuild = process.argv.includes('--no-build');

const log = (...a) => console.log('[ui]', ...a);
const failures = [];

async function build() {
  if (noBuild && existsSync(path.join(ROOT, OUTDIR, 'index.html'))) return;
  log(`building -> ${OUTDIR}`);
  await new Promise((res, rej) => {
    const p = spawn('npx', ['vite', 'build', '--outDir', OUTDIR, '--emptyOutDir'], {
      cwd: ROOT, stdio: 'pipe', env: { ...process.env, VITE_BASE: '/' },
    });
    let out = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (out += d));
    p.on('exit', (c) => (c === 0 ? res() : rej(new Error(out.slice(-2000)))));
  });
}

async function serve() {
  const p = spawn('npx', ['vite', 'preview', '--port', String(PORT), '--strictPort', '--outDir', OUTDIR], {
    cwd: ROOT, stdio: 'ignore', env: { ...process.env, VITE_BASE: '/' },
  });
  for (let i = 0; i < 160; i++) {
    try { if ((await fetch(`http://localhost:${PORT}/`)).ok) return p; } catch { /* not up */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  p.kill();
  throw new Error('preview server did not start');
}

await build();
const server = await serve();

const browser = await puppeteer.launch({
  headless: true,
  protocolTimeout: 600000,
  args: [
    '--no-sandbox', '--enable-gpu', '--use-angle=metal', '--enable-unsafe-swiftshader',
    '--ignore-gpu-blocklist', '--enable-webgl', '--window-size=1280,860', '--hide-scrollbars', '--mute-audio',
  ],
});
const page = await browser.newPage();
await page.setViewport({ width: 1280, height: 860, deviceScaleFactor: 1 });
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
await page.evaluateOnNewDocument(() => { try { localStorage.setItem('bh-onboarded', '1'); } catch { /* private */ } });

log('loading…');
await page.goto(`http://localhost:${PORT}/`, { waitUntil: 'networkidle2', timeout: 180000 });
await page.waitForFunction('window.__ready === true', { timeout: 300000 });
log('ready; detected tier', await page.evaluate(() => window.__boston.detectedTier));

/** Opens a dock panel by its accessible name. */
async function openPanel(name) {
  const ok = await page.evaluate((n) => {
    const b = [...document.querySelectorAll('button')]
      .find((x) => (x.title || x.getAttribute('aria-label') || '').toLowerCase() === n);
    if (!b) return false;
    b.click();
    return true;
  }, name.toLowerCase());
  await new Promise((r) => setTimeout(r, 350));
  return ok;
}

for (const panel of ['Time of day', 'Camera', 'Landmarks', 'Settings']) {
  if (!(await openPanel(panel))) { log(`panel "${panel}" not found, skipping`); continue; }

  const groups = await page.evaluate(() => [...document.querySelectorAll('.bh-seg')].map((g) => ({
    label: g.getAttribute('aria-label'),
    options: [...g.querySelectorAll('button')].map((b) => b.textContent.trim()),
  })));

  for (let gi = 0; gi < groups.length; gi++) {
    for (const option of groups[gi].options) {
      const res = await page.evaluate((i, o) => {
        const g = document.querySelectorAll('.bh-seg')[i];
        const b = [...g.querySelectorAll('button')].find((x) => x.textContent.trim() === o);
        if (!b || b.disabled) return { skipped: true };
        b.click();
        const active = [...g.querySelectorAll('button')]
          .filter((x) => x.classList.contains('is-active')).map((x) => x.textContent.trim());
        const checked = [...g.querySelectorAll('button')]
          .filter((x) => x.getAttribute('aria-checked') === 'true').map((x) => x.textContent.trim());
        return { active, checked };
      }, gi, option);
      await new Promise((r) => setTimeout(r, 220));
      if (res.skipped) continue;
      const ok = res.active.length === 1 && res.active[0] === option
        && res.checked.length === 1 && res.checked[0] === option;
      if (!ok) {
        failures.push(
          `${panel} / ${groups[gi].label}: clicked "${option}" but highlight is `
          + `[${res.active}] and aria-checked is [${res.checked}]`,
        );
      }
    }
    log(`${panel} / ${groups[gi].label}: ${groups[gi].options.length} options checked`);
  }
}

// The quality tier is remembered across reloads. It was not, which made every
// deliberate upgrade look like a control that does not work: the GPU probe
// re-ran on load and put a machine that measures as `low` straight back there.
await page.evaluate(() => window.__boston.setQuality('ultra'));
await new Promise((r) => setTimeout(r, 600));
await page.reload({ waitUntil: 'networkidle2', timeout: 180000 });
await page.waitForFunction('window.__ready === true', { timeout: 300000 });
const afterReload = await page.evaluate(() => window.__boston.ctx.tier);
if (afterReload !== 'ultra') failures.push(`quality tier not remembered: reloaded as "${afterReload}"`);
else log('quality tier survives a reload');

await browser.close();
server.kill();

if (errors.length) {
  console.error('\n[ui] PAGE ERRORS:\n' + errors.slice(0, 20).join('\n'));
  process.exit(2);
}
if (failures.length) {
  console.error('\n[ui] FAILURES:\n' + failures.join('\n'));
  process.exit(1);
}
log('all radio groups follow their clicks');
