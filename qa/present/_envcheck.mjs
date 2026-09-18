import { spawn } from 'node:child_process';
import puppeteer from 'puppeteer';
const ROOT='/Volumes/Projects/bos', PORT=Number(process.env.QA_PORT||4506), OUT=process.env.LOCAL||'dist-final2';
const srv=spawn('npx',['vite','preview','--port',String(PORT),'--strictPort','--outDir',OUT],
  {cwd:ROOT,stdio:'ignore',env:{...process.env,VITE_BASE:'/'}});
for(let i=0;i<160;i++){try{if((await fetch(`http://localhost:${PORT}/`)).ok)break;}catch{}await new Promise(r=>setTimeout(r,250));}
const b=await puppeteer.launch({headless:true,protocolTimeout:900000,
  args:['--no-sandbox','--enable-gpu','--use-angle=metal','--ignore-gpu-blocklist','--enable-webgl']});
const pg=await b.newPage(); await pg.setViewport({width:1200,height:700,deviceScaleFactor:1});
await pg.evaluateOnNewDocument(()=>{try{localStorage.setItem('bh-onboarded','1')}catch{}});
await pg.goto(`http://localhost:${PORT}/`,{waitUntil:'domcontentloaded',timeout:120000});
await pg.waitForFunction('window.__ready === true',{timeout:300000,polling:500});
await pg.evaluate(()=>window.__debug.settle(90));
console.log(JSON.stringify(await pg.evaluate(() => {
  const app = window.__boston, sc = app.ctx.scene;
  const out = { sceneEnvironment: !!sc.environment, sceneEnvironmentIntensity: sc.environmentIntensity, ctxEnvMap: !!app.ctx.envMap, mats: [] };
  const seen = new Set();
  sc.traverse(o => {
    const ms = Array.isArray(o.material)?o.material:(o.material?[o.material]:[]);
    for (const m of ms) {
      if (!m.name || seen.has(m.name)) continue; seen.add(m.name);
      if (m.envMapIntensity === undefined) continue;
      out.mats.push({ name: m.name, envMap: !!m.envMap, envMapIntensity: m.envMapIntensity });
    }
  });
  out.mats = out.mats.slice(0, 14);
  return out;
}), null, 1));
await b.close(); srv.kill();
