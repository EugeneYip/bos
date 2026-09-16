/**
 * Where the CPU frame goes, by layer.
 *
 * `cpu.submit` is wall-clock around `renderer.render` -- JS and driver time to
 * hand the frame over, with no GPU query involved -- so it is both trustworthy
 * and low-variance (it is an EMA). Hiding a layer and watching it move
 * attributes submission cost per module, which fps cannot do at this noise
 * level.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import puppeteer from 'puppeteer';
const PORT = 4556, ROOT = '/Volumes/Projects/bos';
const vp = JSON.parse(fs.readFileSync(`${ROOT}/qa/viewpoints.json`, 'utf8'));
const IDS = (process.argv[2] || 'high-street').split(',');
const LAYERS = ['road-t', 'trees', 'buildings', 'water', 'prop', 'traffic', 'pedestrians',
  'transit', 'far-terrain', 'terrain', 'parks', 'landmark', 'flag'];
const srv = spawn('npx',['vite','preview','--port',String(PORT),'--strictPort','--outDir','dist-qa'],
  {cwd:ROOT,stdio:'ignore',env:{...process.env,VITE_BASE:'/'}});
for(let i=0;i<160;i++){try{if((await fetch(`http://localhost:${PORT}/`)).ok)break;}catch{}await new Promise(r=>setTimeout(r,250));}
const b=await puppeteer.launch({headless:true,protocolTimeout:900000,
  args:['--no-sandbox','--enable-gpu','--use-angle=metal','--enable-unsafe-swiftshader','--ignore-gpu-blocklist','--enable-webgl','--window-size=1280,720']});
const pg=await b.newPage(); await pg.setViewport({width:1280,height:720});
await pg.evaluateOnNewDocument(()=>{try{localStorage.removeItem('bh-tier');localStorage.removeItem('bh-res');localStorage.setItem('bh-onboarded','1')}catch{}});
await pg.goto(`http://localhost:${PORT}/?q=high`,{waitUntil:'networkidle2',timeout:180000});
await pg.waitForFunction('window.__ready === true',{timeout:300000});
await new Promise(r=>setTimeout(r,9000));

/** Let the EMAs (alpha 0.1) settle: ~40 frames is 98% of the way there. */
const read = async () => {
  await pg.evaluate(()=>window.__debug.settle(90));
  await new Promise(r=>setTimeout(r,2200));
  return pg.evaluate(()=>{
    const s = window.__boston.ctx.stats;
    return { fps: s.fps, up: s['cpu.update'], sub: s['cpu.submit'],
      calls: window.__boston.ctx.renderer.info.render.calls };
  });
};

for (const id of IDS) {
  const v = Object.values(vp).find((x) => x.id === id);
  await pg.evaluate((h)=>window.__debug.setTime(h), v.hour ?? 13);
  await pg.evaluate((p,t)=>window.__debug.setView(p,t), v.pos, v.target);
  await new Promise(r=>setTimeout(r,8000));
  const base = await read();
  console.log(`\n== ${id}  fps ${base.fps}  frame ${(1000/base.fps).toFixed(1)}ms`
    + `  cpu.update ${base.up}  cpu.submit ${base.sub}  calls ${base.calls}`);

  await pg.evaluate(()=>{ window.__boston.ctx.renderer.shadowMap.enabled = false; });
  const ns = await read();
  console.log(`   shadows off       calls ${String(ns.calls).padStart(5)} (${ns.calls - base.calls})`
    + `  cpu.submit ${String(ns.sub).padStart(6)} (${(ns.sub - base.sub).toFixed(2)})  fps ${ns.fps}`);
  await pg.evaluate(()=>{ window.__boston.ctx.renderer.shadowMap.enabled = true; });

  for (const layer of LAYERS) {
    const n = await pg.evaluate((m)=>window.__debug.toggle(m,false), layer);
    if (!n) continue;
    const off = await read();
    await pg.evaluate((m)=>window.__debug.toggle(m,true), layer);
    console.log(`   -${layer.padEnd(16)} n=${String(n).padStart(4)}  calls ${String(off.calls).padStart(5)}`
      + ` (${off.calls - base.calls})  cpu.submit ${String(off.sub).padStart(6)}`
      + ` (${(off.sub - base.sub).toFixed(2)})  cpu.update (${(off.up - base.up).toFixed(2)})  fps ${off.fps}`);
  }
}
await b.close(); srv.kill();
