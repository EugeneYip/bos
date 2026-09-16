/** What the airport meshes are actually made of. */
import { spawn } from 'node:child_process';
import puppeteer from 'puppeteer';
const PORT = 4581, ROOT = '/Volumes/Projects/bos';
const srv = spawn('npx',['vite','preview','--port',String(PORT),'--strictPort','--outDir','dist-qa'],
  {cwd:ROOT,stdio:'ignore',env:{...process.env,VITE_BASE:'/'}});
for(let i=0;i<160;i++){try{if((await fetch(`http://localhost:${PORT}/`)).ok)break;}catch{}await new Promise(r=>setTimeout(r,250));}
const b=await puppeteer.launch({headless:true,protocolTimeout:900000,
  args:['--no-sandbox','--enable-gpu','--use-angle=metal','--enable-unsafe-swiftshader','--ignore-gpu-blocklist','--enable-webgl','--window-size=1280,720']});
const pg=await b.newPage(); await pg.setViewport({width:1280,height:720});
await pg.evaluateOnNewDocument(()=>{try{localStorage.removeItem('bh-tier');localStorage.removeItem('bh-res');localStorage.setItem('bh-onboarded','1')}catch{}});
await pg.goto(`http://localhost:${PORT}/?q=high`,{waitUntil:'networkidle2',timeout:180000});
await pg.waitForFunction('window.__ready === true',{timeout:300000});
await pg.evaluate(()=>window.__debug.setView([3771,480,-1550],[3771,5,-644]));
await new Promise(r=>setTimeout(r,12000));
console.log(JSON.stringify(await pg.evaluate(() => {
  const out = { registry: {}, meshes: [] };
  const m = window.__boston.ctx.materials;
  for (const k of ['asphalt','road_asphalt','tarmac','concrete','road_concrete','bridge_concrete','concrete_sidewalk','gravel']) {
    const s = m.textures?.(k);
    out.registry[k] = s ? { map: !!s.map, normal: !!s.normalMap, rough: !!s.roughnessMap } : null;
  }
  window.__boston.ctx.scene.traverse((o) => {
    if (!o.isMesh || !(o.name||'').startsWith('airport')) return;
    const mat = Array.isArray(o.material) ? o.material[0] : o.material;
    const col = o.geometry.getAttribute('color');
    let lo = 9, hi = -9;
    if (col) for (let i = 0; i < Math.min(col.count, 4000); i++) {
      const v = col.getX(i); if (v < lo) lo = v; if (v > hi) hi = v;
    }
    out.meshes.push({ name: o.name, mat: mat?.name, map: !!mat?.map,
      color: mat?.color ? [+mat.color.r.toFixed(3), +mat.color.g.toFixed(3), +mat.color.b.toFixed(3)] : null,
      vcol: col ? [+lo.toFixed(3), +hi.toFixed(3)] : null,
      rough: mat?.roughness, tris: (o.geometry.index?.count ?? 0) / 3 | 0 });
  });
  return out;
}), null, 1));
await b.close(); srv.kill();
