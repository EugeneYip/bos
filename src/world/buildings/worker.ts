/**
 * Geometry worker.
 *
 * Extruding 63,180 footprints — sanitising rings, ear-clipping caps, clipping
 * roof creases, scattering plant — is a couple of seconds of pure arithmetic.
 * Done on the main thread that is two seconds of frozen tab; spread over a
 * small pool of workers it is well under a second of wall clock and the page
 * never drops a frame.
 *
 * Each worker fetches its own shards, so nothing but finished typed arrays
 * crosses the thread boundary, and those cross by transfer rather than by copy.
 * Nothing here imports three.js — see `poly.ts` and `earcut.ts` — so the worker
 * bundle stays tiny.
 */
import type { BuildingRecord } from '../../core/types';
import { buildShard, shardTransferables } from './build';
import { decodeBuildingShard, isBinaryShard } from './binrecords';

export interface WorkerRequest {
  type: 'shard';
  index: number;
  url: string;
  skipLandmarks: string[];
}

export interface WorkerReply {
  type: 'done' | 'error';
  index: number;
  tiles?: Array<{ key: number; chunk: unknown }>;
  clutter?: Float32Array[];
  spill?: Float32Array;
  built?: number;
  skipped?: number;
  message?: string;
}

self.onmessage = async (ev: MessageEvent<WorkerRequest>): Promise<void> => {
  const msg = ev.data;
  if (!msg || msg.type !== 'shard') return;
  try {
    const res = await fetch(msg.url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    // Sniff rather than trust the extension, so a stale manifest pointing at
    // .json still works and a half-deployed mix of the two cannot break a
    // shard. The binary form is 36% of the JSON's bytes.
    const raw = await res.arrayBuffer();
    const records: BuildingRecord[] = isBinaryShard(raw)
      ? decodeBuildingShard(raw)
      : (JSON.parse(new TextDecoder().decode(raw)) as BuildingRecord[]);
    const out = buildShard(records, { skipLandmarks: msg.skipLandmarks });
    const reply: WorkerReply = {
      type: 'done',
      index: msg.index,
      tiles: out.tiles,
      clutter: out.clutter,
      spill: out.spill,
      built: out.built,
      skipped: out.skipped,
    };
    (self as unknown as Worker).postMessage(reply, shardTransferables(out) as unknown as Transferable[]);
  } catch (err) {
    const reply: WorkerReply = {
      type: 'error',
      index: msg.index,
      message: err instanceof Error ? err.message : String(err),
    };
    (self as unknown as Worker).postMessage(reply);
  }
};
