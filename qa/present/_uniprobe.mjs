/**
 * Prove a diagnostic knob reaches the shader before trusting any measurement
 * taken with it.
 *
 * Three experiments in a row in this session measured a bit-identical frame
 * because the change never arrived: a patch that failed to write, a helper
 * whose conversion happens one layer down in GLSL, and now a URL knob. The
 * cost each time was a confident wrong conclusion, so verify the instrument.
 */
import { spawn } from 'node:child_process';
import puppeteer from 'puppeteer';
const ROOT='/Volumes/Projects/bos', PORT=Number(process.env.QA_PORT||4494), OUT=process.env.LOCAL||'dist-ap';
const srv=spawn('npx',['vite','preview','--port',String(PORT),'--strictPort','--outDir',OUT],
  {cwd:ROOT,stdio:'ignore',env:{...process.env,VITE_BASE:'/'}});
for(let i=0;i<160;i++){try{if((await fetch(`http://localhost:${PORT}/`)).ok)break;}catch{}await new Promise(r=>setTimeout(r,250));}
const b=await puppeteer.launch({headless:true,protocolTimeout:900000,
  args:['--no-sandbox','--enable-gpu','--use-angle=metal','--ignore-gpu-blocklist','--enable-webgl']});
for (const qs of ['', '?apstr=0&apgain=0']) {
  const pg=await b.newPage(); await pg.setViewport({width:1200,height:700,deviceScaleFactor:1});
  await pg.evaluateOnNewDocument(()=>{try{localStorage.setItem('bh-onboarded','1')}catch{}});
  await pg.goto(`http://localhost:${PORT}/${qs}`,{waitUntil:'domcontentloaded',timeout:120000});
  await pg.waitForFunction('window.__ready === true',{timeout:300000,polling:500});
  await pg.evaluate(()=>window.__debug.settle(60));
  const r = await pg.evaluate(() => {
    const app = window.__boston;
    const sky = app.modules.find(m => m.name === 'Sky');
    const u = sky && sky.shading ? sky.shading.uniforms : null;
    // Also count how many live materials carry the uniform, and what they say.
    const seen = new Map();
    app.ctx.scene.traverse(o => {
      const mats = Array.isArray(o.material) ? o.material : (o.material ? [o.material] : []);
      for (const m of mats) {
        const uu = m.uniforms;
        if (uu && uu.uApStrength) {
          const k = `${uu.uApStrength.value}/${uu.uApInscatterGain?.value}`;
          seen.set(k, (seen.get(k) || 0) + 1);
        }
      }
    });
    return {
      search: location.search || '(none)',
      skyUniform: u ? { strength: u.uApStrength?.value, gain: u.uApInscatterGain?.value } : '(no sky.shading.uniforms)',
      materialsCarryingIt: [...seen.entries()].map(([k, n]) => `${k} x${n}`),
    };
  });
  console.log(JSON.stringify(r));
  await pg.close();
}
await b.close(); srv.kill();
