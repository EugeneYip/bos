/** Sweeps time of day on the application's own opening camera. */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import puppeteer from 'puppeteer';
import { PNG } from 'pngjs';
const PORT = 4537, ROOT = '/Volumes/Projects/bos';
const hours = process.argv.slice(2).map(Number);
const srv = spawn('npx', ['vite','preview','--port',String(PORT),'--strictPort','--outDir','dist-qa'],
  { cwd: ROOT, stdio: 'ignore', env: { ...process.env, VITE_BASE: '/' } });
for (let i=0;i<160;i++){ try{ if((await fetch(`http://localhost:${PORT}/`)).ok) break; }catch{} await new Promise(r=>setTimeout(r,250)); }
const b = await puppeteer.launch({ headless:true, protocolTimeout:900000,
  args:['--no-sandbox','--enable-gpu','--use-angle=metal','--enable-unsafe-swiftshader','--ignore-gpu-blocklist','--enable-webgl','--window-size=1280,720'] });
const pg = await b.newPage(); await pg.setViewport({width:1280,height:720});
await pg.evaluateOnNewDocument(()=>{try{localStorage.removeItem('bh-tier');localStorage.removeItem('bh-res');localStorage.setItem('bh-onboarded','1')}catch{}});
await pg.goto(`http://localhost:${PORT}/?q=high`,{waitUntil:'networkidle2',timeout:180000});
await pg.waitForFunction('window.__ready === true',{timeout:300000});
await new Promise(r=>setTimeout(r,10000));
for (const h of hours) {
  await pg.evaluate((hh)=>window.__debug.setTime(hh),h);
  await new Promise(r=>setTimeout(r,4000));
  await pg.evaluate(()=>window.__debug.settle(90));
  const buf = await pg.screenshot();
  const label = `boot-t${String(h).replace('.','_')}`;
  fs.writeFileSync(`${ROOT}/qa/shots/fog/${label}.png`, buf);
  const p = PNG.sync.read(buf);
  const L=(i)=>0.2126*p.data[i]+0.7152*p.data[i+1]+0.0722*p.data[i+2];
  const band=(y0,y1,x0,x1)=>{let s=0,m=0,n=0;for(let y=y0;y<y1;y+=2)for(let x=x0;x<x1;x+=2){const i=(y*p.width+x)*4;
    s+=Math.abs(L(i)-L(i+4))+Math.abs(L(i)-L(i+p.width*4));m+=L(i);n++;}return{c:s/n,l:m/n};};
  const far=band(240,330,100,1180), sun=band(240,460,40,420), near=band(480,660,200,1080);
  const el=await pg.evaluate(()=>+(window.__boston.ctx.sun.elevation*180/Math.PI).toFixed(1));
  console.log(`t=${String(h).padEnd(5)} sunEl ${String(el).padStart(5)}deg  far ${far.c.toFixed(2)}/${far.l.toFixed(1)}  sunSide ${sun.c.toFixed(2)}/${sun.l.toFixed(1)}  near ${near.c.toFixed(2)}/${near.l.toFixed(1)}`);
}
await b.close(); srv.kill();
