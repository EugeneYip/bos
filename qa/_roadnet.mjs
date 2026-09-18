/**
 * Road-topology heap attribution and output digest, in Node rather than in a
 * browser.
 *
 * The browser probes sample `usedJSHeapSize` every 120-150 ms; the topology
 * pass is 362 ms end to end, so a sampled curve can name the module but never
 * the step. Worse, this machine routinely carries a load average in the
 * hundreds while several agents shoot at once, and a contended run drifts the
 * peak by more than the thing being measured -- `qa/_peakwho.mjs` timed out at
 * 300 s twice while this work was starting.
 *
 * So: run the real `buildNetwork` and the real chunk loop on the real shards
 * under the same V8, with `--expose-gc` so retained and transient can be told
 * apart. No renderer, no terrain, no other module. Counts and heap growth both
 * match the browser (32,849 / 11,630 / 36,755 and ~226 MB against +218), and
 * the total has no run-to-run spread at all.
 *
 *   node_modules/esbuild/bin/esbuild qa/roadmem/entry.ts --bundle --format=esm \
 *     --platform=node --external:three --outfile=qa/roadmem/entry.mjs
 *   ROADMEM=1 node --expose-gc qa/_roadnet.mjs
 *
 * `--digest` prints a hash over every number that reaches the geometry
 * builders instead, so a memory change can be shown not to have moved a
 * single vertex. `--base` runs `qa/roadmem/entry-base.mjs` -- the same entry
 * bundled from a pristine worktree -- so the two digests can be compared.
 * Rebuild the bundle after every source edit; it is not watched.
 */
import { readFileSync, readdirSync } from 'node:fs';

const ROOT = '/Volumes/Projects/bos';
const BASE = process.argv.includes('--base');
const DIGEST = process.argv.includes('--digest');
const mb = (b) => (b / 1048576).toFixed(1);
const heap = () => process.memoryUsage().heapUsed;
/** `gc()` leaves lazily-swept pages behind, so one call over-reports. */
const settle = () => { for (let i = 0; i < 6; i++) global.gc?.(); return heap(); };

const files = readdirSync(`${ROOT}/public/data`).filter((f) => /^roads-\d+\.json$/.test(f)).sort();
const h0 = settle();
let records = [];
for (const f of files) {
  const j = JSON.parse(readFileSync(`${ROOT}/public/data/${f}`, 'utf8'));
  for (const r of (Array.isArray(j) ? j : (j.roads ?? j.items ?? []))) records.push(r);
}
const hLoadRaw = heap();
const hLoad = settle();

const mod = await import(`${ROOT}/qa/roadmem/${BASE ? 'entry-base' : 'entry'}.mjs`);
const { buildNetwork, chunkPolyline, trimHead, reverse, junctionGeom } = mod;
const sample = () => 0;

const hBefore = settle();
const net = buildNetwork(records, sample, undefined);
const hRaw = heap();
const hAfter = settle();

const CHUNK = 165;
const VISIT = chunkPolyline.length >= 4;
const scratch = [];
const chunks = [];
const hB2 = settle();
for (const road of net.roads) {
  if (road.tunnel || road.pts.length < 2) continue;
  let pts = road.pts; let ys = road.ys;
  if (road.trimStart > 0.01) { const t = trimHead(pts, ys, road.trimStart); pts = t.pts; ys = t.ys; }
  if (road.trimEnd > 0.01 && pts.length > 1) {
    const r = reverse(pts, ys); const t = trimHead(r.pts, r.ys, road.trimEnd);
    const b = reverse(t.pts, t.ys); pts = b.pts; ys = b.ys;
  }
  if (pts.length < 2) continue;
  // `chunkPolyline` appends into a caller-owned array on HEAD and returns a
  // fresh one on base; `--base` has to keep measuring the shape base has.
  if (VISIT) {
    scratch.length = 0;
    chunkPolyline(pts, ys, CHUNK, scratch);
    for (const c of scratch) chunks.push(c);
  } else {
    for (const c of chunkPolyline(pts, ys, CHUNK)) chunks.push(c);
  }
}
const hRaw2 = heap();
const hAfter2 = settle();

if (DIGEST) {
  // FNV-1a over the raw bits of every double, so a change of one ULP shows.
  // -0 is folded to 0: it renders identically and only the sign bit differs.
  const view = new DataView(new ArrayBuffer(8));
  let h = 2166136261;
  const byte = (b) => { h = Math.imul(h ^ b, 16777619); };
  const n = (v) => { view.setFloat64(0, v === 0 ? 0 : v); for (let i = 0; i < 8; i++) byte(view.getUint8(i)); };
  const s = (v) => { const t = String(v); for (let i = 0; i < t.length; i++) byte(t.charCodeAt(i) & 255); };
  const pl = (p) => { n(p.length); for (const q of p) { n(q.x); n(q.z); } };
  const nl = (a) => { n(a.length); for (const v of a) n(v ?? 0); };

  for (const r of net.roads) {
    s(r.id); s(r.cls); s(r.surface); pl(r.pts); nl(r.ys);
    n(r.width); n(r.halfWidth); n(r.lanes); n(r.layer); n(r.length);
    n(r.trimStart); n(r.trimEnd); n(r.seed);
    s(`${r.oneway}${r.bridge}${r.tunnel}`);
  }
  for (const j of net.junctions) {
    n(j.p.x); n(j.p.z); n(j.y); n(j.layer); n(j.radius); n(j.maxWidth); n(j.seed);
    s(j.surface); s(String(j.painted));
    // `ring`/`corners` may be stored or may be derived on demand; either way
    // they are what the junction builders consume, so they are what is hashed.
    const g = junctionGeom ? junctionGeom(j) : j;
    pl(g.ring); nl(g.ringDy); nl(g.ringY);
    n(g.corners.length);
    for (const c of g.corners) { pl(c.pts); nl(c.ys); pl(c.normals); s(`${c.kerbed}`); n(c.walk); }
    n(j.approaches.length);
    for (const a of j.approaches) { s(a.road.id); n(a.end); n(a.dir.x); n(a.dir.z); n(a.halfWidth); n(a.angle); n(a.trim); n(a.y); }
  }
  for (const p of net.portals) { n(p.p.x); n(p.p.z); n(p.y); n(p.dir.x); n(p.dir.z); n(p.width); s(p.road.id); }
  for (const c of chunks) { pl(c.pts); nl(c.ys); n(c.length); n(c.mx); n(c.mz); }

  console.log(`${BASE ? 'base' : 'head'}  ways ${net.roads.length}  junctions ${net.junctions.length}  portals ${net.portals.length}  chunks ${chunks.length}  digest ${(h >>> 0).toString(16)}`);
} else {
  console.log(`records        ${records.length}  raw ${mb(hLoadRaw - h0)} MB  retained ${mb(hLoad - h0)} MB`);
  console.log(`buildNetwork   ${net.roads.length} ways, ${net.junctions.length} junctions, ${net.portals.length} portals`);
  console.log(`  raw growth   ${mb(hRaw - hBefore)} MB  <-- what sets the high-water mark`);
  console.log(`  retained     ${mb(hAfter - hBefore)} MB`);
  console.log(`chunks         ${chunks.length}`);
  console.log(`  raw growth   ${mb(hRaw2 - hB2)} MB`);
  console.log(`PIPELINE raw growth ${mb((hRaw - hBefore) + (hRaw2 - hB2))} MB   converged retained ${mb(hAfter2 - h0)} MB`);
  void records;
}
