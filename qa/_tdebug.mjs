/** Terrain debug views at an arbitrary pose, via window.__terrain. */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import puppeteer from 'puppeteer';
const PORT = 4640, ROOT = '/Volumes/Projects/bos';
const POSE = JSON.parse(process.env.POSE);
const MODES = (process.env.MODES || '0,1,2,5').split(',').map(Number);
const srv = spawn('npx',['vite','preview','--port',String(PORT),'--strictPort','--outDir',process.env.QA_OUTDIR ?? 'dist-qa'],
  {cwd:ROOT,stdio:'ignore',env:{...process.env,VITE_BASE:'/'}});
for(let i=0;i<160;i++){try{if((await fetch(`http://localhost:${PORT}/`)).ok)break;}catch{}await new Promise(r=>setTimeout(r,250));}
const b=await puppeteer.launch({headless:true,protocolTimeout:900000,
  args:['--no-sandbox','--enable-gpu','--use-angle=metal','--enable-unsafe-swiftshader','--ignore-gpu-blocklist','--enable-webgl','--window-size=1280,720']});
const pg=await b.newPage(); await pg.setViewport({width:1280,height:720});
await pg.evaluateOnNewDocument(()=>{try{localStorage.removeItem('bh-tier');localStorage.removeItem('bh-res');localStorage.setItem('bh-onboarded','1')}catch{}});
await pg.goto(`http://localhost:${PORT}/?q=high`,{waitUntil:'networkidle2',timeout:180000});
await pg.waitForFunction('window.__ready === true',{timeout:300000});
await new Promise(r=>setTimeout(r,9000));
await pg.evaluate((h)=>window.__debug.setTime(h), POSE.hour);
await pg.evaluate((p,t)=>window.__debug.setView(p,t), POSE.pos, POSE.target);
await new Promise(r=>setTimeout(r,7000));
console.log('terrain stats:', JSON.stringify(await pg.evaluate(()=>window.__terrain.stats())));
for (const m of MODES) {
  await pg.evaluate((k)=>window.__terrain.setDebug(k), m);
  await pg.evaluate(()=>window.__debug.settle(50));
  fs.writeFileSync(`${ROOT}/qa/shots/tdbg-${m}.png`, await pg.screenshot());
  console.log('wrote mode', m);
}
if (process.env.WIRE === '1') {
  await pg.evaluate(()=>window.__terrain.setDebug(0));
  await pg.evaluate(()=>window.__terrain.setWireframe(true));
  await pg.evaluate(()=>window.__debug.settle(50));
  fs.writeFileSync(`${ROOT}/qa/shots/tdbg-wire.png`, await pg.screenshot());
  console.log('wrote wireframe');
}
await b.close(); srv.kill();
