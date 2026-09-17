/**
 * TEMPORARY boot-heap probe. Remove before commit.
 *
 * Prints the live heap at a named step. Works in the browser (`?roadmem=1`,
 * `performance.memory`) and under Node (`ROADMEM=1`, `process.memoryUsage`),
 * because the browser's sampler runs at 120-150 ms and the whole topology
 * pass is 362 ms -- a sampled curve can name the module but not the step.
 */
declare const process: { env: Record<string, string | undefined>; memoryUsage(): { heapUsed: number } } | undefined;

const inBrowser = typeof location !== 'undefined';
const on = inBrowser
  ? /(\?|&)roadmem=1/.test(location.search)
  : typeof process !== 'undefined' && !!process?.env?.ROADMEM;

let last = 0;
export function mem(step: string, extra = ''): void {
  if (!on) return;
  let bytes = 0;
  if (inBrowser) {
    const perf = performance as unknown as { memory?: { usedJSHeapSize: number } };
    bytes = perf.memory?.usedJSHeapSize ?? 0;
  } else {
    bytes = process?.memoryUsage().heapUsed ?? 0;
  }
  const mb = bytes / 1048576;
  const d = last ? mb - last : 0;
  last = mb;
  const sign = d >= 0 ? '+' : '';
  console.info(`[RoadMem] ${mb.toFixed(1)} MB  ${sign}${d.toFixed(1)}  ${step} ${extra}`);
}
