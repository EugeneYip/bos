/**
 * What the occlusion query buys, isolated.
 *
 * At `comm-ave` and `common-street` the coverage estimate passes (52% and
 * 100%) and only the occlusion answer skips the pass, so forcing that answer
 * to 'visible' at runtime reproduces the old behaviour exactly, in the same
 * page session, with the arms alternated.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import puppeteer from 'puppeteer';
const PORT = 4573, ROOT = '/Volumes/Projects/bos';
const vp = Object.values(JSON.parse(fs.readFileSync(`${ROOT}/qa/viewpoints.json`, 'utf8')));
const IDS = (process.argv[2] || 'comm-ave,common-street,prudential-low').split(',');
const REPS = Number(process.argv[3] || 5);
const srv = spawn('npx',['vite','preview','--port',String(PORT),'--strictPort','--outDir','dist-qa'],
  {cwd:ROOT,stdio:'ignore',env:{...process.env,VITE_BASE:'/'}});
for(let i=0;i<160;i++){try{if((await fetch(`http://localhost:${PORT}/`)).ok)break;}catch{}await new Promise(r=>setTimeout(r,250));}
const b=await puppeteer.launch({headless:true,protocolTimeout:900000,
  args:['--no-sandbox','--enable-gpu','--use-angle=metal','--enable-unsafe-swiftshader','--ignore-gpu-blocklist','--enable-webgl','--window-size=1280,720']});
const pg=await b.newPage(); await pg.setViewport({width:1280,height:720});
await pg.evaluateOnNewDocument(()=>{try{localStorage.removeItem('bh-tier');localStorage.removeItem('bh-res');localStorage.setItem('bh-onboarded','1')}catch{}});
await pg.goto(`http://localhost:${PORT}/?q=high`,{waitUntil:'networkidle2',timeout:180000});
await pg.waitForFunction('window.__ready === true',{timeout:300000});
await new Promise(r=>setTimeout(r,10000));
await pg.evaluate(() => {
  const w = window.__boston.modules.find((m) => m.name === 'Water');
  window.__vis = w.vis;
  // Pin the answer by replacing beginFrame's effect on `visible`.
  const orig = w.vis.beginFrame.bind(w.vis);
  window.__pin = null;
  w.vis.beginFrame = () => { orig(); if (window.__pin !== null) w.vis.visible = window.__pin; };
});
const measure = () => pg.evaluate(async () => {
  for (let i = 0; i < 26; i++) await new Promise((k) => requestAnimationFrame(k));
  const g = []; let last = performance.now();
  for (let i = 0; i < 200; i++) {
    await new Promise((k) => requestAnimationFrame(k));
    const n = performance.now(); g.push(n - last); last = n;
  }
  const s = [...g].sort((x, y) => x - y);
  return { mean: g.reduce((a, x) => a + x, 0) / g.length, p50: s[s.length >> 1],
    reflect: window.__boston.ctx.stats['water.reflect'] };
});
const med = (a) => { const s = [...a].sort((x, y) => x - y); return s[s.length >> 1]; };
for (const id of IDS) {
  const v = vp.find((x) => x.id === id);
  await pg.evaluate((h)=>window.__debug.setTime(h), v.hour ?? 13);
  await pg.evaluate((p,t)=>window.__debug.setView(p,t), v.pos, v.target);
  await new Promise(r=>setTimeout(r,9000));
  const on = [], off = [];
  for (let i = 0; i < REPS; i++) {
    await pg.evaluate(() => { window.__pin = true; });   // old behaviour
    on.push((await measure()).mean);
    await pg.evaluate(() => { window.__pin = null; });    // query in charge
    off.push((await measure()).mean);
  }
  const a = med(on), c = med(off);
  console.log(`${id.padEnd(16)} forced visible ${a.toFixed(1)}ms = ${(1000/a).toFixed(0)} fps`
    + `   query in charge ${c.toFixed(1)}ms = ${(1000/c).toFixed(0)} fps`
    + `   => ${(a - c).toFixed(1)}ms saved (${((a / c - 1) * 100).toFixed(0)}% faster)`);
}
await b.close(); srv.kill();
