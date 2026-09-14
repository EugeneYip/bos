#!/usr/bin/env node
/**
 * Numerical validation of the Sky module's ephemeris (`src/sky/astro.ts`)
 * against published almanac values for Boston.
 *
 *   node qa/solar-check.mjs
 *
 * Exits non-zero if any check drifts outside its tolerance, so the sun can
 * never silently regress while the shaders are being tuned.
 */
import { build } from 'esbuild';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const dir = await mkdtemp(path.join(tmpdir(), 'solar-'));
const outfile = path.join(dir, 'astro.mjs');
await build({
  entryPoints: [path.join(ROOT, 'src', 'sky', 'astro.ts')],
  outfile,
  bundle: true,
  format: 'esm',
  platform: 'node',
  logLevel: 'silent',
});
const astro = await import(pathToFileURL(outfile).href);
await rm(dir, { recursive: true, force: true });

const LAT = 42.3554;
const LON = -71.0655;
const TZ = -4; // ATMOSPHERE.utcOffsetHours — Boston is pinned to EDT.
const RAD = 180 / Math.PI;

const hhmm = (h) => {
  if (h === null || h === undefined) return '   --  ';
  const m = Math.round(h * 60);
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
};

let failures = 0;
const rows = [];
function check(label, got, want, tol, unit) {
  const ok = Math.abs(got - want) <= tol;
  if (!ok) failures++;
  rows.push([ok ? 'ok  ' : 'FAIL', label, fmt(got, unit), fmt(want, unit), `±${tol}${unit === 'time' ? ' min' : unit}`]);
}
function fmt(v, unit) {
  if (unit === 'time') return hhmm(v / 60);
  return `${v.toFixed(unit === '°' ? 2 : 3)}${unit}`;
}

/* ---- Solstices and equinoxes ------------------------------------------- */
const DAYS = {
  'Jun 21 (summer solstice)': 172,
  'Dec 21 (winter solstice)': 355,
  'Mar 20 (vernal equinox)': 79,
  'Sep 22 (autumnal equinox)': 265,
};

console.log('\nBoston 42.3554°N 71.0655°W, UTC%s — src/sky/astro.ts\n', TZ);
console.log('day                        sunrise  noon    sunset   noon elev  azimuth  EoT');
for (const [label, doy] of Object.entries(DAYS)) {
  const rise = astro.solarEvent(doy, LAT, LON, TZ, astro.SUNRISE_ALTITUDE, true);
  const set = astro.solarEvent(doy, LAT, LON, TZ, astro.SUNRISE_ALTITUDE, false);
  const noon = astro.solarNoon(doy, LAT, LON, TZ);
  const s = astro.sunPosition(doy, noon.hour, LAT, LON, TZ);
  console.log(
    `${label.padEnd(26)} ${hhmm(rise)}   ${hhmm(noon.hour)}  ${hhmm(set)}   ${(noon.elevation * RAD)
      .toFixed(2)
      .padStart(6)}°   ${(s.azimuth * RAD).toFixed(1).padStart(6)}°  ${s.equationOfTime.toFixed(1).padStart(6)} min`,
  );
}

