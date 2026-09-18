/**
 * True peak heap of the road pipeline, measured from V8's own GC trace.
 *
 * `qa/_roadnet.mjs` reports `heapUsed` at the end of a phase minus `heapUsed`
 * at the start. That was a faithful proxy while the pass allocated so much
 * that no major GC could keep up -- the predecessor's 195.8 MB was reproducible
 * to the decimal. It stops being faithful once the allocation drops: a major
 * GC landing mid-pass reclaims ~50 MB, `heapUsed` at the end comes in below
 * the real high-water mark, and readings go bimodal (49.6 / 101.8 / 101.9 /
 * 109.7 / 49.6 MB on five consecutive runs of the same build).
 *
 * The peak is what iOS kills the tab on, so measure the peak. `--trace-gc`
 * prints the heap immediately before and after every collection:
 *
 *   [pid:0x..]  123 ms: Scavenge 91.2 (120.5) -> 60.1 (121.5) MB, 1.2 / 0.0 ms
 *                                ^^^^ heap used before this GC
 *
 * V8 collects when it hits its allocation limit, so the high-water mark is
 * always just before some collection; the largest pre-GC figure in the trace
 * is that mark. This is independent of *which* collections happen to fire,
 * which is exactly the run-to-run variable that made the endpoint unusable.
 *
 *   node qa/_roadpeak.mjs [--base] [-n 3]
 */
import { spawnSync } from 'node:child_process';

const ROOT = '/Volumes/Projects/bos';
const BASE = process.argv.includes('--base');
const ni = process.argv.indexOf('-n');
const RUNS = ni > 0 ? Number(process.argv[ni + 1]) : 3;

// "Scavenge 91.2 (120.5) -> 60.1 (121.5) MB" -- pre-GC used, pre-GC total,
// post-GC used, post-GC total.
const LINE = /:\s+\S+[^:]*?\s(\d+(?:\.\d+)?)\s\((\d+(?:\.\d+)?)\)\s*->\s*(\d+(?:\.\d+)?)\s\((\d+(?:\.\d+)?)\)\s*MB/;

const peaks = [];
const totals = [];
for (let i = 0; i < RUNS; i++) {
  const r = spawnSync('node', [
    '--expose-gc', '--trace-gc', `${ROOT}/qa/_roadnet.mjs`, ...(BASE ? ['--base'] : []),
  ], { cwd: ROOT, encoding: 'utf8', maxBuffer: 1 << 28 });
  let peak = 0;
  let total = 0;
  for (const line of (r.stdout + r.stderr).split('\n')) {
    const m = LINE.exec(line);
    if (!m) continue;
    peak = Math.max(peak, Number(m[1]));
    total = Math.max(total, Number(m[2]));
  }
  if (!peak) {
    console.error('no GC trace parsed; sample line follows');
    console.error((r.stdout + r.stderr).split('\n').slice(0, 6).join('\n'));
    process.exit(1);
  }
  peaks.push(peak);
  totals.push(total);
}

const f = (a) => a.map((v) => v.toFixed(1)).join('  ');
const min = (a) => Math.min(...a).toFixed(1);
const max = (a) => Math.max(...a).toFixed(1);
console.log(`${BASE ? 'base' : 'head'}  peak heap used  ${f(peaks)}   [min ${min(peaks)} max ${max(peaks)}]`);
console.log(`${BASE ? 'base' : 'head'}  peak heap total ${f(totals)}   [min ${min(totals)} max ${max(totals)}]`);
