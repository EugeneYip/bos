#!/usr/bin/env node
/**
 * Boston Common's shaded lawn: where its light is (and is not) coming from.
 *
 * Reports the `park:grass` material's indirect-lighting wiring, then runs a
 * series of single-uniform A/B arms in ONE page — so the auto-exposure and
 * the tree sway are the only things that can differ between them, and the
 * exposure is read out for each arm so even that can be divided back out.
 *
 *   QA_PORT=4431 QA_OUTDIR=dist-p node qa/_lawn.mjs [--tier ultra] [--view common-street]
 */
import { spawn } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer';
import { PNG } from 'pngjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.QA_PORT || 4431);
const OUTDIR = process.env.QA_OUTDIR || 'dist-p';
const argv = process.argv.slice(2);
const flag = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : d; };
const TIER = flag('tier', 'ultra');
const VIEW = flag('view', 'common-street');
const TAG = flag('tag', '');
const ARMS = (flag('arms', 'base') || 'base').split(',');
/**
 * Named boxes to measure. The first is the region the critic quoted, which
 * sits in the bottom-left corner — i.e. in the deepest part of the lens
 * vignette. `mid` is the same lawn at the centre of the frame, where the
 * vignette is ~1, and is the honest number for the material itself.
 */
const REGIONS = (flag('regions',
  'crit:100,640,400,200|mid:640,700,320,140|sun:820,548,140,26|sky:1050,30,60,40'))
  .split('|').map((t) => {
    const [name, box] = t.split(':');
    return { name, box: box.split(',').map(Number) };
  });

