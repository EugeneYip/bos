/** Actual pixel budget: render resolution, and every render target allocated. */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import puppeteer from 'puppeteer';
const PORT = 4553, ROOT = '/Volumes/Projects/bos';
const vp = JSON.parse(fs.readFileSync(`${ROOT}/qa/viewpoints.json`, 'utf8'));
const v = Object.values(vp).find((x) => x.id === (process.argv[2] || 'high-street'));
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
await new Promise(r=>setTimeout(r,8000));
await pg.evaluate((h)=>window.__debug.setTime(h), v.hour ?? 13);
await pg.evaluate((p,t)=>window.__debug.setView(p,t), v.pos, v.target);
await new Promise(r=>setTimeout(r,9000));
await pg.evaluate(()=>window.__debug.settle(90));

console.log(JSON.stringify(await pg.evaluate(() => {
  const { renderer, stats, tier } = window.__boston.ctx;
  const dw = renderer.domElement.width, dh = renderer.domElement.height;
  const timings = {};
  for (const [k, v] of Object.entries(stats)) {
    const n = typeof v === 'number' ? v : (typeof v === 'string' && /ms$/.test(v) ? parseFloat(v) : null);
    if (n !== null && /(ms|Ms)$/.test(k)) timings[k] = n;
  }
  return { tier, pixelRatio: renderer.getPixelRatio(), drawingBuffer: [dw, dh],
    megapixels: +(dw * dh / 1e6).toFixed(3), fps: stats.fps, fpsLow: stats['fps.low'],
    programs: renderer.info.programs.length, timings };
}), null, 1));

// Every live WebGL texture/renderbuffer, by size, via the GL context.
console.log(await pg.evaluate(() => {
  const r = window.__boston.ctx.renderer;
  return `programs ${r.info.programs.length}  geometries ${r.info.memory.geometries}  textures ${r.info.memory.textures}`;
}));
await b.close(); srv.kill();
