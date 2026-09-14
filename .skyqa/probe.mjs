import { spawn } from 'node:child_process';
import puppeteer from 'puppeteer';
const PORT = process.env.QA_PORT || 4332;
const OUTDIR = process.env.QA_OUTDIR || 'dist-sky';
const ROOT = '/Volumes/Projects/bos';
const server = spawn('npx', ['vite','preview','--port',String(PORT),'--strictPort','--outDir',OUTDIR], { cwd: ROOT, stdio:'pipe' });
for (let i=0;i<120;i++){ try { const r = await fetch(`http://localhost:${PORT}/`); if(r.ok) break; } catch {} await new Promise(r=>setTimeout(r,250)); }
const browser = await puppeteer.launch({ headless:true, protocolTimeout: 900000, args:['--no-sandbox','--enable-gpu','--use-angle=metal','--enable-unsafe-swiftshader','--ignore-gpu-blocklist','--window-size=1600,900'] });
const page = await browser.newPage();
await page.setViewport({width:1600,height:900,deviceScaleFactor:1});
page.on('pageerror', e=>console.log('PAGEERR', String(e)));
page.on('console', m=>{ if(m.type()==='error') console.log('CONSOLE', m.text()); });
await page.goto(`http://localhost:${PORT}/?q=ultra`, {waitUntil:'networkidle2', timeout:180000});
await page.waitForFunction('window.__ready === true', {timeout:300000});
await page.evaluate(()=>{ window.__debug.setTime(17.6); window.__debug.setView([-1850,300,-1750],[-500,90,250]); });
await page.evaluate(()=>window.__debug.settle(40));
const out = await page.evaluate(() => {
  const app = window.__boston; const ctx = app.ctx; const THREE = window.__THREE;
  const scene = ctx.scene;
  const info = { env: !!scene.environment, envMapping: scene.environment?.mapping, envH: scene.environment?.image?.height, envW: scene.environment?.image?.width,
    envIntensity: scene.environmentIntensity, sun: { dir: ctx.sun.direction.toArray().map(v=>+v.toFixed(3)), color: [ctx.sun.color.r, ctx.sun.color.g, ctx.sun.color.b].map(v=>+v.toFixed(3)), intensity: +ctx.sun.intensity.toFixed(4), elev: +(ctx.sun.elevation*180/Math.PI).toFixed(2) },
    exposure: ctx.renderer.toneMappingExposure, fog: scene.fog?.constructor.name };
  const lights = []; const mats = new Map();
  scene.traverse(o => {
    if (o.isDirectionalLight) lights.push({ n:o.name, i:+o.intensity.toFixed(4), c:[o.color.r,o.color.g,o.color.b].map(v=>+v.toFixed(3)), cast:o.castShadow, ms:o.shadow.mapSize.width, auto:o.shadow.autoUpdate, l:o.shadow.camera.left, f:o.shadow.camera.far });
    if (o.isMesh && o.material) { const m = Array.isArray(o.material)?o.material[0]:o.material;
      if (!mats.has(m.uuid) && mats.size<8) mats.set(m.uuid, { name:o.name, type:m.type, aerial: !!(m.defines&&m.defines.SKY_AERIAL), recv:o.receiveShadow, cast:o.castShadow, envI:m.envMapIntensity, color: m.color? [m.color.r,m.color.g,m.color.b].map(v=>+v.toFixed(3)):null, rough:m.roughness, metal:m.metalness }); }
  });
  info.lights = lights; info.mats = [...mats.values()];
  info.stats = ctx.stats;
  return info;
});
console.log(JSON.stringify(out,null,1));

// Read the pmrem atlas pixels back
const px = await page.evaluate(() => {
  const ctx = window.__boston.ctx; const THREE = window.__THREE;
  const tex = ctx.scene.environment; if(!tex) return 'no env';
  // find the render target: read via a temp readRenderTargetPixels is not possible w/o the RT.
  return { type: tex.type, colorSpace: tex.colorSpace, isRT: !!tex.isRenderTargetTexture };
});
console.log('env tex', JSON.stringify(px));
await browser.close(); server.kill();
