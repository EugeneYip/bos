/** Does the building streamer follow the camera? */
import { spawn } from 'node:child_process';
import puppeteer from 'puppeteer';
const ROOT='/Volumes/Projects/bos', PORT=Number(process.env.QA_PORT||4394);
const UA='Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';
const srv=spawn('npx',['vite','preview','--port',String(PORT),'--strictPort','--outDir',process.env.QA_OUTDIR??'dist-final'],
  {cwd:ROOT,stdio:'ignore',env:{...process.env,VITE_BASE:'/'}});
for(let i=0;i<160;i++){try{if((await fetch(`http://localhost:${PORT}/`)).ok)break;}catch{}await new Promise(r=>setTimeout(r,250));}
const b=await puppeteer.launch({headless:true,protocolTimeout:900000,
  args:['--no-sandbox','--enable-gpu','--use-angle=metal','--ignore-gpu-blocklist','--enable-webgl','--window-size=1024,768']});
const pg=await b.newPage(); await pg.setViewport({width:1024,height:768}); await pg.setUserAgent(UA);
const lines=[]; pg.on('console',m=>{const t=m.text(); if(/Buildings/.test(t)) lines.push(t);});
await pg.evaluateOnNewDocument(()=>{try{localStorage.setItem('bh-onboarded','1')}catch{}});
await pg.goto(`http://localhost:${PORT}/?q=low`,{waitUntil:'networkidle2',timeout:180000});
await pg.waitForFunction('window.__ready === true',{timeout:300000});
const probe=async(label)=>{
  const s=await pg.evaluate(()=>{const st=window.__debug.stats();
    return {tiles:st.buildingTiles, shards:st.buildingShards};});
  console.log(label.padEnd(26), JSON.stringify(s));
  return s;
};
await pg.evaluate(()=>window.__debug.settle(60));
await probe('start (downtown)');
// Fly to Logan, ~5 km east, then let the streamer catch up.
for (let i=0;i<14;i++){
  await pg.evaluate((k)=>window.__debug.setView([-1900+k*420, 400, -2100+k*90],[-1500+k*420, 0, -1800+k*90]), i);
  await pg.evaluate(()=>window.__debug.settle(40));
}
await pg.evaluate(()=>window.__debug.settle(200));
await probe('after flying east 5.9km');
for (let i=13;i>=0;i--){
  await pg.evaluate((k)=>window.__debug.setView([-1900+k*420, 400, -2100+k*90],[-1500+k*420, 0, -1800+k*90]), i);
  await pg.evaluate(()=>window.__debug.settle(40));
}
await pg.evaluate(()=>window.__debug.settle(200));
await probe('back at the start');
console.log(lines.slice(0,3).join('\n'));
await b.close(); srv.kill();
