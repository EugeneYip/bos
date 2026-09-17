/** Heap and CPU-geometry footprint after the scene settles. */
import { spawn } from 'node:child_process';
import puppeteer from 'puppeteer';
const ROOT='/Volumes/Projects/bos', PORT=Number(process.env.QA_PORT||4392);
const TIER=process.env.TIER||'high';
const srv=spawn('npx',['vite','preview','--port',String(PORT),'--strictPort','--outDir',process.env.QA_OUTDIR??'dist-final'],
  {cwd:ROOT,stdio:'ignore',env:{...process.env,VITE_BASE:'/'}});
for(let i=0;i<160;i++){try{if((await fetch(`http://localhost:${PORT}/`)).ok)break;}catch{}await new Promise(r=>setTimeout(r,250));}
const UA = process.env.MOBILE_UA ? 'Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1' : null;
const b=await puppeteer.launch({headless:true,protocolTimeout:900000,
  args:['--no-sandbox','--enable-gpu','--use-angle=metal','--ignore-gpu-blocklist','--enable-webgl','--js-flags=--expose-gc','--window-size=1280,720']});
const pg=await b.newPage(); await pg.setViewport({width:1280,height:720});
if (UA) await pg.setUserAgent(UA);
await pg.evaluateOnNewDocument(()=>{try{localStorage.setItem('bh-onboarded','1')}catch{}});
await pg.goto(`http://localhost:${PORT}/?q=${TIER}`,{waitUntil:'networkidle2',timeout:180000});
await pg.waitForFunction('window.__ready === true',{timeout:300000});
// Let the streaming finish and the release sweep run several times.
await pg.evaluate(()=>window.__debug.settle(400));
await new Promise(r=>setTimeout(r,8000));
await pg.evaluate(()=>window.__debug.settle(200));
const r=await pg.evaluate(()=>{
  let bytes=0, nulled=0, kept=0; const seen=new Set();
  window.__boston.ctx.scene.traverse(o=>{const g=o.geometry; if(!g||seen.has(g))return; seen.add(g);
    for(const k in g.attributes){const a=g.attributes[k];
      if(a && a.array) { bytes+=a.array.byteLength; kept++; } else if(a) nulled++; }
    if(g.index&&g.index.array) bytes+=g.index.array.byteLength;});
  const s=window.__debug.stats();
  return { heapMB: Math.round(performance.memory.usedJSHeapSize/1048576),
           cpuGeoMB: +(bytes/1048576).toFixed(0), attrsNulled: nulled, attrsKept: kept,
           tris: s.tris, fps: s.fps, geometries: seen.size };
});
console.log(`tier=${TIER}`, JSON.stringify(r));
await b.close(); srv.kill();
