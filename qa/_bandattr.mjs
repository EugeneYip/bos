/** Which layer draws the dark stripe at the horizon? Hide one, re-read it. */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import puppeteer from 'puppeteer';
import { PNG } from 'pngjs';
const PORT = 4554, ROOT = '/Volumes/Projects/bos';
const srv = spawn('npx',['vite','preview','--port',String(PORT),'--strictPort','--outDir','dist-qa'],
  {cwd:ROOT,stdio:'ignore',env:{...process.env,VITE_BASE:'/'}});
for(let i=0;i<160;i++){try{if((await fetch(`http://localhost:${PORT}/`)).ok)break;}catch{}await new Promise(r=>setTimeout(r,250));}
const b=await puppeteer.launch({headless:true,protocolTimeout:900000,
  args:['--no-sandbox','--enable-gpu','--use-angle=metal','--enable-unsafe-swiftshader','--ignore-gpu-blocklist','--enable-webgl','--window-size=1280,720']});
const pg=await b.newPage(); await pg.setViewport({width:1280,height:720});
await pg.evaluateOnNewDocument(()=>{try{localStorage.removeItem('bh-tier');localStorage.removeItem('bh-res');localStorage.setItem('bh-onboarded','1')}catch{}});
await pg.goto(`http://localhost:${PORT}/?q=high`,{waitUntil:'networkidle2',timeout:180000});
await pg.waitForFunction('window.__ready === true',{timeout:300000});
await new Promise(r=>setTimeout(r,12000));   // the app's own opening camera

const profile = async (tag) => {
  await pg.evaluate(()=>window.__debug.settle(70));
  const buf = await pg.screenshot();
  fs.writeFileSync(`${ROOT}/qa/shots/fog/band-${tag}.png`, buf);
  const p = PNG.sync.read(buf);
  const row = (y) => { let r=0,g=0,bl=0,n=0;
    for (let x=300;x<1000;x+=7){const i=(y*p.width+x)*4;r+=p.data[i];g+=p.data[i+1];bl+=p.data[i+2];n++;}
    return `${(r/n)|0},${(g/n)|0},${(bl/n)|0}`; };
  console.log(`${tag.padEnd(16)} y244 ${row(244)}   y256 ${row(256)}   y268 ${row(268)}`);
};
await profile('baseline');
for (const layer of ['water', 'far-terrain', 'terrain', 'sky']) {
  const n = await pg.evaluate((m)=>window.__debug.toggle(m,false), layer);
  await profile(`no-${layer}(${n})`);
  await pg.evaluate((m)=>window.__debug.toggle(m,true), layer);
}
await b.close(); srv.kill();