/* ---- Hard checks against almanac values --------------------------------- */
// Sunrise/sunset from the US Naval Observatory / NOAA solar calculator for
// Boston, MA. Tolerance is 2 minutes: those tables round to the minute and use
// a slightly different observer elevation.
{
  const doy = 172;
  const rise = astro.solarEvent(doy, LAT, LON, TZ, astro.SUNRISE_ALTITUDE, true);
  const set = astro.solarEvent(doy, LAT, LON, TZ, astro.SUNRISE_ALTITUDE, false);
  const noon = astro.solarNoon(doy, LAT, LON, TZ);
  check('summer solstice sunrise', rise * 60, 5 * 60 + 7, 2, 'time');
  check('summer solstice sunset', set * 60, 20 * 60 + 25, 2, 'time');
  check('summer solstice peak elevation', noon.elevation * RAD, 71.1, 0.35, '°');
  check('summer solstice day length', (set - rise) * 60, 15 * 60 + 18, 3, 'time');
}
{
  // On 21 Dec Boston is really on EST (UTC-5); the project pins the offset to
  // -4, so clock times are one hour later than an almanac would print. Peak
  // elevation is independent of the zone offset, so it is checked directly and
  // the clock times are checked against EST + 1 h.
  const doy = 355;
  const rise = astro.solarEvent(doy, LAT, LON, TZ, astro.SUNRISE_ALTITUDE, true);
  const set = astro.solarEvent(doy, LAT, LON, TZ, astro.SUNRISE_ALTITUDE, false);
  const noon = astro.solarNoon(doy, LAT, LON, TZ);
  check('winter solstice peak elevation', noon.elevation * RAD, 24.06, 0.35, '°');
  check('winter solstice sunrise (EST+1h)', rise * 60, 8 * 60 + 12, 3, 'time');
  check('winter solstice sunset (EST+1h)', set * 60, 17 * 60 + 15, 3, 'time');
}
{
  // At an equinox the sun rises due east and sets due west, and the noon
  // elevation is 90 - latitude (+ a little, the sun is not a point and the
  // equinox rarely falls exactly on a midnight).
  const doy = 79;
  const noon = astro.solarNoon(doy, LAT, LON, TZ);
  check('vernal equinox peak elevation', noon.elevation * RAD, 90 - LAT, 0.6, '°');
  const rise = astro.solarEvent(doy, LAT, LON, TZ, 0, true);
  const s = astro.sunPosition(doy, rise, LAT, LON, TZ);
  check('vernal equinox sunrise azimuth', s.azimuth * RAD, 90, 1.2, '°');
}
{
  // Equation of time extrema: about -14.2 min around 11 Feb and +16.4 min
  // around 3 Nov.
  let min = Infinity;
  let max = -Infinity;
  let minDay = 0;
  let maxDay = 0;
  for (let d = 1; d <= 365; d++) {
    const e = astro.sunPosition(d, 12, LAT, LON, TZ).equationOfTime;
    if (e < min) { min = e; minDay = d; }
    if (e > max) { max = e; maxDay = d; }
  }
  check('equation of time minimum', min, -14.24, 0.2, ' min');
  check('equation of time maximum', max, 16.43, 0.2, ' min');
  check('EoT minimum day-of-year', minDay, 42, 2, ' doy');
  check('EoT maximum day-of-year', maxDay, 307, 2, ' doy');
}
{
  // Continuity: no step larger than the true angular rate anywhere in the day.
  let worst = 0;
  for (let d = 1; d <= 365; d += 7) {
    let prev = astro.sunPosition(d, 0, LAT, LON, TZ);
    for (let h = 0.002; h <= 24; h += 0.002) {
      const cur = astro.sunPosition(d, h, LAT, LON, TZ);
      const dot =
        prev.direction.x * cur.direction.x +
        prev.direction.y * cur.direction.y +
        prev.direction.z * cur.direction.z;
      worst = Math.max(worst, Math.acos(Math.min(1, dot)) * RAD);
      prev = cur;
    }
  }
  // 0.002 h of earth rotation is 0.03°; refraction near the horizon inflates
  // that a little but nothing should ever jump.
  check('max angular step over 7.2 s', worst, 0.0, 0.08, '°');
}

/* ---- Moon --------------------------------------------------------------- */
// New/full moons in 2025 (UTC) from the USNO phase tables, converted to
// Boston local (UTC-4) and to day-of-year.
const MOON_EVENTS = [
  ['new moon 2025-01-29 12:36 UTC', 29, 8.6, 0.0],
  ['full moon 2025-02-12 13:53 UTC', 43, 9.9, 1.0],
  ['new moon 2025-06-25 10:31 UTC', 176, 6.5, 0.0],
  ['full moon 2025-07-10 20:37 UTC', 191, 16.6, 1.0],
  ['full moon 2025-10-07 03:47 UTC', 279, 23.8, 1.0],
];
console.log('\nmoon phase checks');
for (const [label, doy, hour, want] of MOON_EVENTS) {
  const sun = astro.sunPosition(doy, hour, LAT, LON, TZ);
  const moon = astro.moonPosition(doy, hour, LAT, LON, TZ, sun);
  const got = moon.illumination;
  const ok = Math.abs(got - want) < 0.015;
  if (!ok) failures++;
  console.log(
    `  ${ok ? 'ok  ' : 'FAIL'} ${label.padEnd(34)} illum=${got.toFixed(4)} want=${want.toFixed(2)}  dist=${moon.distance.toFixed(0)} km`,
  );
}
{
  // Lunar distance must stay inside the real perigee/apogee envelope.
  let lo = Infinity;
  let hi = -Infinity;
  for (let d = 1; d <= 365; d += 0.25) {
    const sun = astro.sunPosition(d, 12, LAT, LON, TZ);
    const m = astro.moonPosition(d, 12, LAT, LON, TZ, sun);
    lo = Math.min(lo, m.distance);
    hi = Math.max(hi, m.distance);
  }
  check('lunar perigee', lo, 357000, 4000, ' km');
  check('lunar apogee', hi, 406500, 4000, ' km');
}

/* ---- Report ------------------------------------------------------------- */
console.log('');
const w = [4, 34, 12, 12, 10];
for (const r of rows) console.log('  ' + r.map((c, i) => String(c).padEnd(w[i])).join(' '));
console.log(`\n${failures === 0 ? 'PASS' : `FAIL (${failures})`} — ${rows.length + MOON_EVENTS.length} checks\n`);
process.exit(failures === 0 ? 0 : 1);
