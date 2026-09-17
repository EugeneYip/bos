/** Does a boot that dies mid-load make the next one lighter? */
import { spawn } from 'node:child_process';
import puppeteer from 'puppeteer';
const ROOT='/Volumes/Projects/bos', PORT=Number(process.env.QA_PORT||4402);
const srv=spawn('npx',['vite','preview','--port',String(PORT),'--strictPort','--outDir',process.env.QA_OUTDIR??'dist-final'],
  {cwd:ROOT,stdio:'ignore',env:{...process.env,VITE_BASE:'/'}});
for(let i=0;i<160;i++){try{if((await fetch(`http://localhost:${PORT}/`)).ok)break;}catch{}await new Promise(r=>setTimeout(r,250));}
const b=await puppeteer.launch({headless:true,protocolTimeout:900000,
  args:['--no-sandbox','--enable-gpu','--use-angle=metal','--ignore-gpu-blocklist','--enable-webgl','--window-size=1024,768']});
const pg=await b.newPage(); await pg.setViewport({width:1024,height:768});
await pg.evaluateOnNewDocument(()=>{try{localStorage.setItem('bh-onboarded','1')}catch{}});

const boot = async (label, killEarly) => {
  await pg.goto(`http://localhost:${PORT}/`,{waitUntil:'domcontentloaded',timeout:180000});
  if (killEarly) {
    // Simulate an out-of-memory kill: reload before the guard can disarm.
    await new Promise(r=>setTimeout(r, 3500));
    const lvl = await pg.evaluate(()=>{ try{ return localStorage.getItem('bh-safe'); }catch(e){ return 'err'; } });
    console.log(`${label.padEnd(22)} killed mid-load, stored level=${lvl}`);
    return;
  }
  await pg.waitForFunction('window.__ready === true',{timeout:300000});
  await pg.evaluate(()=>window.__debug.settle(60));
  const s=await pg.evaluate(()=>{
    const st=window.__debug.stats();
    return { safeLevel: window.__boston.ctx.safeLevel,
             modules: window.__boston.modules.map(m=>m.name).filter(n=>n!=='FrameCounter').length,
             hasTraffic: window.__boston.modules.some(m=>m.name==='Traffic'),
             hasPhysics: window.__boston.modules.some(m=>m.name==='Physics'),
             hasVeg: window.__boston.modules.some(m=>m.name==='Vegetation'),
             tiles: st.buildingTiles };
  });
  console.log(label.padEnd(22), JSON.stringify(s));
};

await boot('clean boot', false);
await pg.evaluate(()=>{try{localStorage.removeItem('bh-safe');localStorage.removeItem('bh-boot')}catch(e){}});
await boot('crash 1', true);
await boot('after 1 crash', false);
await boot('crash 2', true);
await boot('after 2 crashes', false);
await b.close(); srv.kill();
