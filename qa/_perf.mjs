/**
 * Where the frame time goes at street level.
 *
 * For each viewpoint: settle, measure a rolling-mean fps and the worst frame,
 * then hide one layer at a time and re-measure. The delta attributes frame time
 * to a module. Also dumps draw calls and triangles per layer so a module that
 * is cheap per call but has thousands of them is distinguishable from one that
 * is submitting ten million triangles.
 */
import { spawn } from 'node:child_process';
import puppeteer from 'puppeteer';
const PORT = 4553, ROOT = '/Volumes/Projects/bos';
const VIEWS = (process.argv[2] || 'high-street,downtown-traffic,comm-ave').split(',');
const TIER = process.argv[3] || 'high';
const LAYERS = process.argv[4]
  ? process.argv[4].split(',')
  : ['veg', 'tree', 'building', 'road', 'prop', 'traffic', 'transit', 'water', 'far-terrain', 'terrain', 'flag'];

const vp = JSON.parse((await import('node:fs')).readFileSync(`${ROOT}/qa/viewpoints.json`, 'utf8'));
const byName = new Map((Array.isArray(vp) ? vp : vp.viewpoints).map((v) => [v.id, v]));

const srv = spawn('npx', ['vite','preview','--port',String(PORT),'--strictPort','--outDir','dist-qa'],
  { cwd: ROOT, stdio: 'ignore', env: { ...process.env, VITE_BASE: '/' } });
for (let i=0;i<160;i++){ try{ if((await fetch(`http://localhost:${PORT}/`)).ok) break; }catch{} await new Promise(r=>setTimeout(r,250)); }
const b = await puppeteer.launch({ headless:true, protocolTimeout:900000,
  args:['--no-sandbox','--enable-gpu','--use-angle=metal','--enable-unsafe-swiftshader','--ignore-gpu-blocklist','--enable-webgl','--window-size=1280,720'] });
const pg = await b.newPage(); await pg.setViewport({ width:1280, height:720 });
await pg.evaluateOnNewDocument(()=>{try{localStorage.removeItem('bh-tier');localStorage.removeItem('bh-res');localStorage.setItem('bh-onboarded','1')}catch{}});
await pg.goto(`http://localhost:${PORT}/?q=${TIER}`,{waitUntil:'networkidle2',timeout:180000});
await pg.waitForFunction('window.__ready === true',{timeout:300000});
await new Promise(r=>setTimeout(r,8000));

/** Mean fps over `ms`, measured from the app's own rolling window. */
const sample = async (ms=2600) => {
  await pg.evaluate(()=>window.__debug.settle(70));
  await new Promise(r=>setTimeout(r,ms));
  return pg.evaluate(()=>{
    const s = window.__boston.ctx.stats, r = window.__boston.ctx.renderer.info.render;
    return { fps: s.fps, low: s['fps.low'], calls: r.calls, tris: r.triangles };
  });
};

for (const name of VIEWS) {
  const v = byName.get(name);
  if (!v) { console.log(`?? ${name}`); continue; }
  await pg.evaluate((h)=>window.__debug.setTime(h), v.hour ?? 13);
  await pg.evaluate((p,t)=>window.__debug.setView(p,t), v.pos, v.target);
  await new Promise(r=>setTimeout(r,5000));
  const base = await sample();
  console.log(`\n== ${name} (${TIER})  fps ${base.fps} low ${base.low}  calls ${base.calls}  tris ${(base.tris/1e6).toFixed(2)}M`);
  for (const layer of LAYERS) {
    const n = await pg.evaluate((m)=>window.__debug.toggle(m,false), layer);
    if (!n) { await pg.evaluate((m)=>window.__debug.toggle(m,true), layer); continue; }
    const off = await sample(2200);
    await pg.evaluate((m)=>window.__debug.toggle(m,true), layer);
    const dMs = 1000/base.fps - 1000/off.fps;
    console.log(`   -${layer.padEnd(12)} n=${String(n).padStart(5)}  fps ${String(off.fps).padStart(3)}`
      + `  dt ${dMs >= 0 ? '+' : ''}${dMs.toFixed(1)}ms`
      + `  calls ${String(base.calls-off.calls).padStart(5)}  tris ${((base.tris-off.tris)/1e6).toFixed(2)}M`);
  }
}
await b.close(); srv.kill();
