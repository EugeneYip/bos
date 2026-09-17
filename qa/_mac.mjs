/**
 * The MacBook-Safari-at-native case: Retina DPR 2, Resolution pinned to
 * native, quality tier from the probe. Reports whether MOBILE is wrongly on,
 * the safe level, the drawing buffer, render-target memory and peak heap.
 */
import { spawn } from 'node:child_process';
import puppeteer from 'puppeteer';
const ROOT='/Volumes/Projects/bos', PORT=Number(process.env.QA_PORT||4460);
const W=Number(process.env.W||1512), H=Number(process.env.H||945), DPR=Number(process.env.DPR||2);
const srv=spawn('npx',['vite','preview','--port',String(PORT),'--strictPort','--outDir',process.env.QA_OUTDIR??'dist-mac'],
  {cwd:ROOT,stdio:'ignore',env:{...process.env,VITE_BASE:'/'}});
for(let i=0;i<160;i++){try{if((await fetch(`http://localhost:${PORT}/`)).ok)break;}catch{}await new Promise(r=>setTimeout(r,250));}
const b=await puppeteer.launch({headless:true,protocolTimeout:900000,
  args:['--no-sandbox','--enable-gpu','--use-angle=metal','--ignore-gpu-blocklist','--enable-webgl',`--window-size=${W},${H}`]});
const pg=await b.newPage(); await pg.setViewport({width:W,height:H,deviceScaleFactor:DPR});
await pg.evaluateOnNewDocument((res)=>{
  try{ localStorage.setItem('bh-onboarded','1'); if(res) localStorage.setItem('bh-res',res); }catch{}
  window.__peak=0; setInterval(()=>{const m=performance.memory?.usedJSHeapSize||0; if(m>window.__peak) window.__peak=m;},200);
}, process.env.QA_RES ?? '');
await pg.goto(`http://localhost:${PORT}/`,{waitUntil:'networkidle2',timeout:180000});
await pg.waitForFunction('window.__ready === true',{timeout:300000});
await pg.evaluate(()=>window.__debug.settle(300));
const cdp=await pg.target().createCDPSession();
await cdp.send('HeapProfiler.enable'); await cdp.send('HeapProfiler.collectGarbage');
await new Promise(r=>setTimeout(r,1200));
console.log(JSON.stringify(await pg.evaluate(()=>{
  const d=window.__debug.diag(), s=window.__debug.stats(), r=window.__boston.ctx.renderer;
  const gl=r.getContext();
  const seen=new Set(); let rt=0;
  const walk=(o,k)=>{ if(!o||k>3||typeof o!=='object'||seen.has(o))return; seen.add(o);
    if(o.isWebGLRenderTarget){ const t=o.texture; const bpc=(t&&(t.type===1016||t.type===1017))?2:(t&&t.type===1015?4:1);
      rt += o.width*o.height*4*bpc + (o.depthTexture||o.depthBuffer ? o.width*o.height*4 : 0); return; }
    if(Array.isArray(o)){for(const v of o) walk(v,k+1); return;}
    for(const p in o){try{walk(o[p],k+1);}catch(e){}} };
  for(const m of window.__boston.modules) walk(m,0);
  return { mobile:d.mobile, safeLevel:d.safeLevel, tier:d.tier,
           pixelRatio:d.pixelRatio, devicePixelRatio:d.devicePixelRatio,
           drawingBuffer:[gl.drawingBufferWidth,gl.drawingBufferHeight],
           renderTargetMB:+(rt/1048576).toFixed(0),
           peakMB:Math.round(window.__peak/1048576),
           settledMB:Math.round(performance.memory.usedJSHeapSize/1048576),
           fps:s.fps, tris:s.tris, calls:s.calls };
})));
await b.close(); srv.kill();
