/** Name what is under given screen pixels, via __debug.pick. */
import { spawn } from 'node:child_process';
import puppeteer from 'puppeteer';
const PORT = 4600, ROOT = '/Volumes/Projects/bos';
const POSE = JSON.parse(process.env.POSE);
const PTS = JSON.parse(process.env.PTS);
const srv = spawn('npx',['vite','preview','--port',String(PORT),'--strictPort','--outDir','dist-qa'],
  {cwd:ROOT,stdio:'ignore',env:{...process.env,VITE_BASE:'/'}});
for(let i=0;i<160;i++){try{if((await fetch(`http://localhost:${PORT}/`)).ok)break;}catch{}await new Promise(r=>setTimeout(r,250));}
const b=await puppeteer.launch({headless:true,protocolTimeout:900000,
  args:['--no-sandbox','--enable-gpu','--use-angle=metal','--enable-unsafe-swiftshader','--ignore-gpu-blocklist','--enable-webgl','--window-size=1280,720']});
const pg=await b.newPage(); await pg.setViewport({width:1280,height:720});
await pg.evaluateOnNewDocument(()=>{try{localStorage.removeItem('bh-tier');localStorage.removeItem('bh-res');localStorage.setItem('bh-onboarded','1')}catch{}});
await pg.goto(`http://localhost:${PORT}/?q=high`,{waitUntil:'networkidle2',timeout:180000});
await pg.waitForFunction('window.__ready === true',{timeout:300000});
await new Promise(r=>setTimeout(r,10000));
await pg.evaluate((h)=>window.__debug.setTime(h), POSE.hour);
await pg.evaluate((p,t)=>window.__debug.setView(p,t), POSE.pos, POSE.target);
await new Promise(r=>setTimeout(r,9000));
await pg.evaluate(()=>window.__debug.settle(60));
for (const [x, y, label] of PTS) {
  const hits = await pg.evaluate(([a,c])=>window.__debug.pick(a,c,5), [x,y]);
  console.log(`(${String(x).padStart(4)},${String(y).padStart(3)}) ${String(label).padEnd(22)}`
    + (hits.length ? hits.map((h)=>`${h.name}@${h.dist}m`).join('  |  ') : '(nothing)'));
}
await b.close(); srv.kill();
