/** Terrain height and water distance at given world coordinates. */
import { spawn } from 'node:child_process';
import puppeteer from 'puppeteer';
const PORT = 4616, ROOT = '/Volumes/Projects/bos';
const PTS = JSON.parse(process.env.XZ);
const srv = spawn('npx',['vite','preview','--port',String(PORT),'--strictPort','--outDir','dist-qa'],
  {cwd:ROOT,stdio:'ignore',env:{...process.env,VITE_BASE:'/'}});
for(let i=0;i<160;i++){try{if((await fetch(`http://localhost:${PORT}/`)).ok)break;}catch{}await new Promise(r=>setTimeout(r,250));}
const b=await puppeteer.launch({headless:true,protocolTimeout:900000,
  args:['--no-sandbox','--enable-gpu','--use-angle=metal','--enable-unsafe-swiftshader','--ignore-gpu-blocklist','--enable-webgl','--window-size=800,600']});
const pg=await b.newPage();
await pg.evaluateOnNewDocument(()=>{try{localStorage.removeItem('bh-tier');localStorage.setItem('bh-onboarded','1')}catch{}});
await pg.goto(`http://localhost:${PORT}/?q=medium`,{waitUntil:'networkidle2',timeout:180000});
await pg.waitForFunction('window.__ready === true',{timeout:300000});
await new Promise(r=>setTimeout(r,4000));
const out = await pg.evaluate((pts) => {
  const c = window.__boston.ctx;
  return pts.map(([x, z, label]) => ({
    label, x, z,
    height: c.sampleHeight ? +(c.sampleHeight(x, z) ?? NaN).toFixed(2) : null,
    waterDist: c.waterDistAt ? +c.waterDistAt(x, z).toFixed(2) : null,
  }));
}, PTS);
for (const r of out) {
  console.log(`${String(r.label).padEnd(26)} (${r.x},${r.z})  terrain y ${String(r.height).padStart(7)}  `
    + `waterDist ${String(r.waterDist).padStart(8)} ${r.waterDist > 0 ? '(WATER)' : '(land)'}`);
}
// And where the Constitution's own group actually sits.
console.log(JSON.stringify(await pg.evaluate(() => {
  const out = [];
  window.__boston.ctx.scene.traverse((o) => {
    if (!(o.name || '').includes('constitution')) return;
    o.updateWorldMatrix(true, false);
    const p = new (o.position.constructor)();
    p.setFromMatrixPosition(o.matrixWorld);
    out.push({ name: o.name, worldY: +p.y.toFixed(2), x: +p.x.toFixed(0), z: +p.z.toFixed(0),
      localY: +o.position.y.toFixed(2) });
  });
  return out.slice(0, 8);
}), null, 1));
await b.close(); srv.kill();
