#!/usr/bin/env node
/**
 * What is drawn where the ocean lies beyond the modelled city box?
 *
 * The far field paints every cell at or below sea level a flat matte grey-blue
 * and parks it at exactly y=0 -- coplanar with the ocean skirt, which is the
 * real water shader. Both want that surface. This names the winner with a
 * raycast and measures the colour with the far field shown and hidden,
 * interleaved in one page session so nothing but the toggle differs.
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.QA_PORT || 4341);
const OUTDIR = process.env.QA_OUTDIR || 'dist-qa1';
const W = 1600, H = 900;

// Screen points in the aerial-city frame that sit on open sea beyond the box.
const PTS = (process.env.PTS || '120,60 380,40 700,30 1180,60 1500,120 1420,300 60,150')
  .trim().split(/\s+/).map((s) => s.split(',').map(Number));

const server = spawn('npx', ['vite', 'preview', '--port', String(PORT), '--strictPort', '--outDir', OUTDIR],
  { cwd: ROOT, stdio: 'ignore', env: { ...process.env, VITE_BASE: '/' } });
for (let i = 0; i < 160; i++) {
  try { if ((await fetch(`http://localhost:${PORT}/`)).ok) break; } catch {}
  await new Promise((r) => setTimeout(r, 250));
}

const browser = await puppeteer.launch({
  headless: true,
  args: ['--no-sandbox', '--enable-gpu', '--use-angle=metal', '--ignore-gpu-blocklist',
         '--enable-webgl', `--window-size=${W},${H}`, '--hide-scrollbars'],
});
const page = await browser.newPage();
await page.setViewport({ width: W, height: H, deviceScaleFactor: 1 });
await page.evaluateOnNewDocument(() => { try { localStorage.setItem('bh-onboarded', '1'); } catch {} });
await page.goto(`http://localhost:${PORT}/?q=ultra`, { waitUntil: 'networkidle2', timeout: 180000 });
await page.waitForFunction('window.__ready === true', { timeout: 300000 });

const pose = async () => {
  await page.evaluate(() => { window.__debug.setTime(11.0); window.__debug.setView([-900, 2400, 2600], [-200, 0, -400]); });
  await page.evaluate(() => window.__debug.settle(40));
};
await pose();

console.log('--- raycast: what owns those pixels ---');
const picks = await page.evaluate((pts) => pts.map(([x, y]) => {
  const hits = window.__debug.pick(x, y, 4);
  // Re-cast to recover the world point of the first hit, so the elevation
  // under it can be checked against the bathymetry.
  const cam = window.__boston.ctx.camera;
  const nd = new window.__THREE.Vector2((x / window.innerWidth) * 2 - 1, -(y / window.innerHeight) * 2 + 1);
  const rc = new window.__THREE.Raycaster(); rc.setFromCamera(nd, cam);
  const d = hits.length ? hits[0].dist : 0;
  const p = rc.ray.at(d, new window.__THREE.Vector3());
  return { at: [x, y], world: [Math.round(p.x), Math.round(p.y), Math.round(p.z)], hits };
}), PTS);
for (const p of picks) {
  console.log(`(${p.at}) w=${p.world}  ` + (p.hits.length
    ? p.hits.map((h) => `${h.name}@${Math.round(h.dist)}m`).join('  ')
    : '(nothing)'));
}

const sample = async (label) => {
  await page.evaluate(() => window.__debug.settle(20));
  const buf = await page.screenshot({ encoding: 'binary' });
  const { PNG } = await import('pngjs');
  const img = PNG.sync.read(Buffer.from(buf));
  const out = PTS.map(([x, y]) => {
    let s = [0, 0, 0], n = 0;
    for (let dy = -6; dy <= 6; dy++) for (let dx = -6; dx <= 6; dx++) {
      const xx = x + dx, yy = y + dy;
      if (xx < 0 || yy < 0 || xx >= img.width || yy >= img.height) continue;
      const i = (yy * img.width + xx) * 4;
      s[0] += img.data[i]; s[1] += img.data[i + 1]; s[2] += img.data[i + 2]; n++;
    }
    return s.map((v) => Math.round(v / n));
  });
  console.log(label.padEnd(12), out.map((c) => `[${c.join(',')}]`).join(' '));
  return out;
};

console.log('\n--- colour, far field shown vs hidden (interleaved) ---');
for (let round = 0; round < 2; round++) {
  await page.evaluate(() => window.__debug.toggle('far-terrain', true));
  await sample(`r${round} shown`);
  const n = await page.evaluate(() => window.__debug.toggle('far-terrain', false));
  await sample(`r${round} hidden`);
  if (round === 0) console.log(`(toggle matched ${n} object${n === 1 ? '' : 's'})`);
}
await page.evaluate(() => window.__debug.toggle('far-terrain', true));

await browser.close();
server.kill();
