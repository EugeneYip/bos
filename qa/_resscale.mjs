/**
 * Fill-bound or CPU-bound? Halve the pixels and see.
 *
 * Every per-pass timer in this project reports a number larger than the frame
 * it sits in, because three modules each run their own TIME_ELAPSED query on
 * one GL context and WebGL2 allows exactly one in flight. So ask the question
 * a way that needs no timer: quarter the pixel count. Fill-bound work scales
 * with pixels; per-object and per-draw work does not.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import puppeteer from 'puppeteer';
const PORT = 4555, ROOT = '/Volumes/Projects/bos';
const vp = JSON.parse(fs.readFileSync(`${ROOT}/qa/viewpoints.json`, 'utf8'));
const IDS = (process.argv[2] || 'high-street,street-night,boot-default').split(',');
const srv = spawn('npx',['vite','preview','--port',String(PORT),'--strictPort','--outDir','dist-qa'],
  {cwd:ROOT,stdio:'ignore',env:{...process.env,VITE_BASE:'/'}});
for(let i=0;i<160;i++){try{if((await fetch(`http://localhost:${PORT}/`)).ok)break;}catch{}await new Promise(r=>setTimeout(r,250));}
const b=await puppeteer.launch({headless:true,protocolTimeout:900000,
  args:['--no-sandbox','--enable-gpu','--use-angle=metal','--enable-unsafe-swiftshader','--ignore-gpu-blocklist','--enable-webgl','--window-size=1280,720']});
const pg=await b.newPage();
await pg.evaluateOnNewDocument(()=>{try{localStorage.removeItem('bh-tier');localStorage.removeItem('bh-res');localStorage.setItem('bh-onboarded','1')}catch{}});
await pg.setViewport({width:1280,height:720});
await pg.goto(`http://localhost:${PORT}/?q=high`,{waitUntil:'networkidle2',timeout:180000});
await pg.waitForFunction('window.__ready === true',{timeout:300000});
await new Promise(r=>setTimeout(r,9000));
console.log('app surface:', await pg.evaluate(()=>Object.keys(window.__boston)));

const measure = async () => {
  await pg.evaluate(()=>window.__debug.settle(120));
  await new Promise(r=>setTimeout(r,3000));
  return pg.evaluate(()=>{
    const { renderer, stats } = window.__boston.ctx;
    const d = renderer.domElement;
    return { fps: stats.fps, low: stats['fps.low'], calls: renderer.info.render.calls,
      mpx: +(d.width * d.height / 1e6).toFixed(3) };
  });
};

for (const id of IDS) {
  const v = Object.values(vp).find((x) => x.id === id);
  await pg.evaluate((h)=>window.__debug.setTime(h), v.hour ?? 13);
  await pg.evaluate((p,t)=>window.__debug.setView(p,t), v.pos, v.target);
  await new Promise(r=>setTimeout(r,8000));
  const rows = [];
  for (const [label, w, h] of [['1280x720', 1280, 720], ['905x509 (0.5 px)', 905, 509],
    ['640x360 (0.25 px)', 640, 360], ['1810x1018 (2 px)', 1810, 1018]]) {
    await pg.setViewport({ width: w, height: h });
    await new Promise(r=>setTimeout(r,2500));
    await pg.evaluate((p,t)=>window.__debug.setView(p,t), v.pos, v.target);
    const m = await measure();
    rows.push([label, m]);
  }
  await pg.setViewport({ width: 1280, height: 720 });
  console.log(`\n== ${id}`);
  const base = rows[0][1];
  for (const [label, m] of rows) {
    const ms = 1000 / m.fps, baseMs = 1000 / base.fps;
    console.log(`   ${label.padEnd(18)} ${m.mpx.toFixed(3)} Mpx  fps ${String(m.fps).padStart(3)}`
      + `  ${ms.toFixed(1)}ms  calls ${m.calls}`
      + `   pixel ratio ${(m.mpx / base.mpx).toFixed(2)}x -> time ratio ${(ms / baseMs).toFixed(2)}x`);
  }
}
await b.close(); srv.kill();
