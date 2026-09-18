/**
 * A/B harness for a scene that is never still.
 *
 * Written after three wrong conclusions in one session, all from the same
 * cause: comparing two single frames of a non-stationary scene.
 *
 *  - An `envMapIntensity` sweep read 0.93% / 1.69% / 0.38% / 0.26% for
 *    1.0 / 0.6 / 0.35 / 0.15. Non-monotonic, because `tris` was 7.0M in one
 *    arm and 10.6M in another: the arms had different numbers of buildings
 *    streamed in, and that moved the metric far more than the parameter did.
 *  - A crop from late in that sweep looked transformative and was reported as
 *    a fix. It was a different streaming and weather state.
 *  - Three changes were called inert on the strength of a bit-identical frame.
 *    Two genuinely were. One had never reached the build at all.
 *
 * So this module refuses to let a caller compare two frames. It:
 *   1. Converges the streaming set instead of settling a fixed frame count,
 *      and says so if it fails to converge.
 *   2. Records a scene fingerprint per arm and REFUSES the comparison when the
 *      arms do not match, because a delta across different geometry is not a
 *      measurement of anything.
 *   3. Measures every metric as an ensemble over spaced frames, and reports
 *      the standard deviation alongside the mean, so a delta can be tested
 *      against the noise it has to beat. Animation -- waves, wind, traffic,
 *      pedestrians -- moves 30-42% of pixels between frames at street level
 *      and 7% from the air, and none of it ever settles.
 */
import { spawn } from 'node:child_process';
import puppeteer from 'puppeteer';
import { PNG } from 'pngjs';

export const SITE_LIVE = 'https://eugeneyip.github.io/bos/';

export async function serve(outDir, port) {
  const srv = spawn('npx', ['vite', 'preview', '--port', String(port), '--strictPort', '--outDir', outDir],
    { cwd: '/Volumes/Projects/bos', stdio: 'ignore', env: { ...process.env, VITE_BASE: '/' } });
  const url = `http://localhost:${port}/`;
  for (let i = 0; i < 200; i++) {
    try { if ((await fetch(url)).ok) return { srv, url }; } catch {}
    await new Promise((r) => setTimeout(r, 250));
  }
  srv.kill();
  throw new Error(`vite preview never answered on ${port} for ${outDir}`);
}

