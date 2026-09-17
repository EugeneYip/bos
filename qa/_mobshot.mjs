import { spawn } from 'node:child_process';
import fs from 'node:fs';
import puppeteer from 'puppeteer';
const ROOT='/Volumes/Projects/bos', PORT=Number(process.env.QA_PORT||4395);
const UA='Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';
const srv=spawn('npx',['vite','preview','--port',String(PORT),'--strictPort','--outDir',process.env.QA_OUTDIR??'dist-final'],
  {cwd:ROOT,stdio:'ignore',env:{...process.env,VITE_BASE:'/'}});
for(let i=0;i<160;i++){try{if((await fetch(`http://localhost:${PORT}/`)).ok)break;}catch{}await new Promise(r=>setTimeout(r,250));}
const b=await puppeteer.launch({headless:true,protocolTimeout:900000,
  args:['--no-sandbox','--enable-gpu','--use-angle=metal','--ignore-gpu-blocklist','--enable-webgl','--window-size=1180,820']});
const pg=await b.newPage(); await pg.setViewport({width:1180,height:820}); await pg.setUserAgent(UA);
await pg.evaluateOnNewDocument(()=>{try{localStorage.setItem('bh-onboarded','1')}catch{}});
await pg.goto(`http://localhost:${PORT}/`,{waitUntil:'networkidle2',timeout:180000});
await pg.waitForFunction('window.__ready === true',{timeout:300000});
await pg.evaluate(()=>window.__debug.settle(120));
fs.writeFileSync(`${ROOT}/qa/shots/mobile-boot.png`, await pg.screenshot());
const s=await pg.evaluate(()=>window.__debug.stats());
console.log(JSON.stringify({tier:s.tier,tiles:s.buildingTiles,shards:s.buildingShards,fps:s.fps,tris:s.tris}));
await b.close(); srv.kill();
