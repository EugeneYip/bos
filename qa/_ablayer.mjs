/**
 * Per-layer render cost, measured the only way this machine allows.
 *
 * One page session; hide a layer, sample, show it, sample; alternate; repeat;
 * take medians. Two-build comparisons here are worthless (2.5x run-to-run on
 * an identical build) and so is a single toggle-once-and-read (the machine
 * drifts by more than any layer costs). Alternating puts every slow patch
 * into both arms.
 *
 * Measures *render* cost only -- a hidden module still runs its update, which
 * `cpu.<Module>` reports separately.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import puppeteer from 'puppeteer';
const PORT = 4559, ROOT = '/Volumes/Projects/bos';
const vp = JSON.parse(fs.readFileSync(`${ROOT}/qa/viewpoints.json`, 'utf8'));
const ID = process.argv[2] || 'high-street';
const REPS = Number(process.argv[3] || 5);
const TIER = process.argv[4] || 'high';
const LAYERS = ['__shadows', 'water', 'trees', 'buildings', 'road-t', 'prop',
  'traffic', 'pedestrians', 'landmark', 'terrain', 'far-terrain', 'parks', 'transit'];
const srv = spawn('npx',['vite','preview','--port',String(PORT),'--strictPort','--outDir','dist-qa'],
  {cwd:ROOT,stdio:'ignore',env:{...process.env,VITE_BASE:'/'}});
for(let i=0;i<160;i++){try{if((await fetch(`http://localhost:${PORT}/`)).ok)break;}catch{}await new Promise(r=>setTimeout(r,250));}
const b=await puppeteer.launch({headless:true,protocolTimeout:900000,
  args:['--no-sandbox','--enable-gpu','--use-angle=metal','--enable-unsafe-swiftshader','--ignore-gpu-blocklist','--enable-webgl','--window-size=1280,720']});
const pg=await b.newPage(); await pg.setViewport({width:1280,height:720});
await pg.evaluateOnNewDocument(()=>{try{localStorage.removeItem('bh-tier');localStorage.removeItem('bh-res');localStorage.setItem('bh-onboarded','1')}catch{}});
await pg.goto(`http://localhost:${PORT}/?q=${TIER}`,{waitUntil:'networkidle2',timeout:180000});
await pg.waitForFunction('window.__ready === true',{timeout:300000});
await new Promise(r=>setTimeout(r,9000));
const v = Object.values(vp).find((x) => x.id === ID);
await pg.evaluate((h)=>window.__debug.setTime(h), v.hour ?? 13);
await pg.evaluate((p,t)=>window.__debug.setView(p,t), v.pos, v.target);
await new Promise(r=>setTimeout(r,9000));

const set = (layer, on) => pg.evaluate(([m, o]) => {
  if (m === '__shadows') { window.__boston.ctx.renderer.shadowMap.enabled = o; return 1; }
  return window.__debug.toggle(m, o);
}, [layer, on]);
const sample = async () => {
  await pg.evaluate(()=>window.__debug.settle(100));
  await new Promise(r=>setTimeout(r,1500));
  return pg.evaluate(()=>({ fps: window.__boston.ctx.stats.fps,
    calls: window.__boston.ctx.renderer.info.render.calls }));
};
const med = (a) => { const s=[...a].sort((x,y)=>x-y); return s[s.length>>1]; };

console.log(`== ${ID} (${TIER}) ${REPS} interleaved repeats per layer\n`);
for (const layer of LAYERS) {
  const n = await set(layer, false);
  if (!n) { await set(layer, true); continue; }
  await set(layer, true);
  const on = [], off = [], callsOn = [], callsOff = [];
  for (let i = 0; i < REPS; i++) {
    await set(layer, true);  let s = await sample(); on.push(s.fps);  callsOn.push(s.calls);
    await set(layer, false); s = await sample();     off.push(s.fps); callsOff.push(s.calls);
  }
  await set(layer, true);
  const mOn = med(on), mOff = med(off);
  const saved = 1000 / mOn - 1000 / mOff;
  console.log(`  -${layer.padEnd(13)} n=${String(n).padStart(4)}`
    + `  with ${String(mOn).padStart(3)} fps  without ${String(mOff).padStart(3)} fps`
    + `  => ${saved >= 0 ? '+' : ''}${saved.toFixed(1)}ms`
    + `   calls ${med(callsOn)} -> ${med(callsOff)}`
    + `   [${on.join(',')} | ${off.join(',')}]`);
}
await b.close(); srv.kill();
