/** Which layer is producing the sub-pixel sparkle at ultra? */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { PNG } from 'pngjs';
import puppeteer from 'puppeteer';
const ROOT='/Volumes/Projects/bos', PORT=Number(process.env.QA_PORT||4417);
const srv=spawn('npx',['vite','preview','--port',String(PORT),'--strictPort','--outDir',process.env.QA_OUTDIR??'dist-reg'],
  {cwd:ROOT,stdio:'ignore',env:{...process.env,VITE_BASE:'/'}});
for(let i=0;i<160;i++){try{if((await fetch(`http://localhost:${PORT}/`)).ok)break;}catch{}await new Promise(r=>setTimeout(r,250));}
const b=await puppeteer.launch({headless:true,protocolTimeout:900000,
  args:['--no-sandbox','--enable-gpu','--use-angle=metal','--ignore-gpu-blocklist','--enable-webgl','--window-size=1600,900']});
const pg=await b.newPage(); await pg.setViewport({width:1600,height:900});
await pg.evaluateOnNewDocument(()=>{try{localStorage.setItem('bh-onboarded','1')}catch{}});
await pg.goto(`http://localhost:${PORT}/?q=ultra`,{waitUntil:'networkidle2',timeout:180000});
await pg.waitForFunction('window.__ready === true',{timeout:300000});
await pg.evaluate(()=>{window.__debug.setTime(11.0); window.__debug.setView([-900,2400,2600],[-200,0,-400]);});
const sparkle=async(l)=>{
  await pg.evaluate(()=>window.__debug.settle(70));
  const a=PNG.sync.read(Buffer.from(await pg.screenshot({encoding:'binary'})));
  const W=a.width,H=a.height; const L=(x,y)=>{const i=(y*W+x)*4;return 0.2126*a.data[i]+0.7152*a.data[i+1]+0.0722*a.data[i+2];};
  let hit=0,n=0;
  for(let y=1;y<H-1;y++)for(let x=1;x<W-1;x++){const c=L(x,y);
    const m=(L(x-1,y)+L(x+1,y)+L(x,y-1)+L(x,y+1)+L(x-1,y-1)+L(x+1,y-1)+L(x-1,y+1)+L(x+1,y+1))/8;
    n++; if(c-m>40) hit++;}
  console.log(l.padEnd(26), (hit/n*100).toFixed(3)+'%');
};
await sparkle('all on');
for (const name of ['buildings:clutter','trees:','props:','roads','water','buildings:']) {
  const k=await pg.evaluate((n)=>window.__debug.toggle(n,false), name);
  await sparkle(`hide ${name} (${k})`);
  await pg.evaluate((n)=>window.__debug.toggle(n,true), name);
}
await b.close(); srv.kill();
