/** Peak JS heap during load — what an OOM killer actually reacts to. */
import { spawn } from 'node:child_process';
import puppeteer from 'puppeteer';
const UA_STRING = 'Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';
const MOBILE_DEVICE = !!process.env.MOBILE_UA || (!process.env.DESKTOP && false);
const ROOT='/Volumes/Projects/bos', PORT=Number(process.env.QA_PORT||4401);
const srv=spawn('npx',['vite','preview','--port',String(PORT),'--strictPort','--outDir',process.env.QA_OUTDIR??'dist-final'],
  {cwd:ROOT,stdio:'ignore',env:{...process.env,VITE_BASE:'/'}});
for(let i=0;i<160;i++){try{if((await fetch(`http://localhost:${PORT}/`)).ok)break;}catch{}await new Promise(r=>setTimeout(r,250));}
const b=await puppeteer.launch({headless:true,protocolTimeout:900000,
  args:['--no-sandbox','--enable-gpu','--use-angle=metal','--ignore-gpu-blocklist','--enable-webgl','--window-size=1180,820']});
const pg=await b.newPage();
// Emulate a real touch device, not just its user-agent string.
//
// `MOBILE` in core/gpu.ts requires 'pointer: coarse' as well as touch points,
// because a user-agent test alone was stripping desktops. Setting only the UA
// here therefore measured the DESKTOP path and reported a doubled heap as a
// regression in somebody else's work. `page.emulate` sets the device-metrics
// override with mobile:true, which is what makes the media query true.
if (MOBILE_DEVICE) {
  await pg.emulate({
    userAgent: UA_STRING,
    viewport: { width: 1180, height: 820, deviceScaleFactor: 2, isMobile: true, hasTouch: true, isLandscape: true },
  });
} else {
  await pg.setViewport({ width: 1180, height: 820, deviceScaleFactor: 1 });
}

if (MOBILE_DEVICE) {
  // `page.emulate` does not move `navigator.maxTouchPoints`, which is what
  // core/gpu.ts reads to spot an iPad behind its Macintosh user agent. Set it
  // explicitly, or the harness measures the desktop path while believing it
  // is on mobile -- which once looked like a doubled heap in somebody else's
  // work.
  await pg.evaluateOnNewDocument(() => {
    Object.defineProperty(navigator, 'maxTouchPoints', { get: () => 5 });
  });
}
await pg.evaluateOnNewDocument(()=>{
  try{ localStorage.setItem('bh-onboarded','1'); }catch{}
  window.__peak = 0; window.__trace = [];
  const t0 = performance.now();
  setInterval(() => {
    const m = performance.memory?.usedJSHeapSize || 0;
    if (m > window.__peak) window.__peak = m;
    window.__trace.push([Math.round(performance.now()-t0), Math.round(m/1048576)]);
  }, 200);
});
const qs=[process.env.Q?`q=${process.env.Q}`:'', process.env.SAFE?`safe=${process.env.SAFE}`:''].filter(Boolean).join('&');
await pg.goto(`http://localhost:${PORT}/${qs?'?'+qs:''}`,{waitUntil:'networkidle2',timeout:180000});
await pg.waitForFunction('window.__ready === true',{timeout:300000});
// Refuse to report numbers for the wrong code path. A user-agent string on
// its own no longer makes `MOBILE` true, and measuring the desktop path while
// believing it is mobile produced a phantom doubling of the heap once already.
{
  const d = await pg.evaluate(() => window.__debug.diag());
  if (MOBILE_DEVICE !== d.mobile) {
    await b.close(); srv.kill();
    throw new Error(`asked for mobile=${MOBILE_DEVICE} but the app reports mobile=${d.mobile}, tier=${d.tier} — emulation is not reaching core/gpu.ts`);
  }
  const wantSafe = Number(process.env.SAFE ?? 0);
  if (d.safeLevel !== wantSafe) {
    await b.close(); srv.kill();
    throw new Error(`asked for safeLevel=${wantSafe} but the app reports ${d.safeLevel} — a stale bh-safe in storage, or the ladder moved`);
  }
}
await pg.evaluate(()=>window.__debug.settle(400));
await new Promise(r=>setTimeout(r,9000));
const cdp=await pg.target().createCDPSession();
await cdp.send('HeapProfiler.enable'); await cdp.send('HeapProfiler.collectGarbage');
await new Promise(r=>setTimeout(r,1200));
console.log(JSON.stringify(await pg.evaluate(()=>{
  const tr=window.__trace;
  const peakAt=tr.reduce((a,b)=>b[1]>a[1]?b:a,[0,0]);
  return { peakMB: Math.round(window.__peak/1048576), peakAtMs: peakAt[0],
    settledMB: Math.round(performance.memory.usedJSHeapSize/1048576),
    curve: tr.filter((_,i)=>i%5===0).map(p=>p[1]).join(',') };
})));
await b.close(); srv.kill();
