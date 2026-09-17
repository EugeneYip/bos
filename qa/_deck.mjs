/**
 * Pale-deck probe.
 *
 * Measures the pier decks and the unclaimed ground beside them as a RATIO to
 * the frame's own sky, because auto-exposure moves under any albedo change
 * and absolute luma is not comparable between builds.
 */
import { spawn } from 'node:child_process';
import { PNG } from 'pngjs';
import puppeteer from 'puppeteer';
const ROOT='/Volumes/Projects/bos', PORT=Number(process.env.QA_PORT||4407);
const W=1600,H=900;
const srv=spawn('npx',['vite','preview','--port',String(PORT),'--strictPort','--outDir',process.env.QA_OUTDIR??'dist-final'],
  {cwd:ROOT,stdio:'ignore',env:{...process.env,VITE_BASE:'/'}});
for(let i=0;i<160;i++){try{if((await fetch(`http://localhost:${PORT}/`)).ok)break;}catch{}await new Promise(r=>setTimeout(r,250));}
const b=await puppeteer.launch({headless:true,protocolTimeout:900000,
  args:['--no-sandbox','--enable-gpu','--use-angle=metal','--ignore-gpu-blocklist','--enable-webgl',`--window-size=${W},${H}`]});
const pg=await b.newPage(); await pg.setViewport({width:W,height:H,deviceScaleFactor:1});
await pg.evaluateOnNewDocument(()=>{try{localStorage.setItem('bh-onboarded','1')}catch{}});
await pg.goto(`http://localhost:${PORT}/?q=high`,{waitUntil:'networkidle2',timeout:180000});
await pg.waitForFunction('window.__ready === true',{timeout:300000});

const POSES = [
  ['fan-pier',  [1350, 220, 700], [1850, 0, 120]],
  ['eastie',    [1750, 320, -260], [2400, 0, -950]],
  ['logan',     [4550, 260, -700], [4250, 10, -200]],
];
const band = (img,x0,y0,x1,y1)=>{ let s=0,n=0,hi=0;
  for(let y=y0;y<y1;y++)for(let x=x0;x<x1;x++){const i=(y*img.width+x)*4;
    const L=0.2126*img.data[i]+0.7152*img.data[i+1]+0.0722*img.data[i+2]; s+=L;n++; if(L>150)hi++;}
  return {mean:+(s/n).toFixed(1), over150:+(hi/n*100).toFixed(2)}; };

for (const [name,pos,tgt] of POSES) {
  await pg.evaluate((p,t)=>{window.__debug.setTime(13.0); window.__debug.setView(p,t);}, pos, tgt);
  await pg.evaluate(()=>window.__debug.settle(70));
  const img = PNG.sync.read(Buffer.from(await pg.screenshot({encoding:'binary'})));
  const sky = band(img, 200, 40, 1400, 150);
  const gnd = band(img, 200, 480, 1400, 860);
  const expo = await pg.evaluate(()=>window.__debug.probe().exposure ?? 0);
  console.log(`${name.padEnd(10)} ground ${String(gnd.mean).padStart(5)}  sky ${String(sky.mean).padStart(5)}  `
    + `ratio ${(gnd.mean/sky.mean).toFixed(3)}  ground>150 ${String(gnd.over150).padStart(5)}%  expo ${expo}`);
}
await b.close(); srv.kill();
