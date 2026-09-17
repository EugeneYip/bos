/** GPU-side footprint: render targets, textures, and the drawing buffer. */
import { spawn } from 'node:child_process';
import puppeteer from 'puppeteer';
const ROOT='/Volumes/Projects/bos', PORT=Number(process.env.QA_PORT||4400);
const UA = process.env.MOBILE_UA ? 'Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1' : null;
const W=Number(process.env.W||1180), H=Number(process.env.H||820), DPR=Number(process.env.DPR||2);
const srv=spawn('npx',['vite','preview','--port',String(PORT),'--strictPort','--outDir',process.env.QA_OUTDIR??'dist-final'],
  {cwd:ROOT,stdio:'ignore',env:{...process.env,VITE_BASE:'/'}});
for(let i=0;i<160;i++){try{if((await fetch(`http://localhost:${PORT}/`)).ok)break;}catch{}await new Promise(r=>setTimeout(r,250));}
const b=await puppeteer.launch({headless:true,protocolTimeout:900000,
  args:['--no-sandbox','--enable-gpu','--use-angle=metal','--ignore-gpu-blocklist','--enable-webgl',`--window-size=${W},${H}`]});
const pg=await b.newPage();
await pg.setViewport({width:W,height:H,deviceScaleFactor:DPR});
if(UA) await pg.setUserAgent(UA);
await pg.evaluateOnNewDocument(()=>{try{localStorage.setItem('bh-onboarded','1')}catch{}});
await pg.goto(`http://localhost:${PORT}/${process.env.Q?`?q=${process.env.Q}`:''}`,{waitUntil:'networkidle2',timeout:180000});
await pg.waitForFunction('window.__ready === true',{timeout:300000});
await pg.evaluate(()=>window.__debug.settle(240));
console.log(JSON.stringify(await pg.evaluate(()=>{
  const app=window.__boston, r=app.ctx.renderer, gl=r.getContext();
  const bytesFor=(t)=>{
    const tex=t.texture; if(!tex) return 0;
    const ch = tex.format===1023?4:tex.format===1028?1:4;
    const bpc = (tex.type===1016||tex.type===1017)?2:(tex.type===1015?4:1);
    let n = t.width*t.height*ch*bpc*(t.depthBuffer?1:1);
    if (t.depthTexture) n += t.width*t.height*4;
    else if (t.depthBuffer) n += t.width*t.height*4;
    return n;
  };
  const seen=new Set(); let rtBytes=0; const list=[];
  const walk=(o,d)=>{ if(!o||d>3||typeof o!=='object'||seen.has(o))return; seen.add(o);
    if(o.isWebGLRenderTarget){ const n=bytesFor(o); rtBytes+=n;
      list.push(`${o.texture?.name||'?'} ${o.width}x${o.height}=${(n/1048576).toFixed(1)}MB`); return; }
    if(Array.isArray(o)){ for(const v of o) walk(v,d+1); return; }
    for(const k in o){ try{ walk(o[k],d+1); }catch(e){} } };
  for(const m of app.modules) walk(m,0);
  list.sort();
  const s=window.__debug.stats();
  return { tier:s.tier, dpr:r.getPixelRatio(),
    drawingBuffer:[gl.drawingBufferWidth, gl.drawingBufferHeight],
    renderTargetMB:+(rtBytes/1048576).toFixed(0), targets:list.length,
    rendererTextures:r.info.memory.textures, rendererGeometries:r.info.memory.geometries,
    top:list.slice(0,14) };
})));
await b.close(); srv.kill();
