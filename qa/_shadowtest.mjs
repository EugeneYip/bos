import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
import { PNG } from 'pngjs';
import puppeteer from 'puppeteer';
const ROOT='/Volumes/Projects/bos', PORT=Number(process.env.QA_PORT||4409);
const srv=spawn('npx',['vite','preview','--port',String(PORT),'--strictPort','--outDir',process.env.QA_OUTDIR??'dist-final'],
  {cwd:ROOT,stdio:'ignore',env:{...process.env,VITE_BASE:'/'}});
for(let i=0;i<160;i++){try{if((await fetch(`http://localhost:${PORT}/`)).ok)break;}catch{}await new Promise(r=>setTimeout(r,250));}
const b=await puppeteer.launch({headless:true,protocolTimeout:900000,
  args:['--no-sandbox','--enable-gpu','--use-angle=metal','--ignore-gpu-blocklist','--enable-webgl','--window-size=1600,900']});
const pg=await b.newPage(); await pg.setViewport({width:1600,height:900});
await pg.evaluateOnNewDocument(()=>{try{localStorage.setItem('bh-onboarded','1')}catch{}});
await pg.goto(`http://localhost:${PORT}/?q=high`,{waitUntil:'networkidle2',timeout:180000});
await pg.waitForFunction('window.__ready === true',{timeout:300000});
await pg.evaluate(()=>{window.__debug.setTime(13.0); window.__debug.setView([4550,260,-700],[4250,10,-200]);});
await pg.evaluate(()=>window.__debug.settle(70));
const at=(img,x,y,r=5)=>{let s=0,n=0;for(let dy=-r;dy<=r;dy++)for(let dx=-r;dx<=r;dx++){const i=((y+dy)*img.width+(x+dx))*4;s+=0.2126*img.data[i]+0.7152*img.data[i+1]+0.0722*img.data[i+2];n++;}return Math.round(s/n);};
const shot=async(l)=>{const buf=await pg.screenshot({encoding:'binary'});
  require('node:fs').writeFileSync(`${ROOT}/qa/shots/shadow-${l.replace(/\s+/g,'-')}.png`, buf);
  const img=PNG.sync.read(Buffer.from(buf));
  console.log(l.padEnd(16),'pale(1090,300)='+at(img,1090,300),' black(620,470)='+at(img,620,470),' pale(240,360)='+at(img,240,360));};
await shot('shadows on');
await pg.evaluate(()=>window.__debug.probe({shadows:false}));
await pg.evaluate(()=>window.__debug.settle(40));
await shot('shadows off');
await b.close(); srv.kill();
