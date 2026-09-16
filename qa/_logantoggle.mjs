/** The same Logan pose with the new pavement shown, then hidden. */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import puppeteer from 'puppeteer';
const PORT = 4583, ROOT = '/Volumes/Projects/bos';
const srv = spawn('npx',['vite','preview','--port',String(PORT),'--strictPort','--outDir','dist-qa'],
  {cwd:ROOT,stdio:'ignore',env:{...process.env,VITE_BASE:'/'}});
for(let i=0;i<160;i++){try{if((await fetch(`http://localhost:${PORT}/`)).ok)break;}catch{}await new Promise(r=>setTimeout(r,250));}
const b=await puppeteer.launch({headless:true,protocolTimeout:900000,
  args:['--no-sandbox','--enable-gpu','--use-angle=metal','--enable-unsafe-swiftshader','--ignore-gpu-blocklist','--enable-webgl','--window-size=1280,720']});
const pg=await b.newPage(); await pg.setViewport({width:1280,height:720});
await pg.evaluateOnNewDocument(()=>{try{localStorage.removeItem('bh-tier');localStorage.removeItem('bh-res');localStorage.setItem('bh-onboarded','1')}catch{}});
await pg.goto(`http://localhost:${PORT}/?q=high`,{waitUntil:'networkidle2',timeout:180000});
await pg.waitForFunction('window.__ready === true',{timeout:300000});
await pg.evaluate(()=>window.__debug.setTime(12.8));
await pg.evaluate(()=>window.__debug.setView([3771,300,-1550],[3771,5,-644]));
await new Promise(r=>setTimeout(r,14000));
const shot = async (tag) => {
  await pg.evaluate(()=>window.__debug.settle(80));
  fs.writeFileSync(`${ROOT}/qa/shots/logan-tog-${tag}.png`, await pg.screenshot());
  console.log('wrote', tag);
};
await shot('all2');
for (const m of ['terrain', 'far-terrain', 'parks', 'road-t', 'water']) {
  const n = await pg.evaluate((k)=>window.__debug.toggle(k, false), m);
  await shot('no-' + m);
  await pg.evaluate((k)=>window.__debug.toggle(k, true), m);
  console.log('hid', m, n);
}
await b.close(); srv.kill();