async function startServer() {
  const p = spawn('npx', ['vite', 'preview', '--port', String(PORT), '--strictPort', '--outDir', OUTDIR], {
    cwd: ROOT, stdio: 'pipe', env: { ...process.env, VITE_BASE: '/' },
  });
  p.stdout.on('data', () => {}); p.stderr.on('data', () => {});
  for (let i = 0; i < 200; i++) {
    try { const r = await fetch(`http://localhost:${PORT}/`); if (r.ok) return p; } catch { /* waiting */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  p.kill(); throw new Error('preview server did not start');
}

const server = await startServer();
const browser = await puppeteer.launch({
  headless: true, protocolTimeout: 900000,
  args: ['--no-sandbox', '--enable-gpu', '--use-angle=metal', '--enable-unsafe-swiftshader',
    '--ignore-gpu-blocklist', '--enable-webgl', '--window-size=1600,900', '--hide-scrollbars'],
});
const page = await browser.newPage();
await page.setViewport({ width: 1600, height: 900, deviceScaleFactor: 1 });
const errs = [];
page.on('pageerror', (e) => errs.push(String(e)));
await page.evaluateOnNewDocument(() => {
  try { localStorage.setItem('bh-onboarded', '1'); localStorage.removeItem('bh-res'); } catch { /* */ }
});
await page.goto(`http://localhost:${PORT}/?q=${TIER}`, { waitUntil: 'networkidle2', timeout: 240000 });
await page.waitForFunction('window.__ready === true', { timeout: 300000 });

const vps = JSON.parse(await readFile(path.join(ROOT, 'qa/viewpoints.json'), 'utf8'));
const vp = vps.find((v) => v.id === VIEW);
await page.evaluate((h) => window.__debug.setTime(h), vp.hour);
await page.evaluate((p, t) => window.__debug.setView(p, t), vp.pos, vp.target);
await new Promise((r) => setTimeout(r, 6000));
await page.evaluate(() => window.__debug.settle(90));

/* ------------------------------------------------------------- wiring -- */
const wiring = await page.evaluate(() => {
  const ctx = window.__boston.ctx;
  const out = { scene: {}, mats: [] };
  out.scene = {
    environmentBound: ctx.scene.environment !== null,
    environmentIntensity: ctx.scene.environmentIntensity,
    ctxEnvMapBound: !!ctx.envMap,
    sameObject: ctx.scene.environment === ctx.envMap,
    exposure: ctx.exposure,
    sunIntensity: ctx.sun?.intensity,
    sunElevation: ctx.sun?.elevation,
  };
  const seen = new Set();
  ctx.scene.traverse((o) => {
    const ms = Array.isArray(o.material) ? o.material : (o.material ? [o.material] : []);
    for (const m of ms) {
      if (!m || seen.has(m.uuid)) continue;
      if (!/^park:|^veg:|^vegetation/.test(m.name || '')) continue;
      seen.add(m.uuid);
      const u = m.userData?.shader?.uniforms ?? {};
      out.mats.push({
        name: m.name,
        envMapOwn: !!m.envMap,
        envMapIntensity: m.envMapIntensity,
        aoMapIntensity: m.aoMapIntensity,
        lightMapIntensity: m.lightMapIntensity,
        defines: Object.keys(m.defines || {}),
        uSky: u.uSky?.value,
        uCanopy: u.uCanopy?.value,
        compiled: !!m.userData?.shader,
      });
    }
  });
  out.mats.sort((a, b) => a.name.localeCompare(b.name));
  return out;
});
console.log('[wiring]', JSON.stringify(wiring, null, 1));

/* --------------------------------------------------------------- arms -- */
function regionStats(buf, w, h, [x0, y0, rw, rh]) {
  let r = 0, g = 0, b = 0, n = 0, minB = 255, maxB = 0;
  for (let y = y0; y < Math.min(y0 + rh, h); y++) {
    for (let x = x0; x < Math.min(x0 + rw, w); x++) {
      const i = (y * w + x) * 4;
      r += buf[i]; g += buf[i + 1]; b += buf[i + 2]; n++;
      if (buf[i + 2] < minB) minB = buf[i + 2];
      if (buf[i + 2] > maxB) maxB = buf[i + 2];
    }
  }
  return {
    r: +(r / n).toFixed(2), g: +(g / n).toFixed(2), b: +(b / n).toFixed(2),
    luma: +((0.2126 * r + 0.7152 * g + 0.0722 * b) / n).toFixed(2),
    bMin: minB, bMax: maxB,
  };
}

// Helpers live in the page: puppeteer serialises each arm's source, so an
// arm that closed over a node-side function would throw a ReferenceError.
await page.evaluate(() => {
  window.__setU = (re, name, val) => {
    window.__boston.ctx.scene.traverse((o) => {
      const ms = Array.isArray(o.material) ? o.material : (o.material ? [o.material] : []);
      for (const m of ms) {
        if (!m || !new RegExp(re).test(m.name || '')) continue;
        const u = m.userData && m.userData.shader && m.userData.shader.uniforms;
        if (u && u[name]) u[name].value = val;
      }
    });
  };
  window.__setV = (re, name, xyz) => {
    window.__boston.ctx.scene.traverse((o) => {
      const ms = Array.isArray(o.material) ? o.material : (o.material ? [o.material] : []);
      for (const m of ms) {
        if (!m || !new RegExp(re).test(m.name || '')) continue;
        const u = m.userData && m.userData.shader && m.userData.shader.uniforms;
        if (u && u[name]) u[name].value.set(xyz[0], xyz[1], xyz[2]);
      }
    });
  };
  // Bind the shared IBL to the park materials so their own envMapIntensity is
  // honoured; 0 unbinds, which puts them back on scene.environmentIntensity.
  window.__parkEnv = (i) => {
    const ctx = window.__boston.ctx;
    ctx.scene.traverse((o) => {
      const ms = Array.isArray(o.material) ? o.material : (o.material ? [o.material] : []);
      for (const m of ms) {
        if (!m || !/^park:/.test(m.name || '')) continue;
        m.envMap = i > 0 ? ctx.envMap : null;
        if (i > 0) m.envMapIntensity = i;
        m.needsUpdate = true;
      }
    });
  };
  window.__post = (k, v) => window.__boston.get('Post') && window.__boston.get('Post').apply({ key: k, value: v });
});

const arms = {
  base: { on: () => {}, off: () => {} },
  // Far impostors: the two un-occluded additions to their indirect term.
  farcan0: { on: () => window.__setU('veg:.*:far:leaf', 'uCanopy', 0),
    off: () => window.__setU('veg:.*:far:leaf', 'uCanopy', 0.26) },
  farcan13: { on: () => window.__setU('veg:.*:far:leaf', 'uCanopy', 0.13),
    off: () => window.__setU('veg:.*:far:leaf', 'uCanopy', 0.26) },
  fartrans0: { on: () => window.__setU('veg:.*:far:leaf', 'uTransAmount', 0),
    off: () => window.__setU('veg:.*:far:leaf', 'uTransAmount', 1.25) },
  fartrans6: { on: () => window.__setU('veg:.*:far:leaf', 'uTransAmount', 0.6),
    off: () => window.__setU('veg:.*:far:leaf', 'uTransAmount', 1.25) },
  farboth: { on: () => { window.__setU('veg:.*:far:leaf', 'uCanopy', 0.1);
    window.__setU('veg:.*:far:leaf', 'uTransAmount', 0.6); },
  off: () => { window.__setU('veg:.*:far:leaf', 'uCanopy', 0.26);
    window.__setU('veg:.*:far:leaf', 'uTransAmount', 1.25); } },
  hue60: { on: () => window.__setU('veg:.*:leaf', 'uHueVar', 0.6),
    off: () => window.__setU('veg:.*:leaf', 'uHueVar', 0.3) },
  notrees2: { on: () => { window.__debug.toggle('trees:', false); },
    off: () => { window.__debug.toggle('trees:', true); } },
  pe15: { on: () => window.__parkEnv(1.5), off: () => window.__parkEnv(0) },
  pe20: { on: () => window.__parkEnv(2.0), off: () => window.__parkEnv(0) },
  pe25: { on: () => window.__parkEnv(2.5), off: () => window.__parkEnv(0) },
  pe30: { on: () => window.__parkEnv(3.0), off: () => window.__parkEnv(0) },
  pe20s0: { on: () => { window.__parkEnv(2.0); window.__setU('^park:', 'uSky', 0); },
    off: () => { window.__parkEnv(0); window.__setU('^park:', 'uSky', 0.55); } },
  pe20n: { on: () => { window.__parkEnv(2.0); window.__setV('^park:', 'uSkyTint', [1, 1, 1]); },
    off: () => { window.__parkEnv(0); window.__setV('^park:', 'uSkyTint', [0.8, 1, 0.74]); } },
  sky09: { on: () => window.__setU('^park:', 'uSky', 0.9), off: () => window.__setU('^park:', 'uSky', 0.55) },
  sky12: { on: () => window.__setU('^park:', 'uSky', 1.2), off: () => window.__setU('^park:', 'uSky', 0.55) },
  sky16: { on: () => window.__setU('^park:', 'uSky', 1.6), off: () => window.__setU('^park:', 'uSky', 0.55) },
  sky22: { on: () => window.__setU('^park:', 'uSky', 2.2), off: () => window.__setU('^park:', 'uSky', 0.55) },
  // Old behaviour: the canopy tint applied at full strength everywhere.
  tintold: {
    on: () => window.__setV('^park:', 'uSkyTint', [0.8, 1.0, 0.74], true),
    off: () => window.__setV('^park:', 'uSkyTint', [0.8, 1.0, 0.74], false),
  },
  tint12: {
    on: () => { window.__setU('^park:', 'uSky', 1.2); window.__setV('^park:', 'uSkyTint', [0.8, 1.0, 0.74], false); },
    off: () => window.__setU('^park:', 'uSky', 0.55),
  },
  nosky: { on: () => window.__setU('^park:', 'uSky', 0), off: () => window.__setU('^park:', 'uSky', 0.55) },
  sky4: { on: () => window.__setU('^park:', 'uSky', 4), off: () => window.__setU('^park:', 'uSky', 0.55) },
  nowear: { on: () => window.__setU('^park:', 'uWear', 0), off: () => window.__setU('^park:', 'uWear', 1) },
  nopatch: { on: () => window.__setU('^park:', 'uWear', 0), off: () => window.__setU('^park:', 'uWear', 1) },
  noenv: {
    on: () => { window.__boston.ctx.scene.environment = null; },
    off: () => { window.__boston.ctx.scene.environment = window.__boston.ctx.envMap; },
  },
  env3: {
    on: () => { window.__boston.ctx.scene.environmentIntensity = 3; },
    off: () => { window.__boston.ctx.scene.environmentIntensity = 1; },
  },
  notrees: {
    on: () => { window.__debug.toggle('trees:', false); },
    off: () => { window.__debug.toggle('trees:', true); },
  },
  noshadow: {
    on: () => { window.__debug.probe({ shadows: false }); },
    off: () => { window.__debug.probe({ shadows: true }); },
  },
  noao: { on: () => window.__post('ao', false), off: () => window.__post('ao', true) },
  // Reads the *illumination* straight off the lawn: white albedo, no wear,
  // no patchiness. Whatever colour the grass comes out is the colour of the
  // light arriving, with the material's own hue divided out.
  white: {
    on: () => {
      window.__setU('^park:', 'uWear', 0);
      window.__boston.ctx.scene.traverse((o) => {
        const ms = Array.isArray(o.material) ? o.material : (o.material ? [o.material] : []);
        for (const m of ms) {
          if (m && /^park:/.test(m.name || '')) { m.vertexColors = false; m.map = null; m.needsUpdate = true; }
        }
      });
    },
    off: () => {},
  },
  novig: { on: () => window.__post('vignette', false), off: () => window.__post('vignette', true) },
  nobloom: { on: () => window.__post('bloom', false), off: () => window.__post('bloom', true) },
};

const results = {};
for (const arm of ARMS) {
  if (!arms[arm]) { console.log('[skip] unknown arm', arm); continue; }
  await page.evaluate(arms[arm].on);
  await page.evaluate(() => window.__debug.settle(60));
  await new Promise((r) => setTimeout(r, 1200));
  await page.evaluate(() => window.__debug.settle(40));
  const png = await page.screenshot({ type: 'png' });
  const name = `${VIEW}--lawn-${arm}${TAG ? `-${TAG}` : ''}`;
  await writeFile(path.join(ROOT, `qa/shots/${name}.png`), png);
  const img = PNG.sync.read(png);
  const stats = {};
  for (const r of REGIONS) stats[r.name] = regionStats(img.data, img.width, img.height, r.box);
  const probe = await page.evaluate(() => window.__debug.probe());
  results[arm] = { stats, exposure: +probe.exposure.toFixed(4) };
  console.log('[arm]', arm, JSON.stringify(results[arm]));
  await page.evaluate(arms[arm].off);
  await page.evaluate(() => window.__debug.settle(30));
}

console.log('[errors]', errs.slice(0, 5));
await browser.close();
server.kill();
