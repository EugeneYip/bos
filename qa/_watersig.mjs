/**
 * The water's large-scale structure, averaged over wind phases.
 *
 * The breeze runs on two slow incommensurate cycles, so the surface at any
 * instant depends on how long the app has been up. One screenshot per build is
 * therefore not a measurement of the build -- it is a measurement of the wind.
 * This takes N samples spaced over half a minute and reports the mean and
 * spread, so a real change can be told from a phase.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import puppeteer from 'puppeteer';
import { PNG } from 'pngjs';
const PORT = Number(process.env.P || 4597);
const ROOT = process.env.R || '/Volumes/Projects/bos';
const vp = Object.values(JSON.parse(fs.readFileSync(`${ROOT}/qa/viewpoints.json`, 'utf8')));
const ID = process.argv[2] || 'charles-water';
const N = Number(process.argv[3] || 8);
const BAND = (process.argv[4] || '280,378,980,436').split(',').map(Number);
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
const v = vp.find((x) => x.id === ID);
await pg.evaluate((h)=>window.__debug.setTime(h), v.hour ?? 13);
await pg.evaluate((p,t)=>window.__debug.setView(p,t), v.pos, v.target);
await new Promise(r=>setTimeout(r,9000));
const [x0,y0,x1,y1] = BAND;
const sds = [], means = [], blacks = [];
for (let k = 0; k < N; k++) {
  await pg.evaluate(()=>window.__debug.settle(70));
  await new Promise(r=>setTimeout(r,3500));   // let the wind move on
  const p = PNG.sync.read(await pg.screenshot());
  const L = (i) => 0.2126*p.data[i] + 0.7152*p.data[i+1] + 0.0722*p.data[i+2];
  const CX = 24, CY = 4, cells = [];
  let black = 0, tot = 0;
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) { if (L((y*p.width+x)*4) < 1) black++; tot++; }
  for (let cy = 0; cy < CY; cy++) for (let cx = 0; cx < CX; cx++) {
    let m = 0, n = 0;
    for (let y = y0 + ((y1-y0)*cy/CY|0); y < y0 + ((y1-y0)*(cy+1)/CY|0); y++)
      for (let x = x0 + ((x1-x0)*cx/CX|0); x < x0 + ((x1-x0)*(cx+1)/CX|0); x++) { m += L((y*p.width+x)*4); n++; }
    cells.push(m/n);
  }
  const mean = cells.reduce((a,c)=>a+c,0)/cells.length;
  const sd = Math.sqrt(cells.reduce((a,c)=>a+(c-mean)**2,0)/cells.length);
  sds.push(sd); means.push(mean); blacks.push(100*black/tot);
}
const stat = (a) => { const m = a.reduce((x,y)=>x+y,0)/a.length;
  return `${m.toFixed(2)} +/- ${Math.sqrt(a.reduce((x,y)=>x+(y-m)**2,0)/a.length).toFixed(2)} (min ${Math.min(...a).toFixed(2)} max ${Math.max(...a).toFixed(2)})`; };
console.log(`${ID}  ${N} samples`);
console.log(`  structure sd  ${stat(sds)}`);
console.log(`  mean luma     ${stat(means)}`);
console.log(`  pure black %  ${stat(blacks)}`);
await b.close(); srv.kill();
