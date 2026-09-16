/**
 * Why is the ground under a closed tree canopy pure black?
 *
 * The Commonwealth Avenue Mall's paving reads 0,0,0 at 4:23 pm -- not dark,
 * *zero*, which means it is receiving no sun and no sky either. Deep shade
 * under elms is maybe a fifth of the sunlit value, never nothing. The
 * vegetation materials already carry a `canopy` skylight floor, added because
 * without it "every trunk on the Common is a black post"; the ground has no
 * such floor. This tests each suspect by toggling it at runtime via the
 * `post:set` event and sampling the same pixels.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import puppeteer from 'puppeteer';
import { PNG } from 'pngjs';
const PORT = 4575, ROOT = '/Volumes/Projects/bos';
const vp = Object.values(JSON.parse(fs.readFileSync(`${ROOT}/qa/viewpoints.json`, 'utf8')));
const v = vp.find((x) => x.id === (process.argv[2] || 'comm-ave'));
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
await new Promise(r=>setTimeout(r,9000));

/** The darkest decile of the frame, and a band of shaded ground. */
const sample = async (tag) => {
  await pg.evaluate(()=>window.__debug.settle(80));
  const buf = await pg.screenshot();
  fs.writeFileSync(`${ROOT}/qa/shots/canopy-${tag}.png`, buf);
  const p = PNG.sync.read(buf);
  const L = (i) => 0.2126*p.data[i] + 0.7152*p.data[i+1] + 0.0722*p.data[i+2];
  const lum = [];
  let black = 0, n = 0;
  for (let y = 380; y < 660; y += 2) for (let x = 560; x < 1260; x += 2) {
    const l = L((y * p.width + x) * 4); lum.push(l); n++;
    if (l < 1.0) black++;
  }
  lum.sort((a, c) => a - c);
  const road = [];
  for (let y = 430; y < 520; y += 2) for (let x = 20; x < 260; x += 2) road.push(L((y*p.width+x)*4));
  road.sort((a, c) => a - c);
  console.log(`${tag.padEnd(22)} shaded ground p10 ${lum[(n*0.1)|0].toFixed(1)}`
    + `  p50 ${lum[(n*0.5)|0].toFixed(1)}  p90 ${lum[(n*0.9)|0].toFixed(1)}`
    + `  pure black ${(100*black/n).toFixed(1)}%`
    + `   |  sunlit road p50 ${road[(road.length*0.5)|0].toFixed(1)}`);
};
const set = (k, val) => pg.evaluate(([key, value]) => {
  window.__boston.ctx.emit('post:set', { key, value });
}, [k, val]);

await sample('baseline');
for (const k of ['ssao', 'bloom', 'grain', 'vignette', 'taa', 'dof']) {
  await set(k, false);
  await sample(`no-${k}`);
  await set(k, true);
}
// And with no post at all, to bound how much of it is the chain.
await set('enabled', false);
await sample('post off');
await set('enabled', true);
// Shadows off: separates 'no sun' from 'no ambient'.
await pg.evaluate(()=>window.__debug.probe({ shadows: false }));
await sample('shadows off');
await pg.evaluate(()=>window.__debug.probe({ shadows: true }));
await b.close(); srv.kill();
