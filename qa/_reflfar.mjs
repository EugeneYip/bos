/**
 * The reflection's far plane against its cost, and against how it looks.
 *
 * Buildings are 87% of the pass (5.5 of 6.3 ms), so the lever is how many of
 * them the mirrored camera can see. `far` is already a parameter and is set to
 * 6000 m -- six kilometres of city re-rendered into a 0.35x target that the
 * shader then samples at mip 3-4.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import puppeteer from 'puppeteer';
const PORT = 4569, ROOT = '/Volumes/Projects/bos';
const vp = JSON.parse(fs.readFileSync(`${ROOT}/qa/viewpoints.json`, 'utf8'));
const IDS = (process.argv[2] || 'high-street,charles-water,harbor-water').split(',');
const FARS = (process.argv[3] || '6000,2500,1200,600').split(',').map(Number);
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
  window.__refl = window.__boston.modules.find((m) => m.name === 'Water').reflection;
});
const measure = () => pg.evaluate(async () => {
  for (let i = 0; i < 26; i++) await new Promise((k) => requestAnimationFrame(k));
  const g = []; let last = performance.now();
  for (let i = 0; i < 200; i++) {
    await new Promise((k) => requestAnimationFrame(k));
    const n = performance.now(); g.push(n - last); last = n;
  }
  return g.reduce((s, x) => s + x, 0) / g.length;
});
for (const id of IDS) {
  const v = Object.values(vp).find((x) => x.id === id);
  await pg.evaluate((h)=>window.__debug.setTime(h), v.hour ?? 13);
  await pg.evaluate((p,t)=>window.__debug.setView(p,t), v.pos, v.target);
  await new Promise(r=>setTimeout(r,8000));
  console.log(`\n== ${id}`);
  for (const f of FARS) {
    await pg.evaluate((ff) => { window.__refl.opts.far = ff; }, f);
    const ms = await measure();
    await pg.evaluate(()=>window.__debug.settle(70));
    fs.writeFileSync(`${ROOT}/qa/shots/reflfar-${id}-${f}.png`, await pg.screenshot());
    console.log(`   far ${String(f).padStart(5)} m   ${ms.toFixed(1)}ms = ${(1000/ms).toFixed(0)} fps`);
  }
  await pg.evaluate(() => { window.__refl.opts.far = 6000; });
}
await b.close(); srv.kill();
