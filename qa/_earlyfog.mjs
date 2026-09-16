import { spawn } from 'node:child_process';
import puppeteer from 'puppeteer';
const PORT=4534;
const srv=spawn('npx',['vite','preview','--port',String(PORT),'--strictPort','--outDir','dist-qa'],{cwd:'/Volumes/Projects/bos',stdio:'ignore',env:{...process.env,VITE_BASE:'/'}});
for(let i=0;i<160;i++){try{if((await fetch(`http://localhost:${PORT}/`)).ok)break;}catch{}await new Promise(r=>setTimeout(r,250));}
const b=await puppeteer.launch({headless:true,protocolTimeout:900000,args:['--no-sandbox','--enable-gpu','--use-angle=metal','--enable-unsafe-swiftshader','--ignore-gpu-blocklist','--enable-webgl','--window-size=1280,720']});
const pg=await b.newPage(); await pg.setViewport({width:1280,height:720});
await pg.evaluateOnNewDocument(()=>{try{localStorage.removeItem('bh-tier');localStorage.removeItem('bh-res');localStorage.setItem('bh-onboarded','1')}catch{}});
const { PNG } = await import('pngjs');
const fsp = await import('node:fs');
await pg.goto(`http://localhost:${PORT}/?q=high`,{waitUntil:'networkidle2',timeout:180000});
await pg.waitForFunction('window.__ready === true',{timeout:300000});
// Capture from the instant the loading screen lets go, without settling.
const t0=Date.now();
for (const at of [0,700,1600,3200,6400,12000,20000]) {
  while (Date.now()-t0 < at) await new Promise(r=>setTimeout(r,50));
  const buf = await pg.screenshot();
  const p = PNG.sync.read(buf);
  const L=(i)=>0.2126*p.data[i]+0.7152*p.data[i+1]+0.0722*p.data[i+2];
  let s=0,n=0,mean=0;
  for(let y=200;y<620;y+=2)for(let x=200;x<1080;x+=2){const i=(y*p.width+x)*4;
    s+=Math.abs(L(i)-L(i+4))+Math.abs(L(i)-L(i+p.width*4)); mean+=L(i); n++;}
  const st=await pg.evaluate(()=>({env:!!window.__boston.ctx.envMap,
    tiles:window.__boston.ctx.stats.buildingTilesVisible,
    chunks:window.__boston.ctx.stats.terrainChunks,
    veg:window.__boston.ctx.stats['veg.mid'], exp:+window.__boston.ctx.exposure.toFixed(2)}));
  fsp.writeFileSync(`/Volumes/Projects/bos/qa/shots/early-${at}.png`, buf);
  console.log(String(at).padStart(6)+'ms  contrast '+(s/n).toFixed(2)+'  luma '+(mean/n).toFixed(1)
    +'  env '+st.env+'  tiles '+st.tiles+'  terrainChunks '+st.chunks+'  vegMid '+st.veg+'  exp '+st.exp);
}
await b.close(); srv.kill();
