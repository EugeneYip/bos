/**
 * Which light (or which mesh) is the pale surface at Logan?
 *
 * `qa/logan/_ablate.mjs --mode roots` showed that hiding the scene's `sky`
 * group is the ONLY ablation that touches the pale strips: paleA 78.7 -> 0.67
 * at hour 23, while terrain / water / parks / roads / buildings / props /
 * traffic / transit / vegetation / far-terrain all move it by < 0.6.
 *
 * Two candidates survive that:
 *   H1  the pale surface IS the sky dome, seen through a hole in the world
 *       (the dome's lower hemisphere carries a synthetic 0.22-albedo ground
 *       term, which is flat, sun-independent and brighter than the sky).
 *   H2  a light parented under the `sky` group is the only thing lighting it.
 *
 * This script separates them: it enumerates every light and every mesh under
 * `sky`, ablates each one individually, nulls the IBL, and tints the dome.
 */
import { spawn } from 'node:child_process';
import { writeFile, readFile, mkdir } from 'node:fs/promises';
import puppeteer from 'puppeteer';
import { PNG } from 'pngjs';

const ROOT = '/Volumes/Projects/bos';
const PORT = Number(process.env.QA_PORT || 4635);
const OUTDIR = process.env.QA_OUTDIR || 'dist-loganfix';
const A = process.argv.slice(2);
const fl = (n, d) => { const i = A.indexOf('--' + n); return i >= 0 ? A[i + 1] : d; };
const VIEW = fl('view', 'logan-taxi-wide');
const TIER = fl('tier', 'high');
const HOUR = Number(fl('hour', '23'));
const BOXES = (fl('boxes', 'paleA:855,455,45,18|paleB:350,455,25,18|darkA:430,455,45,18|sky:800,20,300,40'))
  .split('|').filter(Boolean).map((t) => { const [n, b] = t.split(':'); return { n, b: b.split(',').map(Number) }; });

await mkdir(`${ROOT}/qa/logan/shots`, { recursive: true });
const nonce = `${Date.now()}-lights`;
await writeFile(`${ROOT}/${OUTDIR}/qa-build-id.txt`, nonce);
const srv = spawn('npx', ['vite', 'preview', '--port', String(PORT), '--strictPort', '--outDir', OUTDIR],
  { cwd: ROOT, stdio: 'ignore', env: { ...process.env, VITE_BASE: '/' } });
let owned = false;
for (let i = 0; i < 200; i++) {
  try {
    const r = await fetch(`http://localhost:${PORT}/qa-build-id.txt`);
    if (r.ok) { if ((await r.text()).trim() === nonce) { owned = true; break; } srv.kill(); throw new Error('another build'); }
  } catch (e) { if (String(e.message).includes('another build')) throw e; }
  await new Promise((r) => setTimeout(r, 250));
}
if (!owned) { srv.kill(); throw new Error('preview server never came up'); }

const b = await puppeteer.launch({
  headless: true, protocolTimeout: 900000, timeout: 180000,
  args: ['--no-sandbox', '--enable-gpu', '--use-angle=metal', '--ignore-gpu-blocklist',
    '--enable-webgl', '--window-size=1600,900', '--hide-scrollbars'],
});
const p = await b.newPage();
await p.setViewport({ width: 1600, height: 900, deviceScaleFactor: 1 });
await p.evaluateOnNewDocument(() => {
  try { localStorage.setItem('bh-onboarded', '1'); localStorage.removeItem('bh-res'); } catch { /* ignore */ }
});
await p.goto(`http://localhost:${PORT}/?q=${TIER}`, { waitUntil: 'networkidle2', timeout: 240000 });
await p.waitForFunction('window.__ready === true', { timeout: 300000 });
if (!await p.evaluate(() => !!window.__boston)) { await b.close(); srv.kill(); throw new Error('no app'); }

const vps = JSON.parse(await readFile(`${ROOT}/qa/viewpoints.json`, 'utf8'));
const vp = vps.find((v) => v.id === VIEW);
await p.evaluate((v, hh) => { window.__debug.setTime(hh); window.__debug.setView(v.pos, v.target); }, vp, HOUR);
await new Promise((r) => setTimeout(r, 3500));

