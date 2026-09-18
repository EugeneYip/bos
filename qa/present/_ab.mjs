/**
 * Run one A/B through the guard in qa/present/harness.mjs.
 *
 *   A=dist-x B=dist-y POSE=boot-default node qa/present/_ab.mjs
 *   A=live   B=dist-y node qa/present/_ab.mjs
 *   SELFTEST=1 A=dist-x node qa/present/_ab.mjs
 *
 * SELFTEST compares a build against itself. Every metric must come back
 * 'not resolvable'. If it reports a finding there, the guard is broken and
 * nothing it says about a real change means anything.
 */
import fs from 'node:fs';
import * as H from './harness.mjs';

const POSE = process.env.POSE || 'boot-default';
const LOADS = Number(process.env.LOADS || 3);   // independent page loads per arm
const N = Number(process.env.N || 3);           // frames averaged within one load
const GAP = Number(process.env.GAP || 90);
const SELFTEST = !!process.env.SELFTEST;
const A = process.env.A || 'live';
const B = SELFTEST ? A : (process.env.B || 'live');

const views = JSON.parse(fs.readFileSync('/Volumes/Projects/bos/qa/viewpoints.json', 'utf8'));
const v = (Array.isArray(views) ? views : views.viewpoints).find((z) => z.id === POSE);
if (!v) throw new Error(`no viewpoint ${POSE}`);

const browser = await H.launchBrowser();
const servers = [];
async function arm(label, outDir, port) {
  let url = H.SITE_LIVE;
  if (outDir !== 'live') { const s = await H.serve(outDir, port); servers.push(s.srv); url = s.url; }
  const pg = await H.open(browser, url, { query: process.env.QUERY || '' });
  await pg.evaluate((p) => { window.__debug.setTime(p.hour); window.__debug.setView(p.pos, p.target); }, v);
  const fp = await H.converge(pg);
  const ens = await H.ensemble(pg, { n: N, gap: GAP });
  fs.mkdirSync('/Volumes/Projects/bos/qa/present/shots', { recursive: true });
  fs.writeFileSync(`/Volumes/Projects/bos/qa/present/shots/ab-${label}--${POSE}.png`, await pg.screenshot());
  await pg.close();
  return { fp, ...ens };
}

async function armRepeat(label, outDir, basePort) {
  const loads = [];
  for (let i = 0; i < LOADS; i++) loads.push(await arm(`${label}${i}`, outDir, basePort + i * 4));
  return H.pool(loads);
}
const a = await armRepeat('A', A, 4520);
const b = await armRepeat('B', B, 4540);
console.log(`pose ${POSE}   A=${A}  B=${B}${SELFTEST ? '   [SELFTEST: everything must be "not resolvable"]' : ''}`);
console.log(`${LOADS} independent loads per arm, ${N} frames averaged within each`);
const res = H.compare(a, b);
for (const l of res.lines) console.log('  ' + l);
if (SELFTEST) {
  const found = res.lines.filter((l) => l.includes('RESOLVED'));
  console.log(found.length
    ? `SELFTEST FAILED: the guard resolved ${found.length} difference(s) between a build and itself.`
    : 'SELFTEST PASSED: no metric resolved against itself.');
}
await browser.close();
for (const s of servers) s.kill();
