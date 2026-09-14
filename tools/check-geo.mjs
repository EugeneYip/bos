#!/usr/bin/env node
/**
 * Proves that `tools/lib/geo.mjs` is numerically identical to `src/core/geo.ts`.
 *
 * The runtime is TypeScript and the pipeline is plain node, so the projection
 * maths exists twice. This script transpiles the real .ts sources with the
 * TypeScript compiler that is already a devDependency, imports both
 * implementations, and compares them over a dense grid covering BOUNDS.
 *
 *   node tools/check-geo.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';

const ROOT = path.resolve(import.meta.dirname, '..');

function transpile(srcPath, outPath, rewrites = {}) {
  let code = fs.readFileSync(srcPath, 'utf8');
  const out = ts.transpileModule(code, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
  }).outputText;
  let js = out;
  for (const [from, to] of Object.entries(rewrites)) {
    js = js.split(`'${from}'`).join(`'${to}'`).split(`"${from}"`).join(`"${to}"`);
  }
  fs.writeFileSync(outPath, js);
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bos-geo-'));
transpile(path.join(ROOT, 'src/core/config.ts'), path.join(tmp, 'config.mjs'));
transpile(path.join(ROOT, 'src/core/geo.ts'), path.join(tmp, 'geo.mjs'), { './config': './config.mjs' });

const tsGeo = await import(pathToFileURL(path.join(tmp, 'geo.mjs')).href);
const tsCfg = await import(pathToFileURL(path.join(tmp, 'config.mjs')).href);
const mjs = await import(pathToFileURL(path.join(ROOT, 'tools/lib/geo.mjs')).href);

let maxErr = 0;
let maxErrAt = null;
let checks = 0;

const B = tsCfg.BOUNDS;
const N = 200;
for (let i = 0; i <= N; i++) {
  for (let j = 0; j <= N; j++) {
    const lat = B.south + ((B.north - B.south) * i) / N;
    const lon = B.west + ((B.east - B.west) * j) / N;
    const a = tsGeo.lonLatToWorld(lon, lat);
    const b = mjs.lonLatToWorld(lon, lat);
    const e = Math.max(Math.abs(a[0] - b[0]), Math.abs(a[1] - b[1]));
    if (e > maxErr) { maxErr = e; maxErrAt = [lon, lat]; }
    // and the inverse round-trip
    const c = tsGeo.worldToLonLat(a[0], a[1]);
    const d = mjs.worldToLonLat(b[0], b[1]);
    const e2 = Math.max(Math.abs(c[0] - d[0]), Math.abs(c[1] - d[1])) * 111320;
    if (e2 > maxErr) { maxErr = e2; maxErrAt = [lon, lat]; }
    checks += 2;
  }
}

// Tile maths too (terrain sampling depends on it).
let maxTileErr = 0;
for (let z of [13, 14, 15]) {
  for (let i = 0; i <= 40; i++) {
    for (let j = 0; j <= 40; j++) {
      const lat = B.south + ((B.north - B.south) * i) / 40;
      const lon = B.west + ((B.east - B.west) * j) / 40;
      const a = tsGeo.lonLatToTile(lon, lat, z);
      const b = mjs.lonLatToTile(lon, lat, z);
      maxTileErr = Math.max(maxTileErr, Math.abs(a[0] - b[0]), Math.abs(a[1] - b[1]));
    }
  }
}

const constErr = Math.max(
  Math.abs(tsGeo.METERS_PER_DEG_LAT - mjs.METERS_PER_DEG_LAT),
  Math.abs(tsGeo.METERS_PER_DEG_LON - mjs.METERS_PER_DEG_LON),
);
const originSame =
  tsCfg.ORIGIN.lat === mjs.ORIGIN.lat && tsCfg.ORIGIN.lon === mjs.ORIGIN.lon;
const boundsSame = ['south', 'west', 'north', 'east'].every((k) => tsCfg.BOUNDS[k] === mjs.BOUNDS[k]);

fs.rmSync(tmp, { recursive: true, force: true });

console.log(`geo parity check: ${checks} samples`);
console.log(`  ORIGIN identical:            ${originSame}`);
console.log(`  BOUNDS identical:            ${boundsSame}`);
console.log(`  METERS_PER_DEG_* max delta:  ${constErr.toExponential(3)} m/deg`);
console.log(`  lonLatToWorld max delta:     ${maxErr.toExponential(3)} m  at ${maxErrAt}`);
console.log(`  lonLatToTile  max delta:     ${maxTileErr.toExponential(3)} tiles`);
console.log(`  METERS_PER_DEG_LAT = ${mjs.METERS_PER_DEG_LAT}`);
console.log(`  METERS_PER_DEG_LON = ${mjs.METERS_PER_DEG_LON}`);

const ok = originSame && boundsSame && maxErr < 1e-6 && maxTileErr < 1e-12 && constErr < 1e-9;
console.log(ok ? 'PASS (< 1e-6 m)' : 'FAIL');
process.exit(ok ? 0 : 1);
