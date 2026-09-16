/** Which pass is the every-other-frame full-scene re-render? */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import puppeteer from 'puppeteer';
const PORT = 4553, ROOT = '/Volumes/Projects/bos';
const vp = JSON.parse(fs.readFileSync(`${ROOT}/qa/viewpoints.json`, 'utf8'));
const v = Object.values(vp).find((x) => x.id === (process.argv[2] || 'high-street'));
const srv = spawn('npx',['vite','preview','--port',String(PORT),'--strictPort','--outDir','dist-qa'],
  {cwd:ROOT,stdio:'ignore',env:{...process.env,VITE_BASE:'/'}});
for(let i=0;i<160;i++){try{if((await fetch(`http://localhost:${PORT}/`)).ok)break;}catch{}await new Promise(r=>setTimeout(r,250));}
const b=await puppeteer.launch({headless:true,protocolTimeout:900000,
  args:['--no-sandbox','--enable-gpu','--use-angle=metal','--enable-unsafe-swiftshader','--ignore-gpu-blocklist','--enable-webgl','--window-size=1280,720']});
const pg=await b.newPage(); await pg.setViewport({width:1280,height:720});
await pg.evaluateOnNewDocument(()=>{try{localStorage.removeItem('bh-tier');localStorage.removeItem('bh-res');localStorage.setItem('bh-onboarded','1')}catch{}});
await pg.goto(`http://localhost:${PORT}/?q=high`,{waitUntil:'networkidle2',timeout:180000});
await pg.waitForFunction('window.__ready === true',{timeout:300000});
await new Promise(r=>setTimeout(r,8000));
await pg.evaluate((h)=>window.__debug.setTime(h), v.hour ?? 13);
await pg.evaluate((p,t)=>window.__debug.setView(p,t), v.pos, v.target);
await new Promise(r=>setTimeout(r,10000));

const seq = async () => {
  await pg.evaluate(()=>window.__debug.settle(60));
  return pg.evaluate(async () => {
    const r = window.__boston.ctx.renderer.info.render; const o = [];
    for (let i = 0; i < 10; i++) { await new Promise((k)=>requestAnimationFrame(k)); o.push(r.calls); }
    return o;
  });
};
const show = (tag, s) => {
  const mn = Math.min(...s), mx = Math.max(...s);
  console.log(`${tag.padEnd(26)} ${s.join(' ')}   delta ${mx - mn}`);
};
show('baseline', await seq());

// three's own shadow pass.
await pg.evaluate(()=>{ window.__boston.ctx.renderer.shadowMap.enabled = false; });
show('shadowMap.enabled=false', await seq());
await pg.evaluate(()=>{ window.__boston.ctx.renderer.shadowMap.enabled = true; });

// Every scene-rendering pass Post owns, one at a time, if it exposes them.
const passes = await pg.evaluate(() => {
  const p = window.__boston.post ?? window.__post ?? null;
  if (!p) return null;
  return Object.keys(p).concat(p.passes ? Object.keys(p.passes) : []);
});
console.log('post surface:', passes ? passes.join(',') : '(not exposed on window)');
await b.close(); srv.kill();
