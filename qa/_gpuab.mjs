/**
 * Which pixel-count-independent GPU work is the frame waiting on?
 *
 * On an idle machine the CPU spends 8 ms of a 25 ms frame (cpu.update 3,
 * cpu.submit 5) and the slow frames do identical CPU work, so the frame is
 * GPU-bound. Quartering the backbuffer buys only 16%, so it is not backbuffer
 * fill. That leaves work whose size does not follow the window: the
 * fixed-size atmosphere tables rebuilt every frame, the planar reflection, and
 * raw vertex throughput at ~8.5M triangles a frame.
 *
 * Each arm is patched at runtime in one session and interleaved.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import puppeteer from 'puppeteer';
const PORT = 4567, ROOT = '/Volumes/Projects/bos';
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

await pg.evaluate(() => {
  const sky = window.__boston.modules.find((m) => m.name === 'Sky');
  const water = window.__boston.modules.find((m) => m.name === 'Water');
  window.__ab = {
    sky, water,
    lutOrig: sky?.luts?.updateSkyView?.bind(sky.luts),
    refl: water?.reflection ?? water?.planar ?? null,
  };
  return 0;
});
console.log('reachable:', await pg.evaluate(() => ({
  sky: !!window.__ab.sky, lut: !!window.__ab.lutOrig,
  waterKeys: Object.keys(window.__ab.water || {}).filter((k) => /refl|planar/i.test(k)),
})));

const arms = {
  baseline: () => {},
  'sky LUT frozen': () => { const a = window.__ab; a.sky.luts.updateSkyView = () => {}; },
  'reflection off': () => { const a = window.__ab;
    const r = a.water.reflection ?? a.water.planar; if (r) r.opts.interval = 1e9; },
  'both off': () => { const a = window.__ab; a.sky.luts.updateSkyView = () => {};
    const r = a.water.reflection ?? a.water.planar; if (r) r.opts.interval = 1e9; },
};
const restore = () => pg.evaluate(() => { const a = window.__ab;
  a.sky.luts.updateSkyView = a.lutOrig;
  const r = a.water.reflection ?? a.water.planar; if (r) r.opts.interval = 2; });

const measure = async () => pg.evaluate(async () => {
  for (let i = 0; i < 30; i++) await new Promise((k) => requestAnimationFrame(k));
  const gaps = []; let last = performance.now();
  for (let i = 0; i < 260; i++) {
    await new Promise((k) => requestAnimationFrame(k));
    const n = performance.now(); gaps.push(n - last); last = n;
  }
  const mean = gaps.reduce((s, x) => s + x, 0) / gaps.length;
  const s = [...gaps].sort((x, y) => x - y);
  return { mean, p50: s[s.length >> 1], p90: s[Math.floor(s.length * 0.9)] };
});

for (let pass = 0; pass < 2; pass++) {
  for (const [name, fn] of Object.entries(arms)) {
    await restore();
    await pg.evaluate(`(${fn.toString()})()`);
    const m = await measure();
    console.log(`pass${pass} ${name.padEnd(16)} mean ${m.mean.toFixed(1)}ms = ${(1000/m.mean).toFixed(0)} fps`
      + `   p50 ${m.p50.toFixed(1)}  p90 ${m.p90.toFixed(1)}`);
  }
}
await restore(); await b.close(); srv.kill();
