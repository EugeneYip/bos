/**
 * What stalls, and how often.
 *
 * `fps.low` sits at 10 at every viewpoint in this project. The mean frame is
 * 27-40 ms, so something is regularly costing ~100 ms. This parks the camera,
 * watches real frame deltas for a while, and reports every module's worst
 * update alongside the gap distribution -- so a stall can be named rather
 * than inferred.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import puppeteer from 'puppeteer';
const PORT = 4564, ROOT = '/Volumes/Projects/bos';
const vp = JSON.parse(fs.readFileSync(`${ROOT}/qa/viewpoints.json`, 'utf8'));
const v = Object.values(vp).find((x) => x.id === (process.argv[2] || 'high-street'));
const SECS = Number(process.argv[3] || 25);
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
await new Promise(r=>setTimeout(r,12000));
// Clear the high-water marks that loading and the camera jump just set.
await pg.evaluate(() => {
  for (const k of Object.keys(window.__boston.ctx.stats)) {
    if (k.startsWith('worst.')) delete window.__boston.ctx.stats[k];
  }
  window.__boston.moduleWorst?.clear?.();
});

const out = await pg.evaluate(async (secs) => {
  const gaps = []; let last = performance.now();
  const end = last + secs * 1000;
  while (performance.now() < end) {
    await new Promise((r) => requestAnimationFrame(r));
    const now = performance.now(); gaps.push(now - last); last = now;
  }
  const s = window.__boston.ctx.stats;
  const worst = {};
  for (const [k, val] of Object.entries(s)) if (k.startsWith('worst.')) worst[k] = val;
  return { gaps, worst, fps: s.fps, low: s['fps.low'], upWorst: s['cpu.update.worst'] };
}, SECS);

const g = [...out.gaps].sort((a, z) => a - z);
const pc = (q) => g[Math.min(g.length - 1, Math.floor(g.length * q))].toFixed(1);
console.log(`${v.id}: ${out.gaps.length} frames over ${SECS}s, camera parked`);
console.log(`  frame gaps  p50 ${pc(0.5)}  p90 ${pc(0.9)}  p99 ${pc(0.99)}  max ${g[g.length-1].toFixed(1)} ms`);
for (const t of [50, 80, 120, 200]) {
  const n = out.gaps.filter((x) => x > t).length;
  console.log(`    > ${String(t).padStart(3)} ms: ${n} frames (${(100*n/out.gaps.length).toFixed(1)}%,`
    + ` one every ${n ? (SECS / n).toFixed(1) : '-'} s)`);
}
console.log('  first 48 gaps: ' + out.gaps.slice(4, 52).map((x) => x.toFixed(0).padStart(3)).join(' '));
// Autocorrelation: if one frame in N is slow, the period shows here.
{
  const a = out.gaps.slice(4);
  const mean = a.reduce((s2, x) => s2 + x, 0) / a.length;
  const d = a.map((x) => x - mean);
  const denom = d.reduce((s2, x) => s2 + x * x, 0);
  const rows = [];
  for (let lag = 1; lag <= 10; lag++) {
    let num = 0;
    for (let i = 0; i + lag < d.length; i++) num += d[i] * d[i + lag];
    rows.push(`lag ${lag}: ${(num / denom).toFixed(2)}`);
  }
  console.log('  autocorrelation  ' + rows.join('  '));
}
console.log(`  stats fps ${out.fps}  fps.low ${out.low}  cpu.update.worst ${out.upWorst}`);
console.log(`  worst module update since the camera settled:`);
for (const [k, val] of Object.entries(out.worst).sort((a, z) => z[1] - a[1])) {
  console.log(`    ${k.padEnd(26)} ${val} ms`);
}
await b.close(); srv.kill();