const L = (d, i) => 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
async function settle(n = 60) {
  await p.evaluate((k) => window.__debug.settle(k), n);
  await new Promise((r) => setTimeout(r, 350));
  await p.evaluate((k) => window.__debug.settle(k), 25);
}
async function shot(name) {
  const buf = await p.screenshot({ type: 'png' });
  if (name) await writeFile(`${ROOT}/qa/logan/shots/${VIEW}--${name}.png`, buf);
  return PNG.sync.read(buf);
}
function rgbBox(img, bx) {
  let r = 0, g = 0, bl = 0, n = 0, s2 = 0;
  for (let y = bx[1]; y < Math.min(bx[1] + bx[3], img.height); y++) {
    for (let x = bx[0]; x < Math.min(bx[0] + bx[2], img.width); x++) {
      const i = (y * img.width + x) * 4; r += img.data[i]; g += img.data[i + 1]; bl += img.data[i + 2];
      const l = L(img.data, i); s2 += l * l; n++;
    }
  }
  r /= n; g /= n; bl /= n;
  const mu = 0.2126 * r + 0.7152 * g + 0.0722 * bl;
  return { mu, sd: Math.sqrt(Math.max(0, s2 / n - mu * mu)), r, g, b: bl };
}
async function measure(tag) {
  await settle(45);
  const img = await shot(tag);
  const out = {};
  for (const r of BOXES) { const s = rgbBox(img, r.b); out[r.n] = +s.mu.toFixed(1); }
  return out;
}
async function measureRgb() {
  await settle(45);
  const img = await shot(null);
  const out = {};
  for (const r of BOXES) { const s = rgbBox(img, r.b); out[r.n] = `${s.r.toFixed(0)}/${s.g.toFixed(0)}/${s.b.toFixed(0)}`; }
  return out;
}

await settle(120);
const pr = await p.evaluate(() => window.__debug.probe());
console.log(`[probe] exp=${pr.exposure.toFixed(4)} sunInt=${pr.sunIntensity.toFixed(4)} elev=${pr.sunElevation.toFixed(4)}`);
const base = await measure('h23-lights-base');
console.log('[base]', JSON.stringify(base));

// ---- inventory ------------------------------------------------------------
const inv = await p.evaluate(() => {
  const scene = window.__boston.ctx.scene;
  const path = (o) => { const a = []; for (let q = o; q && q !== scene; q = q.parent) a.unshift(o === q ? (q.name || q.type) : (q.name || q.type)); return a.join('/'); };
  const lights = [];
  const skyKids = [];
  const airport = [];
  scene.traverse((o) => {
    if (o.isLight) {
      lights.push({
        p: path(o), type: o.type, intensity: o.intensity,
        color: o.color ? o.color.getHexString() : null,
        ground: o.groundColor ? o.groundColor.getHexString() : null,
        visible: o.visible, layers: o.layers.mask,
      });
    }
    if (/air|runway|taxi|apron|logan/i.test(o.name || '')) {
      const m = Array.isArray(o.material) ? o.material[0] : o.material;
      airport.push({ p: path(o), type: o.type, mat: m ? (m.name || '(unnamed)') + ':' + m.type : null });
    }
  });
  const skyGroup = scene.children.find((c) => c.name === 'sky');
  if (skyGroup) {
    skyGroup.traverse((o) => {
      const m = Array.isArray(o.material) ? o.material[0] : o.material;
      skyKids.push({
        p: path(o), type: o.type, isMesh: !!o.isMesh, isLight: !!o.isLight,
        mat: m ? `${m.name || '(unnamed)'}:${m.type}` : null,
        renderOrder: o.renderOrder, depthWrite: m ? m.depthWrite : null,
        side: m ? m.side : null,
      });
    });
  }
  return { lights, skyKids, airport: airport.slice(0, 40), airportCount: airport.length };
});
console.log('[lights]');
for (const l of inv.lights) console.log(`  ${l.p} ${l.type} i=${l.intensity} c=${l.color} g=${l.ground} vis=${l.visible} layers=${l.layers}`);
console.log('[sky group tree]');
for (const s of inv.skyKids) console.log(`  ${s.p} ${s.type} mesh=${s.isMesh} light=${s.isLight} mat=${s.mat} ro=${s.renderOrder} dw=${s.depthWrite} side=${s.side}`);
console.log(`[airport-ish objects] ${inv.airportCount}`);
for (const a of inv.airport) console.log(`  ${a.p} ${a.type} ${a.mat}`);

