#!/usr/bin/env node
// Throwaway screenshot driver for the NEU dev preview scene (dev.html). Not
// part of the app — nothing imports it, tsc doesn't check .mjs, Vite never
// bundles it unless requested by URL. Boots a `vite` dev server on this repo
// and screenshots dev.html with each requested `?view=` to the scratchpad.
import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../..');
const PORT = Number(process.env.NEU_PORT || 4508);
const OUT = process.env.NEU_OUT || '/private/tmp/claude-501/-Volumes-Projects-bos/66f4fcfe-e457-496a-b7f5-fbcb9c740463/scratchpad/shots';
const W = 1600, H = 900;

const views = process.argv.slice(2).length ? process.argv.slice(2) : ['qa'];

async function startServer() {
  const p = spawn('npx', ['vite', '--port', String(PORT), '--strictPort', '--host', '127.0.0.1'], {
    cwd: ROOT, stdio: 'pipe', env: { ...process.env, VITE_BASE: '/' },
  });
  let buf = '';
  p.stdout.on('data', (d) => (buf += d));
  p.stderr.on('data', (d) => (buf += d));
  let lastStatus = '(no attempt yet)';
  for (let i = 0; i < 240; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/src/landmarks/campus/neu/dev/dev.html`);
      lastStatus = String(r.status);
      if (r.ok) return p;
    } catch (e) { lastStatus = String(e); }
    await new Promise((r) => setTimeout(r, 250));
  }
  console.error('last status:', lastStatus);
  console.error(buf.slice(-4000));
  p.kill();
  throw new Error('vite dev server did not start');
}

async function main() {
  await mkdir(OUT, { recursive: true });
  const server = await startServer();
  console.log(`[neu] serving on :${PORT}, root=${ROOT}`);
  const browser = await puppeteer.launch({
    headless: true,
    args: [
      '--no-sandbox', '--enable-gpu', '--use-angle=metal', '--enable-unsafe-swiftshader',
      '--ignore-gpu-blocklist', '--enable-webgl', `--window-size=${W},${H}`,
      '--hide-scrollbars', '--mute-audio',
    ],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: W, height: H, deviceScaleFactor: 1 });
  let errors = [];
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
    console.log(`  [console:${m.type()}]`, m.text());
  });
  page.on('pageerror', (e) => errors.push(String(e)));

  for (const view of views) {
    errors = [];
    const url = `http://127.0.0.1:${PORT}/src/landmarks/campus/neu/dev/dev.html?view=${view}`;
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 60000 });
    try {
      await page.waitForFunction('window.__ready === true', { timeout: 20000 });
    } catch {
      console.error(`[neu] ${view}: never became ready`, errors);
      continue;
    }
    await new Promise((r) => setTimeout(r, 150));
    const stats = await page.evaluate(() => window.__stats);
    const file = path.join(OUT, `${view}.png`);
    await page.screenshot({ path: file });
    console.log(`[neu] shot ${view}.png`, JSON.stringify(stats), errors.length ? `ERRORS: ${errors.join(' | ')}` : '');
  }

  await browser.close();
  server.kill();
}

main().catch((e) => { console.error('[neu] FAILED:', e); process.exit(1); });
