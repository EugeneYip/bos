/**
 * Sweep the building shell's environment specular in one page load, and prove
 * each step took effect before trusting the frame.
 *
 * With albedo driven to hex(8,8,8) the roofs still render at luma 100-118, so
 * the brightness is specular, not diffuse. Aerial perspective (128 materials,
 * verified uniform readback), fog (3.5% at 2.7 km) and the glass-mirror
 * roughness path (2 luma) are all ruled out. What is left is a dielectric's
 * grazing sky reflection: an aerial camera meets a flat roof at about 78
 * degrees from its normal, where Schlick returns roughly a third of the sky.
 */
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import puppeteer from 'puppeteer';
import { PNG } from 'pngjs';
const ROOT='/Volumes/Projects/bos', PORT=Number(process.env.QA_PORT||4498), OUT=process.env.LOCAL||'dist-fix';
const W=1600,H=900;
const views=JSON.parse(fs.readFileSync(`${ROOT}/qa/viewpoints.json`,'utf8'));
const v=(Array.isArray(views)?views:views.viewpoints).find(z=>z.id==='boot-default');
const srv=spawn('npx',['vite','preview','--port',String(PORT),'--strictPort','--outDir',OUT],
  {cwd:ROOT,stdio:'ignore',env:{...process.env,VITE_BASE:'/'}});
for(let i=0;i<160;i++){try{if((await fetch(`http://localhost:${PORT}/`)).ok)break;}catch{}await new Promise(r=>setTimeout(r,250));}
const b=await puppeteer.launch({headless:true,protocolTimeout:900000,
  args:['--no-sandbox','--enable-gpu','--use-angle=metal','--ignore-gpu-blocklist','--enable-webgl']});
const pg=await b.newPage(); await pg.setViewport({width:W,height:H,deviceScaleFactor:2});
await pg.evaluateOnNewDocument(()=>{try{localStorage.setItem('bh-onboarded','1')}catch{}});
await pg.goto(`http://localhost:${PORT}/`,{waitUntil:'domcontentloaded',timeout:120000});
await pg.waitForFunction('window.__ready === true',{timeout:300000,polling:500});
await pg.evaluate((p)=>{window.__debug.setTime(p.hour); window.__debug.setView(p.pos,p.target);}, v);
await pg.evaluate(()=>window.__debug.settle(160));

const stat = (buf) => {
  const img = PNG.sync.read(buf);
  let n=0,s=0,bright=0;
  for (let y=Math.floor(img.height*0.50); y<img.height-160; y+=3)
    for (let x=8; x<img.width-8; x+=3) {
      const i=(y*img.width+x)*4, r=img.data[i], g=img.data[i+1], bl=img.data[i+2];
      const L=0.2126*r+0.7152*g+0.0722*bl, sat=Math.max(r,g,bl)-Math.min(r,g,bl);
      n++; s+=L; if (L>140 && sat<26) bright++;
    }
  return { mean:+(s/n).toFixed(1), brightPct:+(100*bright/n).toFixed(2) };
};

for (const e of [1.0, 0.6, 0.35, 0.15]) {
  const applied = await pg.evaluate((val) => {
    let n=0; const seen=new Set();
    window.__boston.ctx.scene.traverse(o=>{
      const ms = Array.isArray(o.material)?o.material:(o.material?[o.material]:[]);
      for (const m of ms) if (m.name === 'BuildingShell' && !seen.has(m)) {
        seen.add(m); m.envMapIntensity = val; m.needsUpdate = true; n++;
      }
    });
    // Read back, so a frame is never reported against a value that did not land.
    let got = null; const s2=new Set();
    window.__boston.ctx.scene.traverse(o=>{
      const ms = Array.isArray(o.material)?o.material:(o.material?[o.material]:[]);
      for (const m of ms) if (m.name === 'BuildingShell' && !s2.has(m)) { s2.add(m); got = m.envMapIntensity; }
    });
    return { patched:n, readback:got };
  }, e);
  if (applied.patched === 0 || Math.abs(applied.readback - e) > 1e-6) {
    console.log(`env ${e}: NOT APPLIED (patched=${applied.patched} readback=${applied.readback}) -- frame not reported`);
    continue;
  }
  await pg.evaluate(()=>window.__debug.settle(120));
  const buf = await pg.screenshot();
  fs.writeFileSync(`${ROOT}/qa/present/shots/env${e}--boot-default.png`, buf);
  const st = stat(buf);
  console.log(`env ${String(e).padEnd(4)} materials ${applied.patched}  lower-half mean ${st.mean}  bright-flat ${st.brightPct}%`);
}
await b.close(); srv.kill();
