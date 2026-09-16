#!/usr/bin/env node
/**
 * Cost of the whole Logan airport layer (pavement, markings, lights, bridges,
 * tower cab — everything named `airport:*`), measured the only way this
 * machine allows: one page session, alternating on/off, interleaved repeats,
 * medians (see qa/_ablayer.mjs, README's "Measurement discipline"). Does not
 * cover the aircraft instances (parked + ground fleet), which share the
 * existing `air:*` InstancedMesh pools and add no draw calls of their own.
 */
import { spawn } from 'node:child_process';
import puppeteer from 'puppeteer';

const PORT = 4572;
const srv = spawn('npx', ['vite', 'preview', '--port', String(PORT), '--strictPort', '--outDir', 'dist-qa'],
  { cwd: '/Volumes/Projects/bos', stdio: 'ignore', env: { ...process.env, VITE_BASE: '/' } });
for (let i = 0; i < 160; i++) { try { if ((await fetch(`http://localhost:${PORT}/`)).ok) break; } catch {} await new Promise((r) => setTimeout(r, 250)); }

const b = await puppeteer.launch({
  headless: true,
  args: ['--no-sandbox', '--enable-gpu', '--use-angle=metal', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--enable-webgl', '--window-size=1600,900'],
});
const pg = await b.newPage();
await pg.setViewport({ width: 1600, height: 900 });
await pg.evaluateOnNewDocument(() => { try { localStorage.setItem('bh-onboarded', '1'); } catch {} });
await pg.goto(`http://localhost:${PORT}/?q=high`, { waitUntil: 'networkidle2', timeout: 180000 });
await pg.waitForFunction('window.__ready === true', { timeout: 300000 });

await pg.evaluate(() => { window.__debug.setTime(12.8); window.__debug.setView([4010, 230, 640], [4650, 15, -820]); });
await pg.evaluate(() => window.__debug.settle(60));

const set = (on) => pg.evaluate((o) => window.__debug.toggle('airport', o), on);
const sample = async () => {
  await pg.evaluate(() => window.__debug.settle(90));
  return pg.evaluate(() => ({ fps: window.__boston.ctx.stats.fps, calls: window.__boston.ctx.renderer.info.render.calls }));
};

const REPS = 6;
const on = [], off = [], callsOn = [], callsOff = [];
for (let i = 0; i < REPS; i++) {
  await set(true); let s = await sample(); on.push(s.fps); callsOn.push(s.calls);
  await set(false); s = await sample(); off.push(s.fps); callsOff.push(s.calls);
}
await set(true);
const med = (a) => { const s = [...a].sort((x, y) => x - y); return s[s.length >> 1]; };
const mOn = med(on), mOff = med(off);
console.log(`logan-runway viewpoint, ${REPS} interleaved reps`);
console.log(`  with airport:    ${mOn} fps   [${on.join(',')}]`);
console.log(`  without airport: ${mOff} fps   [${off.join(',')}]`);
console.log(`  cost: ${(1000 / mOn - 1000 / mOff).toFixed(2)} ms/frame`);
console.log(`  draw calls: ${med(callsOn)} -> ${med(callsOff)} (airport draws = ${med(callsOn) - med(callsOff)})`);

await b.close();
srv.kill();
