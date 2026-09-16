/** Candidate opening framings x time of day, measured and shot. */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import puppeteer from 'puppeteer';
import { PNG } from 'pngjs';
const PORT = 4538, ROOT = '/Volumes/Projects/bos';
const CAND = [
  ['C0-ref',  [-1500, 520, -1500], [200, 40, 300]],
  ['C1-back', [-1900, 560, -2100], [500, 30, 100]],
  ['C2-close',[-1200, 430, -1900], [700, 20, 200]],
  ['C3-west', [-2200, 620, -1600], [600, 30, 300]],
];
const HOURS = process.argv.slice(2).map(Number);
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
for (const h of HOURS) {
  await pg.evaluate((hh)=>window.__debug.setTime(hh),h);
  for (const [name,pos,tgt] of CAND) {
    await pg.evaluate((p,t)=>window.__debug.setView(p,t),pos,tgt);
    await new Promise(r=>setTimeout(r,3500));
    await pg.evaluate(()=>window.__debug.settle(90));
    const buf=await pg.screenshot();
    const label=`f-${name}-t${String(h).replace('.','_')}`;
    fs.writeFileSync(`${ROOT}/qa/shots/fog/${label}.png`,buf);
    const p=PNG.sync.read(buf);
    const L=(i)=>0.2126*p.data[i]+0.7152*p.data[i+1]+0.0722*p.data[i+2];
    // Whole-frame local contrast, plus the fraction of pixels that are both
    // bright and flat -- the signature of a haze sheet.
    let s=0,m=0,n=0,washed=0;
    for(let y=8;y<680;y+=2)for(let x=8;x<1272;x+=2){const i=(y*p.width+x)*4;
      const d=Math.abs(L(i)-L(i+4))+Math.abs(L(i)-L(i+p.width*4));
      s+=d;m+=L(i);n++; if(L(i)>110&&d<3) washed++;}
    console.log(`t=${String(h).padEnd(5)} ${name.padEnd(7)} contrast ${(s/n).toFixed(2)}  luma ${(m/n).toFixed(1)}  washedPx ${(100*washed/n).toFixed(1)}%`);
  }
}
await b.close(); srv.kill();
