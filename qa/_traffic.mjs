#!/usr/bin/env node
/** __debug.traffic() at a set of viewpoints, sampled over time. */
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFile } from 'node:fs/promises';
import puppeteer from 'puppeteer';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.QA_PORT || 4351);
const OUTDIR = process.env.QA_OUTDIR || 'dist-qa1';
const WANT = process.argv.slice(2);

const server = spawn('npx', ['vite', 'preview', '--port', String(PORT), '--strictPort', '--outDir', OUTDIR],
  { cwd: ROOT, stdio: 'ignore', env: { ...process.env, VITE_BASE: '/' } });
for (let i = 0; i < 160; i++) {
  try { if ((await fetch(`http://localhost:${PORT}/`)).ok) break; } catch {}
  await new Promise((r) => setTimeout(r, 250));
}
const vps = JSON.parse(await readFile(path.join(ROOT, 'qa', 'viewpoints.json'), 'utf8'))
  .filter((v) => !WANT.length || WANT.includes(v.id));

const browser = await puppeteer.launch({ headless: true, protocolTimeout: 900000,
  args: ['--no-sandbox', '--enable-gpu', '--use-angle=metal', '--ignore-gpu-blocklist',
         '--enable-webgl', '--window-size=1600,900', '--hide-scrollbars'] });
const page = await browser.newPage();
await page.setViewport({ width: 1600, height: 900, deviceScaleFactor: 1 });
await page.evaluateOnNewDocument(() => { try { localStorage.setItem('bh-onboarded', '1'); } catch {} });
await page.goto(`http://localhost:${PORT}/?q=ultra`, { waitUntil: 'networkidle2', timeout: 180000 });
await page.waitForFunction('window.__ready === true', { timeout: 300000 });

for (const v of vps) {
  await page.evaluate((vp) => { window.__debug.setTime(vp.hour); window.__debug.setView(vp.pos, vp.target); }, v);
  // Let the fleet reach steady state after the jump before the first read:
  // it is still filling for the first few seconds, which on its own raises density.
  await page.evaluate(() => window.__debug.settle(400));
  // Two reads a few seconds apart: a queue at a light clears, a deadlock does not.
  const a = await page.evaluate(() => window.__debug.traffic());
  await page.evaluate(() => window.__debug.settle(240));
  const b = await page.evaluate(() => window.__debug.traffic());
  console.log(`\n== ${v.id}`);
  console.log(`   active ${a.active}->${b.active}  stopped ${a.stoppedPct}%->${b.stoppedPct}%  ` +
              `mean ${a.meanSpeed}->${b.meanSpeed} m/s`);
  console.log(`   ${b.demandKm} demand-km in radius, ${b.carsPerDemandKm} cars/demand-km`);
  console.log(`   ${a.byClass}`);
  console.log(`   overlapping neighbours ${a.overlapping}/${a.pairs} (${a.overlapPct}%) -> ` +
              `${b.overlapping}/${b.pairs} (${b.overlapPct}%), worst ${b.worstOverlapM} m into the car ahead`);
  console.log(`   densest: ${b.densest}`);
  if (v === vps[0]) console.log(`   graph: ${a.edges} edges, ${a.banned} banned, ${a.localEdges} local`);
}
await browser.close();
server.kill();
