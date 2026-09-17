/** Peak JS heap during load — what an OOM killer actually reacts to. */
import { spawn } from 'node:child_process';
import puppeteer from 'puppeteer';
const ROOT='/Volumes/Projects/bos', PORT=Number(process.env.QA_PORT||4401);
const UA = process.env.MOBILE_UA ? 'Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1' : null;
const srv=spawn('npx',['vite','preview','--port',String(PORT),'--strictPort','--outDir',process.env.QA_OUTDIR??'dist-final'],
  {cwd:ROOT,stdio:'ignore',env:{...process.env,VITE_BASE:'/'}});
for(let i=0;i<160;i++){try{if((await fetch(`http://localhost:${PORT}/`)).ok)break;}catch{}await new Promise(r=>setTimeout(r,250));}
const b=await puppeteer.launch({headless:true,protocolTimeout:900000,
  args:['--no-sandbox','--enable-gpu','--use-angle=metal','--ignore-gpu-blocklist','--enable-webgl','--window-size=1180,820']});
const pg=await b.newPage(); await pg.setViewport({width:1180,height:820,deviceScaleFactor:2});
if(UA) await pg.setUserAgent(UA);
await pg.evaluateOnNewDocument(()=>{
  try{ localStorage.setItem('bh-onboarded','1'); }catch{}
  window.__peak = 0; window.__trace = [];
  const t0 = performance.now();
  setInterval(() => {
    const m = performance.memory?.usedJSHeapSize || 0;
    if (m > window.__peak) window.__peak = m;
    window.__trace.push([Math.round(performance.now()-t0), Math.round(m/1048576)]);
  }, 200);
});
await pg.goto(`http://localhost:${PORT}/${process.env.Q?`?q=${process.env.Q}`:''}`,{waitUntil:'networkidle2',timeout:180000});
await pg.waitForFunction('window.__ready === true',{timeout:300000});
await pg.evaluate(()=>window.__debug.settle(400));
await new Promise(r=>setTimeout(r,9000));
const cdp=await pg.target().createCDPSession();
await cdp.send('HeapProfiler.enable'); await cdp.send('HeapProfiler.collectGarbage');
await new Promise(r=>setTimeout(r,1200));
console.log(JSON.stringify(await pg.evaluate(()=>{
  const tr=window.__trace;
  const peakAt=tr.reduce((a,b)=>b[1]>a[1]?b:a,[0,0]);
  return { peakMB: Math.round(window.__peak/1048576), peakAtMs: peakAt[0],
    settledMB: Math.round(performance.memory.usedJSHeapSize/1048576),
    curve: tr.filter((_,i)=>i%5===0).map(p=>p[1]).join(',') };
})));
await b.close(); srv.kill();
