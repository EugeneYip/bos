/**
 * A/B inside one page session, alternating, many repeats.
 *
 * This machine gives 38 fps and 15 fps for the same build at the same
 * viewpoint, so comparing two builds is hopeless. Flipping the thing under
 * test at runtime and interleaving the samples holds everything else
 * constant, and alternating means a slow patch of machine hits both arms.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import puppeteer from 'puppeteer';
const PORT = 4558, ROOT = '/Volumes/Projects/bos';
const vp = JSON.parse(fs.readFileSync(`${ROOT}/qa/viewpoints.json`, 'utf8'));
const IDS = (process.argv[2] || 'high-street,zakim,common-street').split(',');
const REPS = Number(process.argv[3] || 7);
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

/** Put every ground-level road mesh back to casting, as it was before. */
await pg.evaluate(() => {
  window.__abRoads = [];
  window.__boston.ctx.scene.traverse((o) => {
    if ((o.isMesh || o.isInstancedMesh) && /^road-t\d:/.test(o.name || '')
        && !o.name.endsWith(':structure')) window.__abRoads.push(o);
  });
  window.__abSet = (on) => { for (const o of window.__abRoads) o.castShadow = on; };
  return window.__abRoads.length;
}).then((n) => console.log(`road meshes under test: ${n}`));

const sample = async () => {
  await pg.evaluate(()=>window.__debug.settle(100));
  await new Promise(r=>setTimeout(r,1600));
  return pg.evaluate(()=>window.__boston.ctx.stats.fps);
};
const med = (a) => { const s=[...a].sort((x,y)=>x-y); return s[s.length>>1]; };

for (const id of IDS) {
  const v = Object.values(vp).find((x) => x.id === id);
  await pg.evaluate((h)=>window.__debug.setTime(h), v.hour ?? 13);
  await pg.evaluate((p,t)=>window.__debug.setView(p,t), v.pos, v.target);
  await new Promise(r=>setTimeout(r,8000));
  const on = [], off = [];
  for (let i = 0; i < REPS; i++) {
    // Re-assert every rep: the shading sweep runs every 30 frames and turns
    // casting back on for anything without the noShadow flag.
    await pg.evaluate(()=>window.__abSet(true));  on.push(await sample());
    await pg.evaluate(()=>window.__abSet(false)); off.push(await sample());
  }
  const mOn = med(on), mOff = med(off);
  console.log(`${id.padEnd(18)} roads cast: ${String(mOn).padStart(3)} fps  [${on.join(' ')}]`);
  console.log(`${' '.repeat(18)} roads don't: ${String(mOff).padStart(3)} fps  [${off.join(' ')}]`
    + `   ${(1000/mOn - 1000/mOff).toFixed(1)}ms saved  (${((mOff/mOn - 1) * 100).toFixed(0)}% faster)`);
}
await b.close(); srv.kill();
