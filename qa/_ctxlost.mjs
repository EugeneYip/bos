/** Force a WebGL context loss and check the app explains itself. */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import puppeteer from 'puppeteer';
const ROOT='/Volumes/Projects/bos', PORT=Number(process.env.QA_PORT||4390);
const srv=spawn('npx',['vite','preview','--port',String(PORT),'--strictPort','--outDir',process.env.QA_OUTDIR??'dist-final'],
  {cwd:ROOT,stdio:'ignore',env:{...process.env,VITE_BASE:'/'}});
for(let i=0;i<160;i++){try{if((await fetch(`http://localhost:${PORT}/`)).ok)break;}catch{}await new Promise(r=>setTimeout(r,250));}
const b=await puppeteer.launch({headless:true,protocolTimeout:900000,
  args:['--no-sandbox','--enable-gpu','--use-angle=metal','--ignore-gpu-blocklist','--enable-webgl','--window-size=1280,720']});
const pg=await b.newPage(); await pg.setViewport({width:1280,height:720});
await pg.evaluateOnNewDocument(()=>{try{localStorage.setItem('bh-onboarded','1')}catch{}});
await pg.goto(`http://localhost:${PORT}/?q=medium`,{waitUntil:'networkidle2',timeout:180000});
await pg.waitForFunction('window.__ready === true',{timeout:300000});
await pg.evaluate(()=>window.__debug.settle(30));
console.log('before:', await pg.evaluate(()=>!!document.getElementById('lostctx')));
await pg.evaluate(()=>{
  const gl=window.__boston.ctx.renderer.getContext();
  gl.getExtension('WEBGL_lose_context').loseContext();
});
await new Promise(r=>setTimeout(r,2500));
const res=await pg.evaluate(()=>{
  const p=document.getElementById('lostctx');
  return { shown: !!p, text: p ? p.textContent.slice(0,140) : null,
           links: p ? [...p.querySelectorAll('a')].map(a=>a.textContent) : [],
           running: window.__boston.lost };
});
console.log('after :', JSON.stringify(res));
fs.writeFileSync(`${ROOT}/qa/shots/ctxlost.png`, await pg.screenshot());
await b.close(); srv.kill();
