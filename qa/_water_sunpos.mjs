#!/usr/bin/env node
/**
 * Scratch helper (not a screenshot script): prints sun azimuth/elevation for
 * a list of hours so viewpoints can be chosen deliberately toward/away from
 * the sun. Mirrors qa/solar-check.mjs's esbuild-bundle trick.
 */
import { build } from 'esbuild';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dir = await mkdtemp(path.join(tmpdir(), 'astro-'));
const outfile = path.join(dir, 'astro.mjs');
await build({
  entryPoints: [path.join(ROOT, 'src', 'sky', 'astro.ts')],
  outfile, bundle: true, format: 'esm', platform: 'node', logLevel: 'silent',
});
const astro = await import(pathToFileURL(outfile).href);
await rm(dir, { recursive: true, force: true });

const LAT = 42.3554, LON = -71.0655, TZ = -4;
const DOY = Number(process.argv[2] || 262);
const RAD = 180 / Math.PI;
const hours = process.argv.slice(3).map(Number);
const list = hours.length ? hours :
  [8.0, 8.6, 9.2, 9.6, 9.8, 10.0, 10.2, 10.4, 10.5, 10.8, 11.0, 13.6, 15.0, 15.5, 16.0, 16.2, 16.4, 17.1, 17.2, 17.6, 17.9, 18.2, 18.6, 21.5];

for (const h of list) {
  const s = astro.sunPosition(DOY, h, LAT, LON, TZ);
  console.log(
    `h=${h.toFixed(2).padStart(5)}  az=${(s.azimuth * RAD).toFixed(1).padStart(7)}deg  ` +
    `elev=${(s.elevation * RAD).toFixed(2).padStart(6)}deg  dir=(${s.direction.x.toFixed(3)}, ${s.direction.y.toFixed(3)}, ${s.direction.z.toFixed(3)})`
  );
}
