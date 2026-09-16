/** The gate's decision at every viewpoint, against the true water coverage. */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import puppeteer from 'puppeteer';
import { PNG } from 'pngjs';
const PORT = 4570, ROOT = '/Volumes/Projects/bos';
const vp = Object.values(JSON.parse(fs.readFileSync(`${ROOT}/qa/viewpoints.json`, 'utf8')));
const srv = spawn('npx',['vite','preview','--port',String(PORT),'--strictPort','--outDir','dist-qa'],
  {cwd:ROOT,stdio:'ignore',env:{...process.env,VITE_BASE:'/'}});
for(let i=0;i<160;i++){try{if((await fetch(`http://localhost:${PORT}/`)).ok)break;}catch{}await new Promise(r=>setTimeout(r,250));}
const b=await puppeteer.launch({headless:true,protocolTimeout:900000,
  args:['--no-sandbox','--enable-gpu','--use-angle=metal','--enable-unsafe-swiftshader','--ignore-gpu-blocklist','--enable-webgl','--window-size=1280,720']});
const pg=await b.newPage(); await pg.setViewport({width:1280,height:720});
await pg.evaluateOnNewDocument(()=>{try{localStorage.removeItem('bh-tier');localStorage.removeItem('bh-res');localStorage.setItem('bh-onboarded','1')}catch{}});
await pg.goto(`http://localhost:${PORT}/?q=high`,{waitUntil:'networkidle2',timeout:180000});
await pg.waitForFunction('window.__ready === true',{timeout:300000});
await new Promise(r=>setTimeout(r,10000));
let bad = 0;
for (const v of vp) {
  await pg.evaluate((h)=>window.__debug.setTime(h), v.hour ?? 13);
  await pg.evaluate((p,t)=>window.__debug.setView(p,t), v.pos, v.target);
  await new Promise(r=>setTimeout(r,2600));
  await pg.evaluate(()=>window.__debug.settle(60));
  const st = await pg.evaluate(()=>({ cover: window.__boston.ctx.stats['water.cover'],
    reflect: window.__boston.ctx.stats['water.reflect'],
    seen: window.__boston.ctx.stats['water.seen'] }));
  // True coverage, from the depth-correct thing: count pixels the water owns
  // by reading them before and after flooding is too slow here, so use the
  // gate's own decision against a magenta flood only where it says skip.
  let truth = '';
  if (st.reflect === 0) {
    const shot = PNG.sync.read(await pg.screenshot());
    await pg.evaluate(() => {
      window.__boston.ctx.scene.traverse((o) => {
        if ((o.name || '').includes('water') && o.material?.isShaderMaterial) {
          o.material.__save = o.material.fragmentShader;
          o.material.fragmentShader = 'void main(){gl_FragColor=vec4(1.,0.,1.,1.);}';
          o.material.needsUpdate = true;
        }
      });
    });
    await pg.evaluate(()=>window.__debug.settle(40));
    const flood = PNG.sync.read(await pg.screenshot());
    await pg.evaluate(() => {
      window.__boston.ctx.scene.traverse((o) => {
        if (o.material?.__save) {
          o.material.fragmentShader = o.material.__save;
          o.material.__save = undefined; o.material.needsUpdate = true;
        }
      });
    });
    let hits = 0, tot = 0;
    for (let y = 0; y < flood.height; y += 2) for (let x = 0; x < flood.width; x += 2) {
      const i = (y * flood.width + x) * 4; tot++;
      if (flood.data[i] > 110 && flood.data[i+2] > 110 && flood.data[i+1] < flood.data[i] * 0.6) hits++;
    }
    void shot;
    const pct = 100 * hits / tot;
    truth = `   TRUE water ${pct.toFixed(2)}%`;
    if (pct > 0.25) { truth += '  <-- SKIPPED WITH WATER ON SCREEN'; bad++; }
  }
  console.log(`${String(v.id).padEnd(18)} cover ${String(st.cover).padStart(5)}%  seen ${st.seen}`
    + `  reflect ${st.reflect}${truth}`);
}
console.log(`\nviewpoints where the gate skipped with water visible: ${bad}`);
await b.close(); srv.kill();
