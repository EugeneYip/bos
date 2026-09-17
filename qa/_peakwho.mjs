/** Line the heap curve up against module boot messages to find the peak's owner. */
import { spawn } from 'node:child_process';
import puppeteer from 'puppeteer';
const ROOT='/Volumes/Projects/bos', PORT=Number(process.env.QA_PORT||4403);
const UA='Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';
const srv=spawn('npx',['vite','preview','--port',String(PORT),'--strictPort','--outDir',process.env.QA_OUTDIR??'dist-final'],
  {cwd:ROOT,stdio:'ignore',env:{...process.env,VITE_BASE:'/'}});
for(let i=0;i<160;i++){try{if((await fetch(`http://localhost:${PORT}/`)).ok)break;}catch{}await new Promise(r=>setTimeout(r,250));}
const b=await puppeteer.launch({headless:true,protocolTimeout:900000,
  args:['--no-sandbox','--enable-gpu','--use-angle=metal','--ignore-gpu-blocklist','--enable-webgl','--window-size=1024,768']});
const pg=await b.newPage(); await pg.setViewport({width:1024,height:768}); await pg.setUserAgent(UA);
await pg.evaluateOnNewDocument(()=>{
  try{ localStorage.setItem('bh-onboarded','1'); }catch{}
  window.__t0 = performance.now(); window.__trace=[];
  setInterval(()=>window.__trace.push([Math.round(performance.now()-window.__t0), Math.round((performance.memory?.usedJSHeapSize||0)/1048576)]), 150);
});
const marks=[];
pg.on('console', m=>{ const t=m.text(); if(/^\[[A-Za-z]/.test(t)) marks.push([Date.now(), t.slice(0,72)]); });
const wall0=Date.now();
await pg.goto(`http://localhost:${PORT}/?safe=0`,{waitUntil:'networkidle2',timeout:180000});
await pg.waitForFunction('window.__ready === true',{timeout:300000});
await pg.evaluate(()=>window.__debug.settle(120));
const tr=await pg.evaluate(()=>window.__trace);
const peak=tr.reduce((a,b)=>b[1]>a[1]?b:a,[0,0]);
console.log(`peak ${peak[1]} MB at ${peak[0]} ms`);
console.log('--- heap at each module message ---');
for(const [t,msg] of marks){
  const rel=t-wall0;
  const near=tr.reduce((a,b)=>Math.abs(b[0]-rel)<Math.abs(a[0]-rel)?b:a,tr[0]);
  console.log(String(rel).padStart(6)+' ms  '+String(near[1]).padStart(4)+' MB  '+msg);
}
await b.close(); srv.kill();
