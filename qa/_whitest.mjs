#!/usr/bin/env node
/**
 * Find the palest ground pixels in a frame and name what is under them.
 *
 * Written because translating coordinates by hand between a 1600x900 capture,
 * a 4x crop and a 1280x720 pick viewport put every probe a few metres off the
 * thing it was meant to hit, three separate times. Screenshot and raycast in
 * one session, at one resolution, and let the tool pick the coordinates.
 */
import { spawn } from 'node:child_process';
import { PNG } from 'pngjs';
import puppeteer from 'puppeteer';

const ROOT = '/Volumes/Projects/bos';
const PORT = Number(process.env.QA_PORT || 4380);
const POSE = JSON.parse(process.env.POSE);
const W = 1600, H = 900;
const TIER = process.env.TIER || 'high';

const srv = spawn('npx', ['vite','preview','--port',String(PORT),'--strictPort','--outDir',process.env.QA_OUTDIR ?? 'dist-tier'],
  { cwd: ROOT, stdio: 'ignore', env: { ...process.env, VITE_BASE: '/' } });
for (let i=0;i<160;i++){ try{ if((await fetch(`http://localhost:${PORT}/`)).ok) break; }catch{} await new Promise(r=>setTimeout(r,250)); }

const b = await puppeteer.launch({ headless:true, protocolTimeout:900000,
  args:['--no-sandbox','--enable-gpu','--use-angle=metal','--ignore-gpu-blocklist','--enable-webgl',`--window-size=${W},${H}`] });
const pg = await b.newPage(); await pg.setViewport({ width: W, height: H, deviceScaleFactor: 1 });
await pg.evaluateOnNewDocument(()=>{ try{ localStorage.setItem('bh-onboarded','1'); }catch{} });
await pg.goto(`http://localhost:${PORT}/?q=${TIER}`, { waitUntil:'networkidle2', timeout:180000 });
await pg.waitForFunction('window.__ready === true', { timeout:300000 });
await pg.evaluate((v)=>{ window.__debug.setTime(v.hour); window.__debug.setView(v.pos, v.target); }, POSE);
await pg.evaluate(()=>window.__debug.settle(60));

const img = PNG.sync.read(Buffer.from(await pg.screenshot({ encoding:'binary' })));
// Brightest pixels in the lower 60% of the frame, spread apart so they are
// not all the same patch.
const cand = [];
// Skip the HUD. Its glyphs are pure white and sit on top of the render, so
// they win 'palest pixel' every time -- and `pick` raycasts the scene behind
// them and cheerfully names whatever road is back there, which is how a probe
// into pale pavement spent a build measuring the settings icon.
const hud = (x, y) => (y > H - 80 && x < 300) || (y > H - 60);
for (let y = Math.floor(H*0.45); y < H-40; y += 3) {
  for (let x = 20; x < W-20; x += 3) {
    if (hud(x, y)) continue;
    const i = (y*img.width+x)*4;
    const L = 0.2126*img.data[i] + 0.7152*img.data[i+1] + 0.0722*img.data[i+2];
    cand.push({ x, y, L });
  }
}
cand.sort((a,c)=>c.L-a.L);
const picked = [];
for (const c of cand) {
  if (picked.length >= 10) break;
  if (picked.some(p => Math.hypot(p.x-c.x, p.y-c.y) < 90)) continue;
  picked.push(c);
}
console.log(`tier=${TIER}  ${picked.length} palest well-separated ground samples:`);
for (const p of picked) {
  const hits = await pg.evaluate(([x,y])=>window.__debug.pick(x,y,4), [p.x,p.y]);
  console.log(`  (${String(p.x).padStart(4)},${String(p.y).padStart(3)}) luma ${p.L.toFixed(0).padStart(3)}  `
    + (hits.length ? hits.map(h=>`${h.name}@${Math.round(h.dist)}`).join('  |  ') : '(nothing)'));
}
await b.close(); srv.kill();
