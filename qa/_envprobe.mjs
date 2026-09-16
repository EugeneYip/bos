/**
 * Is the IBL probe the period-4 stall?
 *
 * Parked at a viewpoint, frame gaps run 10 11 72 7 8 14 70 8 -- three cheap
 * frames then one five times as expensive, autocorrelation 0.70 at lag 4.
 * EnvProbe's `minInterval` is 4. This raises it at runtime and re-measures the
 * same session, so nothing else changes.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import puppeteer from 'puppeteer';
const PORT = 4565, ROOT = '/Volumes/Projects/bos';
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

console.log('reachable:', await pg.evaluate(() => {
  const mods = window.__boston.modules || [];
  const sky = mods.find((m) => m.name === 'Sky');
  return { modules: mods.length, sky: !!sky, env: !!sky?.env,
    minInterval: sky?.env?.minInterval, angleThreshold: sky?.env?.angleThreshold,
    daySpeed: mods.find((m) => m.name === 'Hud')?.daySpeed };
}));

const run = async (label, minInterval) => {
  await pg.evaluate((mi) => {
    const sky = window.__boston.modules.find((m) => m.name === 'Sky');
    if (sky?.env) sky.env.minInterval = mi;
  }, minInterval);
  const r = await pg.evaluate(async () => {
    for (let i = 0; i < 40; i++) await new Promise((k) => requestAnimationFrame(k));
    const gaps = []; let last = performance.now();
    for (let i = 0; i < 320; i++) {
      await new Promise((k) => requestAnimationFrame(k));
      const n = performance.now(); gaps.push(n - last); last = n;
    }
    return { gaps, builds: window.__boston.ctx.stats['sky.envBuilds'] };
  });
  const g = [...r.gaps].sort((x, y) => x - y);
  const q = (p) => g[Math.floor(g.length * p)].toFixed(1);
  const mean = r.gaps.reduce((s, x) => s + x, 0) / r.gaps.length;
  console.log(`${label.padEnd(22)} p50 ${q(0.5)}  p90 ${q(0.9)}  max ${g[g.length-1].toFixed(1)}`
    + `  mean ${mean.toFixed(1)}ms = ${(1000/mean).toFixed(0)} fps   envBuilds ${r.builds}`);
  console.log(`  ${r.gaps.slice(0, 24).map((x) => x.toFixed(0).padStart(3)).join(' ')}`);
};
// Alternate, so a slow patch of machine cannot land on one arm only.
for (let i = 0; i < 2; i++) {
  await run('minInterval 4 (now)', 4);
  await run('minInterval 1e9 (off)', 1e9);
}
await b.close(); srv.kill();