// ---- pick at the pale pixel ----------------------------------------------
// `__debug.pick` clamps ray.far to 40000, so anything further than 40 km --
// including a sky dome -- is invisible to it. Raycast again with no far limit.
const picks = await p.evaluate(() => {
  const THREE = window.__THREE;
  const ctx = window.__boston.ctx;
  const el = ctx.renderer.domElement;
  const deep = (x, y) => {
    const ndc = new THREE.Vector2((x / el.clientWidth) * 2 - 1, -(y / el.clientHeight) * 2 + 1);
    const ray = new THREE.Raycaster();
    ray.near = 0.1; ray.far = Infinity;
    ray.setFromCamera(ndc, ctx.camera);
    ctx.camera.updateMatrixWorld(true);
    return ray.intersectObject(ctx.scene, true).slice(0, 8).map((h) => {
      const o = h.object; const m = Array.isArray(o.material) ? o.material[0] : o.material;
      let nm = o.name; for (let q = o.parent; q && !nm; q = q.parent) nm = q.name ? q.name + ' (child)' : '';
      return `${nm || '(unnamed)'}|${o.type}|d=${Math.round(h.distance)}|${m ? (m.name || '(unnamed mat)') + ':' + m.type : 'nomat'}`;
    });
  };
  const b = ctx.terrainBounds;
  return {
    shallowPale: window.__debug.pick(877, 464, 8),
    deepPale: deep(877, 464),
    deepDark: deep(452, 464),
    terrainBounds: b,
    heights: {
      'logan 4400,-500': ctx.sampleHeight(4400, -500),
      'logan 4700,-900': ctx.sampleHeight(4700, -900),
      'downtown 0,0': ctx.sampleHeight(0, 0),
    },
    camera: ctx.camera.position.toArray().map((v) => Math.round(v)),
  };
});
console.log('[pick shallow paleA 877,464]', JSON.stringify(picks.shallowPale));
console.log('[raycast far=inf paleA]', JSON.stringify(picks.deepPale, null, 0));
console.log('[raycast far=inf darkA]', JSON.stringify(picks.deepDark, null, 0));
console.log('[terrainBounds]', JSON.stringify(picks.terrainBounds), 'heights', JSON.stringify(picks.heights));

// ---- test: kill each light ------------------------------------------------
const nLights = inv.lights.length;
for (let i = 0; i < nLights; i++) {
  const info = await p.evaluate((idx) => {
    const scene = window.__boston.ctx.scene;
    const ls = []; scene.traverse((o) => { if (o.isLight) ls.push(o); });
    const l = ls[idx]; window.__save = { l, i: l.intensity }; l.intensity = 0; return l.type;
  }, i);
  const m = await measure(null);
  console.log(`  light#${i} ${info} intensity->0  ${JSON.stringify(m).replace(/"/g, '')}`);
  await p.evaluate(() => { window.__save.l.intensity = window.__save.i; });
}

// ---- test: null the IBL ---------------------------------------------------
await p.evaluate(() => { const s = window.__boston.ctx.scene; window.__env = s.environment; s.environment = null; });
console.log('  scene.environment=null  ' + JSON.stringify(await measure(null)).replace(/"/g, ''));
await p.evaluate(() => { window.__boston.ctx.scene.environment = window.__env; });

// ---- test: kill the street-lamp irradiance -------------------------------
const lampBefore = await p.evaluate(() => {
  const sky = window.__boston.get ? window.__boston.get('Sky') : null;
  const u = window.__boston.ctx.aerial;
  if (!u) return 'no ctx.aerial';
  window.__lamp = u.uApLampStrength.value; u.uApLampStrength.value = 0;
  void sky; return `lampStrength was ${window.__lamp}`;
});
console.log(`  uApLampStrength->0 (${lampBefore})  ` + JSON.stringify(await measure(null)).replace(/"/g, ''));
await p.evaluate(() => { const u = window.__boston.ctx.aerial; if (u) u.uApLampStrength.value = window.__lamp; });

// ---- test: kill aerial inscatter -----------------------------------------
await p.evaluate(() => { const u = window.__boston.ctx.aerial; if (u) { window.__ins = u.uApInscatterGain.value; u.uApInscatterGain.value = 0; } });
console.log('  uApInscatterGain->0  ' + JSON.stringify(await measure(null)).replace(/"/g, ''));
await p.evaluate(() => { const u = window.__boston.ctx.aerial; if (u) u.uApInscatterGain.value = window.__ins; });

// ---- test: tint every mesh under the sky group magenta -------------------
const tinted = await p.evaluate(() => {
  const scene = window.__boston.ctx.scene;
  const sky = scene.children.find((c) => c.name === 'sky');
  let n = 0; const hit = [];
  sky.traverse((o) => {
    const ms = Array.isArray(o.material) ? o.material : (o.material ? [o.material] : []);
    for (const m of ms) {
      if (m.color) { m.color.setRGB(1, 0, 1); n++; hit.push(`${o.name || o.type}:${m.name || '(unnamed)'}:${m.type}`); }
      if (m.uniforms) {
        for (const k of Object.keys(m.uniforms)) {
          if (/color|tint/i.test(k) && m.uniforms[k].value && m.uniforms[k].value.isColor) { m.uniforms[k].value.setRGB(1, 0, 1); n++; hit.push(`${o.name}:u.${k}`); }
        }
      }
    }
  });
  return { n, hit };
});
console.log(`  sky meshes tinted magenta (${tinted.n}): ${tinted.hit.join(', ')}`);
console.log('    luma ' + JSON.stringify(await measure('h23-lights-skymagenta')).replace(/"/g, ''));
console.log('    rgb  ' + JSON.stringify(await measureRgb()).replace(/"/g, ''));

await b.close();
srv.kill();
