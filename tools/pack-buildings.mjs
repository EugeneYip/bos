#!/usr/bin/env node
/**
 * Pack the shipped building shards from JSON into a binary form.
 *
 *   node tools/pack-buildings.mjs [--out=public/data] [--check]
 *
 * Why, with the numbers. `JSON.parse` on a 217 KB shard costs 647 KB of heap,
 * about 3x the bytes, and the city is 61,597 records of eleven fields each --
 * so the whole set materialises roughly 120 MB of JS objects that exist only
 * to be read once and thrown away. The binary form is read as a handful of
 * typed-array views over one ArrayBuffer: no per-record objects at all.
 *
 * It converts the JSON that is already committed rather than re-running the
 * Overpass pipeline, deliberately: re-extracting would pull today's OSM and
 * quietly change the model underneath a change whose entire claim is that it
 * changes nothing. `--check` decodes what it wrote and deep-compares.
 *
 * Field widths are measured, not assumed. `levels` looks like an integer and
 * is not -- six records carry values like 4.5 -- so it is f32 like the other
 * four. A u8 there would have silently shortened six buildings.
 *
 *   height     2.5 .. 240.8    58516 non-integer
 *   minHeight    0 .. 88.1        35 non-integer
 *   ground    -1.6 .. 76.17    61054 non-integer
 *   levels       1 .. 62           6 non-integer   <-- not an integer field
 *   roofHeight   0 .. 15       42887 non-integer
 *   color/roofColor  <= 0xFFFFFF
 *   outline    <= 339 points     holes <= 9 rings, 228 in total
 *
 * `holes`, `name` and `landmark` are on 146, 2777 and 24 records, so they ride
 * along as a small JSON tail rather than earning their own binary sections.
 */
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const argv = Object.fromEntries(process.argv.slice(2)
  .filter((a) => a.startsWith('--'))
  .map((a) => { const [k, v] = a.replace(/^--/, '').split('='); return [k, v ?? true]; }));
const DIR = path.resolve(ROOT, argv.out ?? 'public/data');
const CHECK = !!argv.check;

export const MAGIC = 0x31534f42;            // 'BOS1' little-endian
export const VERSION = 1;
export const ROOF_ENUM = ['gabled', 'pyramidal', 'hipped', 'flat', 'mansard', 'skillion', 'dome'];
export const MATERIAL_ENUM = ['wood', 'stone', 'plaster', 'brick', 'concrete', 'metal', 'glass', 'brownstone'];

const align4 = (n) => (n + 3) & ~3;

export function encodeBuildings(recs) {
  const count = recs.length;
  let points = 0;
  for (const r of recs) points += r.outline.length / 2;

  const enc = new TextEncoder();
  const idParts = recs.map((r) => enc.encode(r.id));
  const idBytes = idParts.reduce((a, b) => a + b.length, 0);

  const tail = { holes: {}, name: {}, landmark: {} };
  recs.forEach((r, i) => {
    if (r.holes) tail.holes[i] = r.holes;
    if (r.name) tail.name[i] = r.name;
    if (r.landmark) tail.landmark[i] = r.landmark;
  });
  const tailBytes = enc.encode(JSON.stringify(tail));

  const head = 6 * 4;
  const sizes = [
    (count + 1) * 4,      // outlineOffset
    points * 2 * 4,       // xy
    count * 4,            // height
    count * 4,            // minHeight
    count * 4,            // ground
    count * 4,            // levels
    count * 4,            // roofHeight
    count * 4,            // color
    count * 4,            // roofColor
    align4(count),        // roof
    align4(count),        // material
    (count + 1) * 4,      // idOffset
    align4(idBytes),      // idBlob
    align4(tailBytes.length),
  ];
  const total = head + sizes.reduce((a, b) => a + b, 0);
  const buf = new ArrayBuffer(total);
  const dv = new DataView(buf);
  dv.setUint32(0, MAGIC, true);
  dv.setUint32(4, VERSION, true);
  dv.setUint32(8, count, true);
  dv.setUint32(12, points, true);
  dv.setUint32(16, idBytes, true);
  dv.setUint32(20, tailBytes.length, true);

  let o = head;
  const take = (Ctor, n) => { const v = new Ctor(buf, o, n); o += align4(n * Ctor.BYTES_PER_ELEMENT); return v; };
  const outlineOffset = take(Uint32Array, count + 1);
  const xy = take(Float32Array, points * 2);
  const height = take(Float32Array, count);
  const minHeight = take(Float32Array, count);
  const ground = take(Float32Array, count);
  const levels = take(Float32Array, count);
  const roofHeight = take(Float32Array, count);
  const color = take(Uint32Array, count);
  const roofColor = take(Uint32Array, count);
  const roof = take(Uint8Array, count);
  const material = take(Uint8Array, count);
  const idOffset = take(Uint32Array, count + 1);
  const idBlob = take(Uint8Array, idBytes);
  const tailOut = take(Uint8Array, tailBytes.length);

  let p = 0, ib = 0;
  for (let i = 0; i < count; i++) {
    const r = recs[i];
    outlineOffset[i] = p;
    for (let k = 0; k < r.outline.length; k++) xy[p * 2 + k] = r.outline[k];
    p += r.outline.length / 2;
    height[i] = r.height; minHeight[i] = r.minHeight; ground[i] = r.ground;
    levels[i] = r.levels; roofHeight[i] = r.roofHeight;
    color[i] = r.color; roofColor[i] = r.roofColor;
    const ri = ROOF_ENUM.indexOf(r.roof);
    const mi = MATERIAL_ENUM.indexOf(r.material);
    if (ri < 0) throw new Error(`unknown roof '${r.roof}' -- extend ROOF_ENUM and bump VERSION`);
    if (mi < 0) throw new Error(`unknown material '${r.material}' -- extend MATERIAL_ENUM and bump VERSION`);
    roof[i] = ri; material[i] = mi;
    idOffset[i] = ib;
    idBlob.set(idParts[i], ib);
    ib += idParts[i].length;
  }
  outlineOffset[count] = p;
  idOffset[count] = ib;
  tailOut.set(tailBytes);
  return buf;
}

