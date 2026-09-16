/** Side-by-side of the road and airport asphalt materials, and the map itself. */
import { spawn } from 'node:child_process';
import puppeteer from 'puppeteer';
const PORT = 4582, ROOT = '/Volumes/Projects/bos';
const srv = spawn('npx',['vite','preview','--port',String(PORT),'--strictPort','--outDir','dist-qa'],
  {cwd:ROOT,stdio:'ignore',env:{...process.env,VITE_BASE:'/'}});
for(let i=0;i<160;i++){try{if((await fetch(`http://localhost:${PORT}/`)).ok)break;}catch{}await new Promise(r=>setTimeout(r,250));}
const b=await puppeteer.launch({headless:true,protocolTimeout:900000,
  args:['--no-sandbox','--enable-gpu','--use-angle=metal','--enable-unsafe-swiftshader','--ignore-gpu-blocklist','--enable-webgl','--window-size=1280,720']});
const pg=await b.newPage(); await pg.setViewport({width:1280,height:720});
await pg.evaluateOnNewDocument(()=>{try{localStorage.removeItem('bh-tier');localStorage.removeItem('bh-res');localStorage.setItem('bh-onboarded','1')}catch{}});
await pg.goto(`http://localhost:${PORT}/?q=high`,{waitUntil:'networkidle2',timeout:180000});
await pg.waitForFunction('window.__ready === true',{timeout:300000});
await pg.evaluate(()=>window.__debug.setView([3771,300,-1550],[3771,5,-644]));
await new Promise(r=>setTimeout(r,14000));
console.log(JSON.stringify(await pg.evaluate(() => {
  const want = ['road-t0:asphalt', 'airport:pavement:asphalt', 'airport:pavement:apron'];
  const found = {};
  window.__boston.ctx.scene.traverse((o) => {
    if (!o.isMesh) return;
    const m = Array.isArray(o.material) ? o.material[0] : o.material;
    for (const w of want) {
      if (found[w] || !(o.name || '').startsWith(w)) continue;
      const mean = (tex) => {
        if (!tex?.image) return null;
        try {
          const c = document.createElement('canvas');
          c.width = 32; c.height = 32;
          const g = c.getContext('2d');
          g.drawImage(tex.image, 0, 0, 32, 32);
          const d = g.getImageData(0, 0, 32, 32).data;
          let r = 0, gg = 0, bb = 0;
          for (let i = 0; i < d.length; i += 4) { r += d[i]; gg += d[i+1]; bb += d[i+2]; }
          const n = d.length / 4;
          return [Math.round(r/n), Math.round(gg/n), Math.round(bb/n)];
        } catch (e) { return 'unreadable: ' + e.message; }
      };
      found[w] = { mesh: o.name, mat: m.name,
        color: [+m.color.r.toFixed(3), +m.color.g.toFixed(3), +m.color.b.toFixed(3)],
        vertexColors: m.vertexColors, rough: m.roughness, metal: m.metalness,
        envInt: m.envMapIntensity, hasAo: !!m.aoMap, hasNorm: !!m.normalMap,
        mapUuid: m.map?.uuid?.slice(0, 8) ?? null,
        mapColorSpace: m.map?.colorSpace ?? null,
        wrap: m.map ? [m.map.wrapS, m.map.wrapT] : null,
        mapIsClamp: m.map ? (m.map.wrapS === 1001 && m.map.wrapT === 1001) : null,
        mapRepeat: m.map ? [m.map.repeat.x, m.map.repeat.y] : null,
        mapMean: mean(m.map),
        defines: m.defines ? Object.keys(m.defines) : null,
        hasOBC: !!m.onBeforeCompile };
    }
  });
  return found;
}), null, 1));
await b.close(); srv.kill();