export async function open(browser, url, { width = 1600, height = 900, dpr = 2, query = '' } = {}) {
  const pg = await browser.newPage();
  await pg.setViewport({ width, height, deviceScaleFactor: dpr });
  await pg.evaluateOnNewDocument(() => {
    try { localStorage.setItem('bh-onboarded', '1'); localStorage.removeItem('bh-safe'); localStorage.removeItem('bh-boot'); } catch {}
  });
  const missing = [];
  pg.on('response', (r) => { if (r.status() === 404) missing.push(r.url()); });
  await pg.goto(url + query, { waitUntil: 'domcontentloaded', timeout: 180000 });
  await new Promise((r) => setTimeout(r, 1200));
  // A build made without VITE_BASE=/ 404s every asset and sits on the boot
  // overlay forever, which is indistinguishable from a hang. Say so in a line.
  if (missing.some((u) => /\/bos\//.test(u))) {
    throw new Error('this build was made without VITE_BASE=/ -- every asset 404s under /bos/');
  }
  await pg.waitForFunction('window.__ready === true', { timeout: 420000, polling: 500 });
  return pg;
}

/**
 * What the scene IS, as distinct from what a frame happened to draw.
 *
 * `tris` is `renderer.info.render.triangles`, i.e. per-frame rendered
 * triangles after culling and LOD selection. Two loads of the same build at
 * the same pose settle at counts 25% apart while their building tile counts
 * match exactly -- so `tris` is a METRIC with a wide spread, not an identity,
 * and refusing a comparison on it refuses every comparison. Identity is the
 * structural content: how many tiles, geometries, trees and vehicles were
 * actually built.
 */
export async function fingerprint(pg) {
  return pg.evaluate(() => {
    const s = window.__debug.stats();
    const d = window.__debug.diag();
    return {
      // identity
      buildingTiles: s.buildingTiles ?? null, buildingShards: s.buildingShards ?? null,
      buildings: s.buildings ?? null, trees: s.trees ?? null, vehicles: s.vehicles ?? null,
      tier: d.tier, safeLevel: d.safeLevel, pixelRatio: d.pixelRatio,
      // informational only
      tris: s.tris, geometries: s.geometries ?? null,
    };
  });
}

/** The fields that must match. Everything else is reported, not enforced. */
const IDENTITY = ['buildingTiles', 'buildingShards', 'buildings', 'trees', 'tier', 'safeLevel', 'pixelRatio'];

/**
 * Settle until the streamed set stops growing, rather than for a fixed count.
 * Returns the fingerprint plus how it ended.
 */
export async function converge(pg, { step = 150, maxRounds = 14, tol = 0.004 } = {}) {
  let prev = null, rounds = 0;
  for (; rounds < maxRounds; rounds++) {
    await pg.evaluate((n) => window.__debug.settle(n), step);
    const fp = await fingerprint(pg);
    if (prev) {
      // Converge on the structural content, not on the rendered triangle
      // count -- that never stops moving, because the trees and the traffic
      // never stop moving.
      const same = IDENTITY.every((k) => fp[k] === prev[k]);
      if (same) return { ...fp, converged: true, rounds: rounds + 1 };
    }
    prev = fp;
  }
  return { ...prev, converged: false, rounds };
}

/** Pixel statistics for one frame. Add metrics here, not in callers. */
export function metrics(buf, { hudRows = 80, hudCols = 300 } = {}) {
  const img = PNG.sync.read(buf);
  const W = img.width, H = img.height, s = H / 900;
  const hud = (x, y) => (y > H - hudRows * s && x < hudCols * s) || (y > H - 60 * s);
  const band = (y0, y1) => {
    let n = 0, sum = 0, bright = 0, sat2 = 0;
    for (let y = Math.floor(H * y0); y < Math.floor(H * y1); y += 3)
      for (let x = 4; x < W - 4; x += 3) {
        if (hud(x, y)) continue;
        const i = (y * W + x) * 4, r = img.data[i], g = img.data[i + 1], b = img.data[i + 2];
        const L = 0.2126 * r + 0.7152 * g + 0.0722 * b;
        const sat = Math.max(r, g, b) - Math.min(r, g, b);
        n++; sum += L; sat2 += sat;
        if (L > 140 && sat < 26) bright++;
      }
    return { mean: sum / n, brightFlatPct: 100 * bright / n, sat: sat2 / n };
  };
  const sky = band(0.02, 0.30), mid = band(0.35, 0.60), fg = band(0.62, 0.96);
  return {
    skyMean: sky.mean, midMean: mid.mean, fgMean: fg.mean,
    midBrightFlatPct: mid.brightFlatPct, fgBrightFlatPct: fg.brightFlatPct,
    fgSat: fg.sat,
  };
}

/**
 * Capture `n` frames, `gap` frames apart, and reduce each metric to its mean
 * and standard deviation. The sd IS the result: it is the bar a delta has to
 * clear, and on this scene it is not small.
 */
export async function ensemble(pg, { n = 5, gap = 90 } = {}) {
  const rows = [];
  for (let i = 0; i < n; i++) {
    if (i) await pg.evaluate((g) => window.__debug.settle(g), gap);
    rows.push(metrics(await pg.screenshot()));
  }
  const out = {};
  for (const k of Object.keys(rows[0])) {
    const v = rows.map((r) => r[k]);
    const mean = v.reduce((a, b) => a + b, 0) / v.length;
    const sd = Math.sqrt(v.reduce((a, b) => a + (b - mean) ** 2, 0) / v.length);
    out[k] = { mean, sd };
  }
  return { n, gap, m: out, frames: rows };
}

/**
 * Reduce several INDEPENDENT loads of one build to a mean and sd per metric.
 *
 * This, not `ensemble`, is the noise that matters. Five frames from a single
 * page load with a static camera are near-identical, so their sd is 0.01-0.05
 * -- and a self-test against the same build then 'resolved' four metrics,
 * because the real run-to-run offset between two loads is larger than that.
 * The spread that a claimed improvement has to beat is the spread between
 * loads, so measure that and use it as the bar.
 */
export function pool(loads) {
  const out = {};
  for (const k of Object.keys(loads[0].m)) {
    const v = loads.map((l) => l.m[k].mean);
    const mean = v.reduce((a, b) => a + b, 0) / v.length;
    const sd = v.length > 1
      ? Math.sqrt(v.reduce((a, b) => a + (b - mean) ** 2, 0) / (v.length - 1))
      : NaN;
    out[k] = { mean, sd, values: v };
  }
  return { n: loads.length, m: out, fp: loads[0].fp, fps: loads.map((l) => l.fp) };
}

/**
 * Compare two arms. Refuses when the scenes differ, and reports every metric
 * against the between-load noise rather than as a bare delta.
 */
export function compare(a, b, { tolTris = 0.02 } = {}) {
  const lines = [];
  const fa = a.fp, fb = b.fp;
  const differ = IDENTITY.filter((k) => fa[k] !== fb[k]);
  const fmt = (f) => `tiles ${f.buildingTiles} shards ${f.buildingShards} bldgs ${f.buildings} `
    + `trees ${f.trees} tier ${f.tier} safe ${f.safeLevel} dpr ${f.pixelRatio} `
    + `| tris ${f.tris} converged ${f.converged}`;
  lines.push(`scene A  ${fmt(fa)}`);
  lines.push(`scene B  ${fmt(fb)}`);
  if (differ.length) {
    lines.push(`REFUSED: the arms are not the same scene -- ${differ.map((k) => `${k} ${fa[k]} vs ${fb[k]}`).join(', ')}.`);
    lines.push('A delta measured across different content is not a measurement. Re-run.');
    return { ok: false, lines };
  }
  if (fa.tris > 0) {
    const td = Math.abs(fa.tris - fb.tris) / fa.tris;
    if (td > 0.05) lines.push(`note: rendered triangles differ by ${(100 * td).toFixed(1)}% `
      + '(LOD and culling, not content) -- expect wide metric spread.');
  }
  if (!fa.converged || !fb.converged) {
    lines.push('WARNING: at least one arm never converged; treat everything below as provisional.');
  }
  if (a.n < 2 || b.n < 2) {
    lines.push('REFUSED: fewer than two independent loads per arm, so there is no');
    lines.push('noise estimate and no delta can be called real. Use LOADS>=3.');
    return { ok: false, lines };
  }
  for (const k of Object.keys(a.m)) {
    const A = a.m[k], B = b.m[k];
    const d = B.mean - A.mean;
    // Between-load sd, pooled, then a two-sample bar at roughly 95%.
    const pooled = Math.sqrt((A.sd ** 2 + B.sd ** 2) / 2);
    const bar = 2 * pooled * Math.sqrt(2 / a.n);
    const verdict = Math.abs(d) > bar ? 'RESOLVED' : 'not resolvable';
    lines.push(`${k.padEnd(18)} ${A.mean.toFixed(2)} -> ${B.mean.toFixed(2)}  d ${d >= 0 ? '+' : ''}${d.toFixed(2)}`
      + `  sd ${A.sd.toFixed(2)}/${B.sd.toFixed(2)}  needs >${bar.toFixed(2)}  ${verdict}`);
  }
  return { ok: true, lines };
}

export async function launchBrowser() {
  return puppeteer.launch({ headless: true, protocolTimeout: 1200000,
    args: ['--no-sandbox','--enable-gpu','--use-angle=metal','--ignore-gpu-blocklist','--enable-webgl'] });
}
