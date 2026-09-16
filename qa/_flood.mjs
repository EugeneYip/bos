/**
 * Paint one layer magenta and look. Immune to everything a screenshot diff is
 * not: moving traffic, swaying trees, stochastic post, TAA jitter. Two frames
 * of an animated city differ everywhere, which is how a noise mask came to be
 * read as 36% overdraw.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import puppeteer from 'puppeteer';
const PORT = 4563, ROOT = '/Volumes/Projects/bos';
const vp = JSON.parse(fs.readFileSync(`${ROOT}/qa/viewpoints.json`, 'utf8'));
const MATCH = process.argv[2] || 'far-terrain';
const IDS = (process.argv[3] || 'high-street,downtown-traffic').split(',');
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
const n = await pg.evaluate((m) => {
  let k = 0;
  window.__boston.ctx.scene.traverse((o) => {
    if (!(o.isMesh || o.isInstancedMesh) || !(o.name || '').includes(m)) return;
    for (const mat of (Array.isArray(o.material) ? o.material : [o.material])) {
      if (!mat) continue;
      if (mat.isShaderMaterial) {
        // A hand-written material has no `color`. Replace the whole fragment
        // stage: varyings the vertex stage declares but this never reads are
        // legal, so nothing else has to change.
        mat.fragmentShader = 'void main() { gl_FragColor = vec4( 1.0, 0.0, 1.0, 1.0 ); }';
      } else {
        mat.color?.setRGB(1, 0, 1); mat.emissive?.setRGB(1, 0, 1);
        mat.vertexColors = false; mat.map = null;
      }
      mat.needsUpdate = true; k++;
    }
  });
  return k;
}, MATCH);
console.log(`flooded ${n} material(s) matching "${MATCH}"`);
for (const id of IDS) {
  const v = Object.values(vp).find((x) => x.id === id);
  await pg.evaluate((h)=>window.__debug.setTime(h), v.hour ?? 13);
  await pg.evaluate((p,t)=>window.__debug.setView(p,t), v.pos, v.target);
  await new Promise(r=>setTimeout(r,7000));
  await pg.evaluate(()=>window.__debug.settle(80));
  const buf = await pg.screenshot();
  fs.writeFileSync(`${ROOT}/qa/shots/flood-${MATCH}-${id}.png`, buf);
  const { PNG } = await import('pngjs');
  const p = PNG.sync.read(buf);
  let hits = 0, tot = 0;
  for (let y = 0; y < p.height; y++) for (let x = 0; x < p.width; x++) {
    const i = (y * p.width + x) * 4; tot++;
    if (p.data[i] > 110 && p.data[i+2] > 110 && p.data[i+1] < p.data[i] * 0.6) hits++;
  }
  const est = await pg.evaluate(() => window.__boston.ctx.stats['water.cover']);
  console.log(`  ${id.padEnd(18)} true ${(100*hits/tot).toFixed(2)}% of the frame`
    + `   module estimate ${est ?? '-'}%`);
}
await b.close(); srv.kill();