/** Mirror of the client decoder, used only to verify what was written. */
export function decodeBuildings(buf) {
  const dv = new DataView(buf);
  if (dv.getUint32(0, true) !== MAGIC) throw new Error('not a BOS1 building shard');
  if (dv.getUint32(4, true) !== VERSION) throw new Error('unexpected version');
  const count = dv.getUint32(8, true);
  const points = dv.getUint32(12, true);
  const idBytes = dv.getUint32(16, true);
  const tailBytes = dv.getUint32(20, true);
  let o = 24;
  const take = (Ctor, n) => { const v = new Ctor(buf, o, n); o += align4(n * Ctor.BYTES_PER_ELEMENT); return v; };
  const outlineOffset = take(Uint32Array, count + 1);
  const xy = take(Float32Array, points * 2);
  const height = take(Float32Array, count);
  const minHeight = take(Float32Array, count);
  const ground = take(Float32Array, count);
  const levels = take(Float32Array, count);
  const roofHeight = take(Float32Array, count);
  const color = take(Uint32Array, count);
  const roofColor = take(Uint32Array, count);
  const roof = take(Uint8Array, count);
  const material = take(Uint8Array, count);
  const idOffset = take(Uint32Array, count + 1);
  const idBlob = take(Uint8Array, idBytes);
  const tailRaw = take(Uint8Array, tailBytes);
  const tail = JSON.parse(new TextDecoder().decode(tailRaw));
  const dec = new TextDecoder();
  const out = [];
  for (let i = 0; i < count; i++) {
    const a = outlineOffset[i], b = outlineOffset[i + 1];
    const rec = {
      id: dec.decode(idBlob.subarray(idOffset[i], idOffset[i + 1])),
      outline: Array.from(xy.subarray(a * 2, b * 2)),
      height: height[i], minHeight: minHeight[i], ground: ground[i],
      levels: levels[i], roof: ROOF_ENUM[roof[i]], roofHeight: roofHeight[i],
      material: MATERIAL_ENUM[material[i]], color: color[i], roofColor: roofColor[i],
    };
    if (tail.holes[i]) rec.holes = tail.holes[i];
    if (tail.name[i]) rec.name = tail.name[i];
    if (tail.landmark[i]) rec.landmark = tail.landmark[i];
    out.push(rec);
  }
  return out;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const files = fs.readdirSync(DIR).filter((f) => /^buildings-\d+\.json$/.test(f)).sort();
  if (!files.length) throw new Error(`no buildings-NN.json in ${DIR}`);
  let jsonBytes = 0, binBytes = 0, recs = 0, mismatches = 0;
  // f32 cannot hold every 2-decimal value exactly, so coordinates are compared
  // at the precision the JSON was rounded to rather than bit for bit.
  const near = (a, b) => Math.abs(a - b) <= 0.005 + Math.abs(b) * 1e-6;
  for (const f of files) {
    const src = JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8'));
    const buf = encodeBuildings(src);
    const out = f.replace(/\.json$/, '.bin');
    fs.writeFileSync(path.join(DIR, out), Buffer.from(buf));
    jsonBytes += fs.statSync(path.join(DIR, f)).size;
    binBytes += buf.byteLength;
    recs += src.length;
    if (CHECK) {
      const back = decodeBuildings(buf);
      if (back.length !== src.length) { console.error(`${f}: count ${src.length} -> ${back.length}`); mismatches++; continue; }
      for (let i = 0; i < src.length; i++) {
        const a = src[i], b = back[i];
        const bad = [];
        if (a.id !== b.id) bad.push('id');
        if (a.outline.length !== b.outline.length) bad.push('outline.length');
        else for (let k = 0; k < a.outline.length; k++) if (!near(b.outline[k], a.outline[k])) { bad.push(`outline[${k}] ${a.outline[k]} -> ${b.outline[k]}`); break; }
        for (const k of ['height','minHeight','ground','levels','roofHeight']) if (!near(b[k], a[k])) bad.push(`${k} ${a[k]} -> ${b[k]}`);
        for (const k of ['color','roofColor','roof','material']) if (a[k] !== b[k]) bad.push(`${k} ${a[k]} -> ${b[k]}`);
        if (JSON.stringify(a.holes ?? null) !== JSON.stringify(b.holes ?? null)) bad.push('holes');
        if ((a.name ?? null) !== (b.name ?? null)) bad.push('name');
        if (bad.length) { console.error(`${f}[${i}] ${a.id}: ${bad.join(', ')}`); if (++mismatches > 20) throw new Error('too many mismatches'); }
      }
    }
  }
  const pct = (100 * binBytes / jsonBytes).toFixed(1);
  console.log(`${files.length} shards, ${recs} records`);
  console.log(`json ${(jsonBytes / 1048576).toFixed(2)} MB -> bin ${(binBytes / 1048576).toFixed(2)} MB  (${pct}%)`);
  console.log(CHECK ? (mismatches ? `FAILED: ${mismatches} mismatching records` : 'round-trip check PASSED') : '(run with --check to verify)');
}
