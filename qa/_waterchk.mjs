/**
 * Is the reflection gate wrongly skipping, so the water falls back to a flat
 * analytic sky? Renders each viewpoint with the gate's own decision and then
 * with it forced on, in one session.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import puppeteer from 'puppeteer';
import { PNG } from 'pngjs';
const PORT = 4592, ROOT = '/Volumes/Projects/bos';
const vp = Object.values(JSON.parse(fs.readFileSync(`${ROOT}/qa/viewpoints.json`, 'utf8')));
const IDS = (process.argv[2] || 'charles-water,water-detail,skyline-charles,harbor-water').split(',');
const TIER = process.argv[3] || 'high';
const srv = spawn('npx',['vite','preview','--port',String(PORT),'--strictPort','--outDir','dist-qa'],
  {cwd:ROOT,stdio:'ignore',env:{...process.env,VITE_BASE:'/'}});
for(let i=0;i<160;i++){try{if((await fetch(`http://localhost:${PORT}/`)).ok)break;}catch{}await new Promise(r=>setTimeout(r,250));}
const b=await puppeteer.launch({headless:true,protocolTimeout:900000,
  args:['--no-sandbox','--enable-gpu','--use-angle=metal','--enable-unsafe-swiftshader','--ignore-gpu-blocklist','--enable-webgl','--window-size=1280,720']});
const pg=await b.newPage(); await pg.setViewport({width:1280,height:720});
await pg.evaluateOnNewDocument(()=>{try{localStorage.removeItem('bh-tier');localStorage.removeItem('bh-res');localStorage.setItem('bh-onboarded','1')}catch{}});
await pg.goto(`http://localhost:${PORT}/?q=${TIER}`,{waitUntil:'networkidle2',timeout:180000});
await pg.waitForFunction('window.__ready === true',{timeout:300000});
await new Promise(r=>setTimeout(r,10000));
await pg.evaluate(() => {
  const w = window.__boston.modules.find((m) => m.name === 'Water');
  window.__w = w;
  window.__force = false;
  const origCov = w.surfaceCoverage.bind(w);
  w.surfaceCoverage = (ctx) => (window.__force ? 1 : origCov(ctx));
  const origVis = w.vis.beginFrame.bind(w.vis);
  w.vis.beginFrame = () => { origVis(); if (window.__force) w.vis.visible = true; };
});
/** Mean colour and local detail over the whole frame's water pixels, found by
 *  flooding once up front is not possible here, so use the reflection uniform. */
const shot = async (tag) => {
  await pg.evaluate(()=>window.__debug.settle(90));
  await new Promise(r=>setTimeout(r,800));
  const buf = await pg.screenshot();
  fs.writeFileSync(`${ROOT}/qa/shots/wchk-${tag}.png`, buf);
  const st = await pg.evaluate(()=>({ cover: window.__boston.ctx.stats['water.cover'],
    seen: window.__boston.ctx.stats['water.seen'], refl: window.__boston.ctx.stats['water.reflect'],
    maxLod: window.__w.reflection?.maxLod, interval: window.__w.reflection?.opts.interval }));
  return st;
};
for (const id of IDS) {
  const v = vp.find((x) => x.id === id);
  await pg.evaluate((h)=>window.__debug.setTime(h), v.hour ?? 13);
  await pg.evaluate((p,t)=>window.__debug.setView(p,t), v.pos, v.target);
  await new Promise(r=>setTimeout(r,9000));
  await pg.evaluate(()=>{ window.__force = false; });
  const a = await shot(`${id}-${TIER}-gate`);
  await pg.evaluate(()=>{ window.__force = true; });
  const c = await shot(`${id}-${TIER}-forced`);
  await pg.evaluate(()=>{ window.__force = false; });
  console.log(`${id.padEnd(17)} ${TIER}  gate: cover ${String(a.cover).padStart(5)} seen ${a.seen} reflect ${a.refl}`
    + `   forced: reflect ${c.refl}   interval ${a.interval} maxLod ${a.maxLod}`);
}
await b.close(); srv.kill();
