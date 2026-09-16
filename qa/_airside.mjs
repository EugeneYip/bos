/** The airfield with and without the airport's own pavement mesh. */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import puppeteer from 'puppeteer';
const PORT = Number(process.env.QA_PORT || 4641), ROOT = '/Volumes/Projects/bos';
const POSE = JSON.parse(process.env.POSE);
const srv = spawn('npx', ['vite','preview','--port',String(PORT),'--strictPort','--outDir',process.env.QA_OUTDIR ?? 'dist-qa4'],
  { cwd: ROOT, stdio: 'ignore', env: { ...process.env, VITE_BASE: '/' } });
for (let i=0;i<160;i++){ try{ if((await fetch(`http://localhost:${PORT}/`)).ok) break; }catch{} await new Promise(r=>setTimeout(r,250)); }
const b = await puppeteer.launch({ headless:true, protocolTimeout:900000,
  args:['--no-sandbox','--enable-gpu','--use-angle=metal','--ignore-gpu-blocklist','--enable-webgl','--window-size=1600,900'] });
const pg = await b.newPage(); await pg.setViewport({width:1600,height:900});
await pg.evaluateOnNewDocument(()=>{try{localStorage.setItem('bh-onboarded','1')}catch{}});
await pg.goto(`http://localhost:${PORT}/?q=ultra`,{waitUntil:'networkidle2',timeout:180000});
await pg.waitForFunction('window.__ready === true',{timeout:300000});
await pg.evaluate((v)=>{window.__debug.setTime(v.hour); window.__debug.setView(v.pos,v.target);}, POSE);
await pg.evaluate(()=>window.__debug.settle(60));
fs.writeFileSync(`${ROOT}/qa/shots/airside-on.png`, await pg.screenshot());
const HIDE = process.env.HIDE || 'airport:pavement';
const n = HIDE === 'TERRAIN'
  ? await pg.evaluate(()=>{window.__terrain.setVisible(false); return -1;})
  : await pg.evaluate((h)=>h.split(',').reduce((n,x)=>n+window.__debug.toggle(x, false),0), HIDE);
await pg.evaluate(()=>window.__debug.settle(40));
fs.writeFileSync(`${ROOT}/qa/shots/airside-off.png`, await pg.screenshot());
console.log('hid', n, 'pavement meshes');
await b.close(); srv.kill();
