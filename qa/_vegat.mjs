/** Shoot one viewpoint under several ?at= anti-tiling settings, one page load each. */
import { spawn } from 'node:child_process';
import { writeFile, readFile } from 'node:fs/promises';
import puppeteer from 'puppeteer';
const ROOT='/Volumes/Projects/bos', PORT=Number(process.env.QA_PORT||4449);
const OUT=process.env.QA_OUTDIR||'dist-p', TIER=process.env.TIER||'high';
const VP=process.env.VP||'common-street';
const ARMS=(process.env.ATS||'base,soft,nonorm,nohex,big').split(',');
const vps=JSON.parse(await readFile(`${ROOT}/qa/viewpoints.json`,'utf8'));
const vp=vps.find(v=>v.id===VP);
const srv=spawn('npx',['vite','preview','--port',String(PORT),'--strictPort','--outDir',OUT],
  {cwd:ROOT,stdio:'ignore',env:{...process.env,VITE_BASE:'/'}});
for(let i=0;i<200;i++){try{if((await fetch(`http://localhost:${PORT}/`)).ok)break;}catch{}await new Promise(r=>setTimeout(r,250));}
const b=await puppeteer.launch({headless:true,protocolTimeout:900000,
  args:['--no-sandbox','--enable-gpu','--use-angle=metal','--ignore-gpu-blocklist','--enable-webgl','--window-size=1600,900','--hide-scrollbars']});
for (const arm of ARMS) {
  const pg=await b.newPage(); await pg.setViewport({width:1600,height:900,deviceScaleFactor:1});
  await pg.evaluateOnNewDocument(()=>{try{localStorage.setItem('bh-onboarded','1');localStorage.removeItem('bh-res')}catch{}});
  await pg.goto(`http://localhost:${PORT}/?q=${TIER}&at=${arm}`,{waitUntil:'networkidle2',timeout:180000});
  await pg.waitForFunction('window.__ready === true',{timeout:300000});
  await pg.evaluate((h)=>window.__debug.setTime(h), vp.hour);
  await pg.evaluate((p,t)=>window.__debug.setView(p,t), vp.pos, vp.target);
  await new Promise(r=>setTimeout(r,8000));
  await pg.evaluate(()=>window.__debug.settle(90));
  await writeFile(`${ROOT}/qa/shots/${VP}--at-${arm}.png`, await pg.screenshot({type:'png'}));
  console.log('[arm]', arm);
  await pg.close();
}
await b.close(); srv.kill();
