/**
 * Reader for the binary building shards written by `tools/pack-buildings.mjs`.
 *
 * The shipped JSON was 16.56 MB across 61 shards for 61,597 records; the same
 * records pack to 5.96 MB, 36% of the size, which is the largest single
 * reduction available in what a visitor has to download. `JSON.parse` on one
 * 217 KB shard also cost 647 KB of heap -- about 3x the bytes -- for objects
 * that exist only to be read once, and none of that intermediate work happens
 * here.
 *
 * Kept deliberately dependency-free: this runs inside the geometry worker,
 * whose whole bundle is 30 kB because nothing in it imports three.js.
 *
 * The format is described where it is written. One field is worth repeating
 * because it is a trap: `levels` reads like an integer and is not -- six
 * records carry 4.5 and similar -- so it is f32, not u8.
 */
import type { BuildingRecord } from '../../core/types';

const MAGIC = 0x31534f42;   // 'BOS1', little-endian
const VERSION = 1;
const ROOF = ['gabled', 'pyramidal', 'hipped', 'flat', 'mansard', 'skillion', 'dome'] as const;
const MATERIAL = ['wood', 'stone', 'plaster', 'brick', 'concrete', 'metal', 'glass', 'brownstone'] as const;

const align4 = (n: number): number => (n + 3) & ~3;

/** True when `buf` starts with this format's magic, so a caller can sniff. */
export function isBinaryShard(buf: ArrayBuffer): boolean {
  return buf.byteLength >= 8 && new DataView(buf).getUint32(0, true) === MAGIC;
}

export function decodeBuildingShard(buf: ArrayBuffer): BuildingRecord[] {
  const dv = new DataView(buf);
  if (dv.getUint32(0, true) !== MAGIC) throw new Error('not a binary building shard');
  const version = dv.getUint32(4, true);
  if (version !== VERSION) throw new Error(`building shard version ${version}, expected ${VERSION}`);
  const count = dv.getUint32(8, true);
  const points = dv.getUint32(12, true);
  const idBytes = dv.getUint32(16, true);
  const tailBytes = dv.getUint32(20, true);

  let o = 24;
  const take = <T>(Ctor: { new (b: ArrayBuffer, o: number, n: number): T; BYTES_PER_ELEMENT: number }, n: number): T => {
    const v = new Ctor(buf, o, n);
    o += align4(n * Ctor.BYTES_PER_ELEMENT);
    return v;
  };
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

  // `holes`, `name` and `landmark` are on 146, 2777 and 24 of 61,597 records,
  // so they ride in a JSON tail rather than earning binary sections.
  const tail = JSON.parse(new TextDecoder().decode(tailRaw)) as {
    holes: Record<string, number[][]>;
    name: Record<string, string>;
    landmark: Record<string, string>;
  };

  const dec = new TextDecoder();
  const out: BuildingRecord[] = new Array(count);
  for (let i = 0; i < count; i++) {
    const a = outlineOffset[i], b = outlineOffset[i + 1];
    const rec = {
      id: dec.decode(idBlob.subarray(idOffset[i], idOffset[i + 1])),
      outline: Array.from(xy.subarray(a * 2, b * 2)),
      height: height[i],
      minHeight: minHeight[i],
      ground: ground[i],
      levels: levels[i],
      roof: ROOF[roof[i]],
      roofHeight: roofHeight[i],
      material: MATERIAL[material[i]],
      color: color[i],
      roofColor: roofColor[i],
    } as unknown as BuildingRecord;
    const r = rec as unknown as Record<string, unknown>;
    const h = tail.holes[i]; if (h) r.holes = h;
    const nm = tail.name[i]; if (nm) r.name = nm;
    const lm = tail.landmark[i]; if (lm) r.landmark = lm;
    out[i] = rec;
  }
  return out;
}
