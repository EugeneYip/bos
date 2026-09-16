/**
 * What colour are the brightest pixels?
 *
 * A concurrent pass measured headlamps at 255,147,81 where a warm-white
 * (1.0, 0.80, 0.58) emitter through a filmic curve should land near cream.
 * The grade adds halation as `bloom * vec3(1.0, 0.42, 0.26) * 0.18` -- and
 * bloom peaks *on* a highlight, not around it, so that dyes the highlight
 * rather than haloing it. Bloom off takes halation with it, which is the test.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import puppeteer from 'puppeteer';
import { PNG } from 'pngjs';
const PORT = 4578, ROOT = '/Volumes/Projects/bos';
const vp = Object.values(JSON.parse(fs.readFileSync(`${ROOT}/qa/viewpoints.json`, 'utf8')));
const IDS = (process.argv[2] || 'street-night,seaport-night,high-street').split(',');
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
const set = (k, val) => pg.evaluate(([key, value]) =>
  window.__boston.ctx.emit('post:set', { key, value }), [k, val]);
const shot = async (tag) => {
  await pg.evaluate(()=>window.__debug.settle(80));
  const buf = await pg.screenshot();
  fs.writeFileSync(`${ROOT}/qa/shots/hilite-${tag}.png`, buf);
  const p = PNG.sync.read(buf);
  const L = (i) => 0.2126*p.data[i] + 0.7152*p.data[i+1] + 0.0722*p.data[i+2];
  const px = [];
  for (let y = 0; y < p.height; y++) for (let x = 0; x < p.width; x++) {
    const i = (y*p.width+x)*4; px.push([L(i), p.data[i], p.data[i+1], p.data[i+2]]);
  }
  px.sort((a, c) => c[0] - a[0]);
  const take = (n0, n1) => { let r=0,g=0,bl=0,k=0;
    for (let i = (px.length*n0)|0; i < (px.length*n1)|0; i++) { r+=px[i][1]; g+=px[i][2]; bl+=px[i][3]; k++; }
    return [r/k, g/k, bl/k]; };
  const top = take(0, 0.0002), hi = take(0.0002, 0.003);
  const sat = (c) => (Math.max(...c) - Math.min(...c)) / Math.max(Math.max(...c), 1);
  return `top0.02% ${top.map((v)=>v.toFixed(0)).join(',').padEnd(12)} sat ${sat(top).toFixed(2)}`
       + `   next0.3% ${hi.map((v)=>v.toFixed(0)).join(',').padEnd(12)} sat ${sat(hi).toFixed(2)}`;
};
for (const id of IDS) {
  const v = vp.find((x) => x.id === id);
  await pg.evaluate((h)=>window.__debug.setTime(h), v.hour ?? 13);
  await pg.evaluate((p,t)=>window.__debug.setView(p,t), v.pos, v.target);
  await new Promise(r=>setTimeout(r,8000));
  console.log(`\n== ${id}`);
  await set('bloom', true);  console.log('  bloom on   ' + await shot(`${id}-bloom`));
  await set('bloom', false); console.log('  bloom off  ' + await shot(`${id}-nobloom`));
  await set('bloom', true);
}
await b.close(); srv.kill();
