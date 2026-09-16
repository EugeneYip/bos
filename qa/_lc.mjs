import { spawn } from 'node:child_process';
import puppeteer from 'puppeteer';
const PORT=4599, ROOT='/Volumes/Projects/bos';
const srv=spawn('npx',['vite','preview','--port',String(PORT),'--strictPort','--outDir','dist-qa'],
  {cwd:ROOT,stdio:'ignore',env:{...process.env,VITE_BASE:'/'}});
for(let i=0;i<160;i++){try{if((await fetch(`http://localhost:${PORT}/`)).ok)break;}catch{}await new Promise(r=>setTimeout(r,250));}
const b=await puppeteer.launch({headless:true,protocolTimeout:900000,
  args:['--no-sandbox','--enable-gpu','--use-angle=metal','--enable-unsafe-swiftshader','--ignore-gpu-blocklist','--enable-webgl','--window-size=800,600']});
const pg=await b.newPage();
const lines=[];
pg.on('console',(m)=>{const t=m.text(); if(/LandCover|Terrain\]|Water\]|Roads\]|Parks\]|Traffic\]|Transit\]/.test(t)) lines.push(t.slice(0,240));});
await pg.evaluateOnNewDocument(()=>{try{localStorage.removeItem('bh-tier');localStorage.setItem('bh-onboarded','1')}catch{}});
await pg.goto(`http://localhost:${PORT}/?q=medium`,{waitUntil:'networkidle2',timeout:180000});
await pg.waitForFunction('window.__ready === true',{timeout:300000});
for(const l of lines) console.log(l);
const want = (process.env.STATS||'').split(',').filter(Boolean);
if (want.length) console.log(JSON.stringify(await pg.evaluate((k)=>{
  const s = window.__boston.ctx.stats; const o = {};
  for (const n of k) o[n] = s[n];
  return o;
}, want)));
await b.close(); srv.kill();
