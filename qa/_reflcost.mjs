/**
 * What is the reflection pass spending its 6.3 ms on?
 *
 * For each layer: hide it globally (both the main pass and the reflection),
 * then measure the frame with the reflection on and off. The difference is the
 * reflection's cost *without* that layer, so comparing it to the 6.3 ms
 * baseline says how much of the pass that layer was.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import puppeteer from 'puppeteer';
const PORT = 4568, ROOT = '/Volumes/Projects/bos';
const vp = JSON.parse(fs.readFileSync(`${ROOT}/qa/viewpoints.json`, 'utf8'));
const IDS = (process.argv[2] || 'high-street').split(',');
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
  window.__refl = w.reflection;
  window.__setRefl = (on) => { window.__refl.opts.interval = on ? 2 : 1e9; };
});
const measure = () => pg.evaluate(async () => {
  for (let i = 0; i < 26; i++) await new Promise((k) => requestAnimationFrame(k));
  const g = []; let last = performance.now();
  for (let i = 0; i < 220; i++) {
    await new Promise((k) => requestAnimationFrame(k));
    const n = performance.now(); g.push(n - last); last = n;
  }
  return g.reduce((s, x) => s + x, 0) / g.length;
});
for (const id of IDS) {
  const v = Object.values(vp).find((x) => x.id === id);
  await pg.evaluate((h)=>window.__debug.setTime(h), v.hour ?? 13);
  await pg.evaluate((p,t)=>window.__debug.setView(p,t), v.pos, v.target);
  await new Promise(r=>setTimeout(r,9000));
  const label = id;
  await pg.evaluate(() => window.__setRefl(true));
  const on = await measure();
  await pg.evaluate(() => window.__setRefl(false));
  const off = await measure();
  await pg.evaluate(() => window.__setRefl(true));
  const wat = await pg.evaluate(() => {
    const w = window.__boston.modules.find((m) => m.name === 'Water');
    return w.meshes.filter((mm) => mm.visible).length;
  });
  console.log(`${label.padEnd(20)} refl on ${on.toFixed(1)}ms  off ${off.toFixed(1)}ms`
    + `  => reflection costs ${(on - off).toFixed(1)}ms  (${(100*(on-off)/on).toFixed(0)}% of the frame)`
    + `   water meshes ${wat}`);
}
await b.close(); srv.kill();
