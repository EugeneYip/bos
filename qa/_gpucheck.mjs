/**
 * Which renderer is the harness actually using, and what does the water do on it?
 *
 * Every QA script here passes `--enable-unsafe-swiftshader`, which lets Chrome
 * fall back to the CPU rasteriser. If it has been taking that path, then none
 * of this project's rendering has ever been measured on a real GPU, and a bug
 * that only appears on one would be invisible. This runs the same viewpoint
 * with and without the fallback allowed and reports the renderer string
 * alongside the water's mean luma.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import puppeteer from 'puppeteer';
import { PNG } from 'pngjs';
const ROOT = '/Volumes/Projects/bos';
const vp = Object.values(JSON.parse(fs.readFileSync(`${ROOT}/qa/viewpoints.json`, 'utf8')));
const v = vp.find((x) => x.id === 'charles-water');

const BASE = ['--no-sandbox', '--enable-gpu', '--ignore-gpu-blocklist', '--enable-webgl',
  '--window-size=1280,720'];
const ARMS = [
  ['swiftshader allowed (what every harness does)', [...BASE, '--use-angle=metal', '--enable-unsafe-swiftshader']],
  ['metal only, no fallback', [...BASE, '--use-angle=metal']],
  ['default angle, no fallback', [...BASE]],
];

const PORT = 4660;
const srv = spawn('npx',['vite','preview','--port',String(PORT),'--strictPort','--outDir','dist-qa'],
  {cwd:ROOT,stdio:'ignore',env:{...process.env,VITE_BASE:'/'}});
for(let i=0;i<160;i++){try{if((await fetch(`http://localhost:${PORT}/`)).ok)break;}catch{}await new Promise(r=>setTimeout(r,250));}

for (const [label, args] of ARMS) {
  let b;
  try { b = await puppeteer.launch({ headless: true, protocolTimeout: 900000, args }); }
  catch (e) { console.log(`${label.padEnd(46)} launch failed: ${String(e).slice(0, 80)}`); continue; }
  try {
    const pg = await b.newPage();
    await pg.setViewport({ width: 1280, height: 720 });
    await pg.evaluateOnNewDocument(()=>{try{localStorage.removeItem('bh-tier');localStorage.removeItem('bh-res');localStorage.setItem('bh-onboarded','1')}catch{}});
    await pg.goto(`http://localhost:${PORT}/?q=high`, { waitUntil: 'networkidle2', timeout: 180000 });
    const gpu = await pg.evaluate(() => {
      const g = document.createElement('canvas').getContext('webgl2');
      const d = g?.getExtension('WEBGL_debug_renderer_info');
      return {
        renderer: d ? g.getParameter(d.UNMASKED_RENDERER_WEBGL) : 'unknown',
        float: !!g?.getExtension('EXT_color_buffer_float'),
        halfLinear: !!g?.getExtension('OES_texture_half_float_linear'),
        floatLinear: !!g?.getExtension('OES_texture_float_linear'),
      };
    });
    await pg.waitForFunction('window.__ready === true', { timeout: 300000 });
    await new Promise(r => setTimeout(r, 9000));
    await pg.evaluate((h)=>window.__debug.setTime(h), v.hour ?? 13);
    await pg.evaluate((p,t)=>window.__debug.setView(p,t), v.pos, v.target);
    await new Promise(r => setTimeout(r, 8000));
    await pg.evaluate(()=>window.__debug.settle(80));
    const buf = await pg.screenshot();
    fs.writeFileSync(`${ROOT}/qa/shots/gpu-${label.split(' ')[0]}.png`, buf);
    const p = PNG.sync.read(buf);
    const L = (i) => 0.2126*p.data[i] + 0.7152*p.data[i+1] + 0.0722*p.data[i+2];
    let m = 0, n = 0, blown = 0;
    for (let y = 378; y < 436; y++) for (let x = 280; x < 980; x++) {
      const l = L((y*p.width+x)*4); m += l; n++; if (l > 200) blown++;
    }
    const st = await pg.evaluate(()=>({ exp: +window.__boston.ctx.exposure.toFixed(3),
      envInt: window.__boston.ctx.scene.environmentIntensity }));
    console.log(`${label.padEnd(46)} ${String(gpu.renderer).slice(0, 44).padEnd(46)}`);
    console.log(`${' '.repeat(46)} water luma ${(m/n).toFixed(1)}  blown ${(100*blown/n).toFixed(1)}%  exposure ${st.exp}  envInt ${st.envInt}`);
  } catch (e) {
    console.log(`${label.padEnd(46)} failed: ${String(e).slice(0, 100)}`);
  }
  await b.close();
}
srv.kill();
