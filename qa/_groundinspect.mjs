#!/usr/bin/env node
/**
 * Ad hoc viewpoint capture for diagnosing traffic behaviour (overlaps, lane
 * discipline, junction geometry) from angles qa/viewpoints.json does not
 * cover -- an aerial look-down over a junction is far more reliable for
 * spotting genuine 3D overlap than an oblique street-level shot, where two
 * cars at different depths can align in screen space by pure coincidence.
 *
 * Connects to an already-running preview on :4571 (start one with
 * `VITE_BASE=/ npx vite preview --port 4571 --strictPort --outDir dist-qa`).
 *
 *   node qa/_groundinspect.mjs <x> <y> <z> <tx> <ty> <tz> [hour] [tag]
 */
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'qa', 'shots', 'ground');
const PORT = 4571;
const [, , xs, ys, zs, txs, tys, tzs, hourS, tagS] = process.argv;
const pos = [Number(xs), Number(ys), Number(zs)];
const target = [Number(txs), Number(tys), Number(tzs)];
const hour = Number(hourS ?? 13);
const tag = tagS || 'aerial';

async function main() {
  await mkdir(OUT, { recursive: true });
  const browser = await puppeteer.launch({
    headless: true,
    args: [
      '--no-sandbox', '--enable-gpu', '--use-angle=metal', '--enable-unsafe-swiftshader',
      '--ignore-gpu-blocklist', '--enable-webgl', '--window-size=1600,900',
      '--hide-scrollbars', '--mute-audio',
    ],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1600, height: 900, deviceScaleFactor: 1 });
  await page.evaluateOnNewDocument(() => {
    try { localStorage.setItem('bh-onboarded', '1'); } catch { /* private mode */ }
  });
  await page.goto(`http://localhost:${PORT}/?q=high`, { waitUntil: 'networkidle2', timeout: 180000 });
  await page.waitForFunction('window.__ready === true', { timeout: 300000 });
  await page.waitForFunction('window.__debug !== undefined', { timeout: 30000 });
  await page.evaluate((h, p, t) => {
    window.__debug.setTime(h);
    window.__debug.setView(p, t);
  }, hour, pos, target);
  await page.evaluate(() => window.__debug.settle(60));
  await new Promise((r) => setTimeout(r, 400));
  const file = path.join(OUT, `_inspect--${tag}.png`);
  await page.screenshot({ path: file });
  console.log('[groundinspect] saved', file);
  await browser.close();
}
main().catch((e) => { console.error('[groundinspect] FAILED:', e.message); process.exit(1); });
