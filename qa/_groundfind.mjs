#!/usr/bin/env node
/**
 * Find a live instance of a rare traffic type (police, duckboat, bus, ...)
 * by reading its InstancedMesh transforms directly out of the scene graph,
 * then park the camera close to the first one found and shoot it. Existing
 * only to verify a rare vehicle actually renders as intended somewhere in
 * the city, which waiting for one to wander into a fixed viewpoint cannot
 * do inside a reasonable number of tries.
 *
 * Connects to an already-running preview on :4571.
 *
 *   node qa/_groundfind.mjs police
 *   node qa/_groundfind.mjs duckboat 12
 */
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'qa', 'shots', 'ground');
const PORT = 4571;
const TYPE = process.argv[2] || 'police';
const DIST = Number(process.argv[3] || 14);

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
  await page.evaluate(() => {
    window.__debug.setTime(13);
    window.__debug.setView([300, 9.8, 150], [-120, 22.9, -60]);
  });
  await page.evaluate(() => window.__debug.settle(300));

  const found = await page.evaluate((type) => {
    let hit = null;
    window.__boston.ctx.scene.traverse((o) => {
      if (hit || !o.isInstancedMesh || o.name !== `traffic:${type}:shell`) return;
      if (o.count > 0) {
        const arr = o.instanceMatrix.array;
        hit = [arr[12], arr[13], arr[14]];
      }
    });
    return hit;
  }, TYPE);

  if (!found) {
    console.log(`[groundfind] no live '${TYPE}' instance found`);
    await browser.close();
    return;
  }
  const [x, y, z] = found;
  await page.evaluate((p, t) => window.__debug.setView(p, t), [x + DIST, y + DIST * 0.6, z + DIST], [x, y + 0.8, z]);
  await page.evaluate(() => window.__debug.settle(30));
  await new Promise((r) => setTimeout(r, 300));
  const file = path.join(OUT, `_inspect--find-${TYPE}.png`);
  await page.screenshot({ path: file });
  console.log('[groundfind] found', TYPE, 'at', found, '-> saved', file);
  await browser.close();
}
main().catch((e) => { console.error('[groundfind] FAILED:', e.message); process.exit(1); });
