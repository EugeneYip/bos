/**
 * Drives the camera along a street-level path through downtown and reports the
 * worst single frame the road module spent building tiles, plus the worst
 * frame-to-frame gap the page actually saw.
 */
import { spawn } from 'node:child_process';
import puppeteer from 'puppeteer';
const PORT = 4553, ROOT = '/Volumes/Projects/bos';
const srv = spawn('npx',['vite','preview','--port',String(PORT),'--strictPort','--outDir','dist-qa'],
  {cwd:ROOT,stdio:'ignore',env:{...process.env,VITE_BASE:'/'}});
for(let i=0;i<160;i++){try{if((await fetch(`http://localhost:${PORT}/`)).ok)break;}catch{}await new Promise(r=>setTimeout(r,250));}
const b=await puppeteer.launch({headless:true,protocolTimeout:900000,
  args:['--no-sandbox','--enable-gpu','--use-angle=metal','--enable-unsafe-swiftshader','--ignore-gpu-blocklist','--enable-webgl','--window-size=1280,720']});
const pg=await b.newPage(); await pg.setViewport({width:1280,height:720});
await pg.evaluateOnNewDocument(()=>{try{localStorage.removeItem('bh-tier');localStorage.removeItem('bh-res');localStorage.setItem('bh-onboarded','1')}catch{}});
await pg.goto(`http://localhost:${PORT}/?q=high`,{waitUntil:'networkidle2',timeout:180000});
await pg.waitForFunction('window.__ready === true',{timeout:300000});
await new Promise(r=>setTimeout(r,8000));
await pg.evaluate(()=>window.__debug.setTime(13));

const out = await pg.evaluate(async () => {
  // A 2.4 km street-level run: Back Bay -> Common -> Financial District ->
  // Seaport, at 9 m above the ground, which streams fresh road tiles the
  // whole way.
  const path = [[-1200, 9, 420], [-700, 9, 260], [-260, 9, 90], [120, 9, 60],
    [520, 9, 120], [900, 10, 360], [1340, 10, 620]];
  const lerp = (a, bb, t) => a.map((v, i) => v + (bb[i] - v) * t);
  const { stats } = window.__boston.ctx;
  // Reset the high-water marks the run is about to fill.
  stats.roadWorstTileMs = 0; stats.roadWorstFlushMs = 0; stats.roadWorstSliceItems = 0;
  let worstGap = 0, last = performance.now(), frames = 0;
  const samples = [];
  for (let seg = 0; seg < path.length - 1; seg++) {
    for (let k = 0; k < 40; k++) {
      const p = lerp(path[seg], path[seg + 1], k / 40);
      const tgt = lerp(path[seg], path[seg + 1], (k + 6) / 40);
      window.__debug.setView(p, [tgt[0], tgt[1] + 6, tgt[2]]);
      await new Promise((r) => requestAnimationFrame(r));
      const now = performance.now();
      const gap = now - last; last = now; frames++;
      if (frames > 4) worstGap = Math.max(worstGap, gap);
      samples.push(gap);
    }
  }
  samples.sort((x, y) => x - y);
  return { frames, worstGap: +worstGap.toFixed(1),
    p50: +samples[samples.length >> 1].toFixed(1),
    p95: +samples[Math.floor(samples.length * 0.95)].toFixed(1),
    over33: samples.filter((x) => x > 33).length,
    roadWorstTileMs: stats.roadWorstTileMs, roadWorstFlushMs: stats.roadWorstFlushMs,
    roadWorstSliceItems: stats.roadWorstSliceItems, roadHeaviestTile: stats.roadHeaviestTile,
    roadQueue: stats.roadQueue, roadMs: stats.roadMs };
});
console.log(JSON.stringify(out, null, 1));
await b.close(); srv.kill();
