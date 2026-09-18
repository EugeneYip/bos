/**
 * Name what is under the pale ground pixels, at the opening view.
 *
 * Shoot and raycast in ONE session at ONE resolution, because translating
 * coordinates by hand between a capture and a pick viewport has put probes a
 * few metres off their target repeatedly in this repo.
 */
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import puppeteer from 'puppeteer';
import { PNG } from 'pngjs';
const ROOT='/Volumes/Projects/bos', PORT=Number(process.env.QA_PORT||4484), OUT=process.env.LOCAL||'dist-present';
const W=1600, H=900;
const views = JSON.parse(fs.readFileSync(`${ROOT}/qa/viewpoints.json`,'utf8'));
const v = (Array.isArray(views)?views:views.viewpoints).find(z=>z.id===(process.env.POSE||'boot-default'));
const srv = spawn('npx',['vite','preview','--port',String(PORT),'--strictPort','--outDir',OUT],
  {cwd:ROOT,stdio:'ignore',env:{...process.env,VITE_BASE:'/'}});
for(let i=0;i<160;i++){try{if((await fetch(`http://localhost:${PORT}/`)).ok)break;}catch{}await new Promise(r=>setTimeout(r,250));}
const b=await puppeteer.launch({headless:true,protocolTimeout:900000,
  args:['--no-sandbox','--enable-gpu','--use-angle=metal','--ignore-gpu-blocklist','--enable-webgl']});
const pg=await b.newPage(); await pg.setViewport({width:W,height:H,deviceScaleFactor:1});
await pg.evaluateOnNewDocument(()=>{try{localStorage.setItem('bh-onboarded','1')}catch{}});
await pg.goto(`http://localhost:${PORT}/`,{waitUntil:'domcontentloaded',timeout:120000});
await pg.waitForFunction('window.__ready === true',{timeout:300000,polling:500});
await pg.evaluate((p)=>{window.__debug.setTime(p.hour); window.__debug.setView(p.pos,p.target);}, v);
await pg.evaluate(()=>window.__debug.settle(160));
const img = PNG.sync.read(Buffer.from(await pg.screenshot()));
// HUD sits bottom-left and is pure white; never pick into it.
const hud=(x,y)=>(y>H-80&&x<300)||(y>H-60);
const cand=[];
for(let y=Math.floor(H*0.50); y<H-70; y+=5) for(let x=8;x<W-8;x+=5){
  if(hud(x,y))continue;
  const i=(y*img.width+x)*4,r=img.data[i],g=img.data[i+1],bl=img.data[i+2];
  const L=0.2126*r+0.7152*g+0.0722*bl, sat=Math.max(r,g,bl)-Math.min(r,g,bl);
  if(L>140&&sat<26)cand.push({x,y,r,g,b:bl,L:+L.toFixed(1)});
}
cand.sort((a,c)=>c.L-a.L);
const picked=[];
for(const c of cand) if(picked.every(p=>Math.hypot(p.x-c.x,p.y-c.y)>120)) picked.push(c);
const sel=picked.slice(0,12);
const named=await pg.evaluate((pts)=>pts.map(p=>({p,hit:window.__debug.pick(p.x,p.y,3)})), sel);
console.log(`pale-flat candidates in lower half: ${cand.length}`);
for(const {p,hit} of named){
  const what = hit.length? hit.map(h=>`${h.name||'(unnamed)'}<${h.material||'?'}>@${Math.round(h.dist)}`).join(' | ') : '(nothing)';
  console.log(`(${String(p.x).padStart(4)},${String(p.y).padStart(3)}) rgb ${p.r},${p.g},${p.b} L${p.L}  ${what}`);
}
await b.close(); srv.kill();
