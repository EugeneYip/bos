#!/usr/bin/env node
/**
 * Checks that every city data file is fetched at a versioned URL.
 *
 *   node qa/data-check.mjs            # builds, serves, loads, inspects requests
 *   node qa/data-check.mjs --no-build
 *
 * Vite content-hashes the JavaScript, so a deploy always ships the code it
 * built. It does not touch `public/`, and the city — forty megabytes of
 * buildings, roads, terrain and props — lives there and used to be fetched at
 * fixed paths. A visitor whose browser had those cached ran new code against
 * old geometry, which is indistinguishable from a fix that did not work, and it
 * hid every correction made to the building data for as long as the cache held.
 *
 * The manifest is the one file deliberately left unversioned: it is fetched
 * with `cache: no-cache` so it always revalidates, and its `generated` stamp is
 * what versions everything else. The pass condition is therefore exactly one
 * unversioned request, and it has to be the manifest.
 */
import { spawn } from 'node:child_process';
import puppeteer from 'puppeteer';

const ROOT = '/Volumes/Projects/bos';
const PORT = Number(process.env.QA_PORT || 4422);
const OUTDIR = process.env.QA_OUTDIR || 'dist';
const noBuild = process.argv.includes('--no-build');

if (!noBuild) {
  await new Promise((res, rej) => {
    const p = spawn('npx', ['vite', 'build', '--outDir', OUTDIR, '--emptyOutDir'], {
      cwd: ROOT, stdio: 'pipe', env: { ...process.env, VITE_BASE: '/' },
    });
    let out = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (out += d));
    p.on('exit', (c) => (c === 0 ? res() : rej(new Error(out.slice(-1500)))));
  });
}

const server = spawn('npx', ['vite', 'preview', '--port', String(PORT), '--strictPort', '--outDir', OUTDIR], {
  cwd: ROOT, stdio: 'ignore', env: { ...process.env, VITE_BASE: '/' },
});
for (let i = 0; i < 160; i++) {
  try { if ((await fetch(`http://localhost:${PORT}/`)).ok) break; } catch { /* not up */ }
  await new Promise((r) => setTimeout(r, 250));
}

const browser = await puppeteer.launch({
  headless: true,
  protocolTimeout: 600000,
  args: [
    '--no-sandbox', '--enable-gpu', '--use-angle=metal', '--enable-unsafe-swiftshader',
    '--ignore-gpu-blocklist', '--enable-webgl', '--window-size=900,600',
  ],
});
const page = await browser.newPage();
const urls = [];
page.on('request', (r) => {
  const u = r.url();
  if (u.includes('/data/')) urls.push(u.replace(`http://localhost:${PORT}`, ''));
});
await page.evaluateOnNewDocument(() => {
  try { localStorage.setItem('bh-onboarded', '1'); } catch { /* private mode */ }
});
await page.goto(`http://localhost:${PORT}/`, { waitUntil: 'networkidle2', timeout: 180000 });
await page.waitForFunction('window.__ready === true', { timeout: 300000 });

await browser.close();
server.kill();

const versioned = urls.filter((u) => u.includes('?v='));
const bare = urls.filter((u) => !u.includes('?v='));
console.log(`[data] requests ${urls.length} | versioned ${versioned.length} | unversioned ${bare.length}`);
if (versioned.length) console.log('[data] sample:', versioned[0]);

if (!urls.length) {
  console.error('[data] no data requests seen at all');
  process.exit(2);
}
const wrong = bare.filter((u) => !u.endsWith('/data/manifest.json'));
if (wrong.length) {
  console.error('[data] fetched at an unversioned URL, so they will be served stale:\n  ' + wrong.join('\n  '));
  process.exit(1);
}
console.log('[data] every file but the manifest carries the manifest generation stamp');
