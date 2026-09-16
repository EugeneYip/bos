/** Every mesh with castShadow, grouped, so the nonsense ones are visible. */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import puppeteer from 'puppeteer';
const PORT = 4557, ROOT = '/Volumes/Projects/bos';
const vp = JSON.parse(fs.readFileSync(`${ROOT}/qa/viewpoints.json`, 'utf8'));
const v = Object.values(vp).find((x) => x.id === (process.argv[2] || 'high-street'));
const srv = spawn('npx',['vite','preview','--port',String(PORT),'--strictPort','--outDir','dist-qa'],
  {cwd:ROOT,stdio:'ignore',env:{...process.env,VITE_BASE:'/'}});
for(let i=0;i<160;i++){try{if((await fetch(`http://localhost:${PORT}/`)).ok)break;}catch{}await new Promise(r=>setTimeout(r,250));}
const b=await puppeteer.launch({headless:true,protocolTimeout:900000,
  args:['--no-sandbox','--enable-gpu','--use-angle=metal','--enable-unsafe-swiftshader','--ignore-gpu-blocklist','--enable-webgl','--window-size=1280,720']});
const pg=await b.newPage(); await pg.setViewport({width:1280,height:720});
await pg.evaluateOnNewDocument(()=>{try{localStorage.removeItem('bh-tier');localStorage.removeItem('bh-res');localStorage.setItem('bh-onboarded','1')}catch{}});
await pg.goto(`http://localhost:${PORT}/?q=high`,{waitUntil:'networkidle2',timeout:180000});
await pg.waitForFunction('window.__ready === true',{timeout:300000});
await new Promise(r=>setTimeout(r,9000));
await pg.evaluate((h)=>window.__debug.setTime(h), v.hour ?? 13);
await pg.evaluate((p,t)=>window.__debug.setView(p,t), v.pos, v.target);
await new Promise(r=>setTimeout(r,9000));

const rep = await pg.evaluate(() => {
  const { scene } = window.__boston.ctx;
  const g = new Map();
  let cast = 0, total = 0, castTris = 0;
  scene.traverse((o) => {
    if (!o.isMesh && !o.isInstancedMesh) return;
    let vis = true; for (let p = o; p; p = p.parent) if (!p.visible) vis = false;
    if (!vis) return;
    total++;
    if (!o.castShadow) return;
    cast++;
    const geo = o.geometry;
    const idx = geo?.index ? geo.index.count : (geo?.attributes.position?.count ?? 0);
    const tris = (idx / 3) * (o.isInstancedMesh ? o.count : 1);
    castTris += tris;
    let key = o.name || '';
    if (!key) for (let p = o.parent; p; p = p.parent) if (p.name) { key = p.name + ' (child)'; break; }
    key = key.split(':').slice(0, 2).join(':') || '(unnamed)';
    const e = g.get(key) || { n: 0, tris: 0 };
    e.n++; e.tris += tris; g.set(key, e);
  });
  const cs = window.__boston.ctx.stats['sky.cascades'];
  return { cast, total, castTris, cascades: cs,
    groups: [...g].sort((a, bb) => bb[1].n - a[1].n).slice(0, 26) };
});
console.log(`casters ${rep.cast} of ${rep.total} visible meshes, ${(rep.castTris/1e6).toFixed(2)}M tris, cascades ${rep.cascades}`);
for (const [k, e] of rep.groups) {
  console.log(`  ${String(e.n).padStart(4)}  ${k.padEnd(30)} ${(e.tris/1e6).toFixed(3)}M tris`);
}
await b.close(); srv.kill();
