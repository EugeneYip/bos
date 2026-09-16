/** Per-frame draw calls and every ctx.stats counter, camera parked. */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import puppeteer from 'puppeteer';
const PORT = 4553, ROOT = '/Volumes/Projects/bos';
const ID = process.argv[2] || 'high-street', TIER = process.argv[3] || 'high';
const vp = JSON.parse(fs.readFileSync(`${ROOT}/qa/viewpoints.json`, 'utf8'));
const v = Object.values(vp).find((x) => x.id === ID);
const srv = spawn('npx',['vite','preview','--port',String(PORT),'--strictPort','--outDir','dist-qa'],
  {cwd:ROOT,stdio:'ignore',env:{...process.env,VITE_BASE:'/'}});
for(let i=0;i<160;i++){try{if((await fetch(`http://localhost:${PORT}/`)).ok)break;}catch{}await new Promise(r=>setTimeout(r,250));}
const b=await puppeteer.launch({headless:true,protocolTimeout:900000,
  args:['--no-sandbox','--enable-gpu','--use-angle=metal','--enable-unsafe-swiftshader','--ignore-gpu-blocklist','--enable-webgl','--window-size=1280,720']});
const pg=await b.newPage(); await pg.setViewport({width:1280,height:720});
await pg.evaluateOnNewDocument(()=>{try{localStorage.removeItem('bh-tier');localStorage.removeItem('bh-res');localStorage.setItem('bh-onboarded','1')}catch{}});
await pg.goto(`http://localhost:${PORT}/?q=${TIER}`,{waitUntil:'networkidle2',timeout:180000});
await pg.waitForFunction('window.__ready === true',{timeout:300000});
await new Promise(r=>setTimeout(r,8000));
await pg.evaluate((h)=>window.__debug.setTime(h), v.hour ?? 13);
await pg.evaluate((p,t)=>window.__debug.setView(p,t), v.pos, v.target);
await new Promise(r=>setTimeout(r,12000));
await pg.evaluate(()=>window.__debug.settle(120));

const rows = await pg.evaluate(async () => {
  const { renderer, stats } = window.__boston.ctx;
  const out = [];
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => requestAnimationFrame(r));
    out.push({ calls: renderer.info.render.calls, tris: renderer.info.render.triangles,
      progs: renderer.info.programs?.length ?? 0, geo: renderer.info.memory.geometries,
      tex: renderer.info.memory.textures, ...stats });
  }
  return out;
});

const keys = [...new Set(rows.flatMap((r) => Object.keys(r)))]
  .filter((k) => typeof rows[0][k] === 'number');
console.log(`== ${ID} (${TIER})  40 parked frames\n`);
for (const k of keys) {
  const vals = rows.map((r) => r[k] ?? 0);
  const mn = Math.min(...vals), mx = Math.max(...vals);
  if (mx === mn) continue;
  const spread = mn === 0 ? Infinity : (100 * (mx - mn) / mn);
  console.log(`${k.padEnd(26)} ${String(mn).padStart(9)} .. ${String(mx).padStart(9)}  spread ${spread === Infinity ? 'inf' : spread.toFixed(1) + '%'}`);
}
console.log('\nfirst 14 frames of calls / tris:');
console.log(rows.slice(0, 14).map((r) => `${r.calls}/${(r.tris / 1e6).toFixed(2)}M`).join('  '));
await b.close(); srv.kill();
