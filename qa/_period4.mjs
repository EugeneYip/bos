/**
 * What runs on the slow frame?
 *
 * Parked, frame gaps are period-4: three frames near 10 ms, one near 68.
 * Records per-frame gap alongside draw calls, the CPU update/submit split and
 * texture/program counts, then prints the slow frames beside the fast ones so
 * the difference names itself.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import puppeteer from 'puppeteer';
const PORT = 4566, ROOT = '/Volumes/Projects/bos';
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
await new Promise(r=>setTimeout(r,10000));
await pg.evaluate((h)=>window.__debug.setTime(h), v.hour ?? 13);
await pg.evaluate((p,t)=>window.__debug.setView(p,t), v.pos, v.target);
await new Promise(r=>setTimeout(r,10000));

const rows = await pg.evaluate(async () => {
  const { renderer, stats } = window.__boston.ctx;
  const out = [];
  let last = performance.now();
  for (let i = 0; i < 200; i++) {
    await new Promise((k) => requestAnimationFrame(k));
    const n = performance.now();
    out.push({ gap: n - last, calls: renderer.info.render.calls,
      tris: renderer.info.render.triangles, progs: renderer.info.programs.length,
      tex: renderer.info.memory.textures, up: stats['cpu.update'], sub: stats['cpu.submit'] });
    last = n;
  }
  return out;
});
const r = rows.slice(8);
const slow = r.filter((x) => x.gap > 40), fast = r.filter((x) => x.gap <= 40);
const avg = (a, k) => (a.reduce((s, x) => s + (x[k] ?? 0), 0) / a.length);
console.log(`${v.id}: ${slow.length} slow / ${fast.length} fast of ${r.length} frames`);
const show = (n, a) => console.log(`  ${n.padEnd(6)} gap ${avg(a,'gap').toFixed(1)}ms`
  + `  calls ${avg(a,'calls').toFixed(0)}  tris ${(avg(a,'tris')/1e6).toFixed(2)}M`
  + `  programs ${avg(a,'progs').toFixed(1)}  textures ${avg(a,'tex').toFixed(1)}`
  + `  cpu.update ${avg(a,'up').toFixed(2)}  cpu.submit ${avg(a,'sub').toFixed(2)}`);
show('slow', slow); show('fast', fast);
console.log('\n  gap / calls, 24 consecutive frames:');
console.log('  ' + r.slice(0, 24).map((x) => `${x.gap.toFixed(0)}/${x.calls}`).join('  '));
await b.close(); srv.kill();
