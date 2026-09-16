/** Every named mesh whose bounds fall near a world point, largest first. */
import { spawn } from 'node:child_process';
import puppeteer from 'puppeteer';
const PORT=Number(process.env.QA_PORT||4646), ROOT='/Volumes/Projects/bos';
const srv=spawn('npx',['vite','preview','--port',String(PORT),'--strictPort','--outDir',process.env.QA_OUTDIR??'dist-qa4'],
  {cwd:ROOT,stdio:'ignore',env:{...process.env,VITE_BASE:'/'}});
for(let i=0;i<160;i++){try{if((await fetch(`http://localhost:${PORT}/`)).ok)break;}catch{}await new Promise(r=>setTimeout(r,250));}
const b=await puppeteer.launch({headless:true,protocolTimeout:900000,
  args:['--no-sandbox','--enable-gpu','--use-angle=metal','--ignore-gpu-blocklist','--enable-webgl','--window-size=1280,720']});
const pg=await b.newPage(); await pg.setViewport({width:1280,height:720});
await pg.evaluateOnNewDocument(()=>{try{localStorage.setItem('bh-onboarded','1')}catch{}});
await pg.goto(`http://localhost:${PORT}/?q=ultra`,{waitUntil:'networkidle2',timeout:180000});
await pg.waitForFunction('window.__ready === true',{timeout:300000});
await pg.evaluate(()=>{window.__debug.setTime(13.5);window.__debug.setView([4550,260,-700],[4250,10,-200]);});
await pg.evaluate(()=>window.__debug.settle(60));
console.log(JSON.stringify(await pg.evaluate(()=>{
  const out=[]; const C=[4000,-500];
  window.__boston.ctx.scene.traverse((o)=>{
    if(!o.isMesh||!o.visible) return;
    const g=o.geometry; if(!g) return;
    if(!g.boundingSphere) g.computeBoundingSphere();
    const bs=g.boundingSphere; if(!bs) return;
    const c=bs.center.clone(); o.updateWorldMatrix(true,false); c.applyMatrix4(o.matrixWorld);
    const d=Math.hypot(c.x-C[0],c.z-C[1]);
    if(d<2500) out.push({name:o.name||'(unnamed)',mat:o.material?.name??'',r:Math.round(bs.radius),d:Math.round(d)});
  });
  return out.sort((a,b)=>b.r-a.r).slice(0,26);
}),null,0));
await b.close(); srv.kill();
