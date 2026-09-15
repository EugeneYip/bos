import type {
  AreaRecord, BuildingRecord, CityManifest, PropSet, RoadRecord, TerrainData,
} from './types';

/**
 * Shared loader for everything under `public/data/`.
 *
 * Responsibilities: resolve URLs against Vite's `base` (the site is served from
 * a subpath on GitHub Pages), de-duplicate concurrent requests for the same
 * file, cache parsed results, stream sharded collections, and report progress.
 */

const base = import.meta.env.BASE_URL ?? '/';
const inflight = new Map<string, Promise<unknown>>();
const cache = new Map<string, unknown>();

const MANIFEST = 'manifest.json';

/**
 * The manifest's `generated` stamp, once it has loaded. Every other data URL
 * carries it.
 *
 * Vite content-hashes the JavaScript, so a deploy always ships the code it
 * built. It does not touch `public/`, and the forty megabytes of city under
 * `data/` are fetched at fixed paths — so a browser that has them cached keeps
 * them, and the visitor runs new code against old geometry. That is not a
 * theoretical problem: every correction made to the building data — the
 * duplicate slab standing inside the Prudential Tower, the parts buried in
 * their parents, the coplanar roofs — was invisible to anyone whose browser had
 * already taken a copy, and looked exactly like a fix that had not worked.
 */
let dataVersion = '';

export function dataUrl(file: string): string {
  const path = `${base.replace(/\/$/, '')}/data/${file.replace(/^\//, '')}`;
  if (!dataVersion || file === MANIFEST) return path;
  return `${path}?v=${encodeURIComponent(dataVersion)}`;
}

async function fetchOnce<T>(file: string, parse: (r: Response) => Promise<T>): Promise<T> {
  if (cache.has(file)) return cache.get(file) as T;
  const existing = inflight.get(file);
  if (existing) return existing as Promise<T>;

  const p = (async () => {
    // Anything but the manifest waits for it, so the version stamp is always in
    // the URL. A caller that loads a file the manifest does not list — the
    // far-field heightfield does — would otherwise be versioned or not
    // depending on module registration order, which is no guarantee at all.
    if (file !== MANIFEST) await manifestVersion();

    // The manifest is the one file that must never come from a cache without
    // asking: it is small, and it is what tells us whether everything else has
    // changed. `no-cache` still allows a 304, so the cost is one conditional
    // request per load rather than a download.
    const res = await fetch(dataUrl(file), file === MANIFEST ? { cache: 'no-cache' } : undefined);
    if (!res.ok) throw new Error(`data: ${file} -> HTTP ${res.status}`);
    const out = await parse(res);
    cache.set(file, out);
    inflight.delete(file);
    return out;
  })();
  inflight.set(file, p);
  return p;
}

/** Resolves once `dataVersion` is set, or immediately if there is no manifest. */
async function manifestVersion(): Promise<void> {
  if (dataVersion) return;
  try {
    await loadManifest();
  } catch {
    /* No manifest: unversioned URLs are the best available, and the caller's
       own error handling deals with the missing file. */
  }
}

export const loadJson = <T>(file: string): Promise<T> =>
  fetchOnce(file, (r) => r.json() as Promise<T>);

export const loadBinary = (file: string): Promise<ArrayBuffer> =>
  fetchOnce(file, (r) => r.arrayBuffer());

let manifestPromise: Promise<CityManifest> | null = null;

/** The manifest is the entry point to every other dataset. */
export function loadManifest(): Promise<CityManifest> {
  manifestPromise ??= loadJson<CityManifest>(MANIFEST).then((m) => {
    dataVersion = String(m.generated ?? '');
    return m;
  });
  return manifestPromise;
}

/**
 * Loads a sharded collection, invoking `onShard` as each shard arrives so
 * callers can build geometry incrementally instead of blocking on the whole set.
 * Shards are fetched with limited concurrency to avoid saturating the connection.
 */
export async function loadSharded<T>(
  files: string[],
  onShard?: (items: T[], index: number, total: number) => void,
  concurrency = 4,
): Promise<T[]> {
  const out: T[][] = new Array(files.length);
  let next = 0;

  const worker = async (): Promise<void> => {
    for (;;) {
      const i = next++;
      if (i >= files.length) return;
      const items = await loadJson<T[]>(files[i]);
      out[i] = items;
      onShard?.(items, i, files.length);
    }
  };

  await Promise.all(Array.from({ length: Math.min(concurrency, files.length) }, worker));
  return out.flat();
}

export async function loadBuildings(
  onShard?: (b: BuildingRecord[], i: number, n: number) => void,
): Promise<BuildingRecord[]> {
  const m = await loadManifest();
  return loadSharded<BuildingRecord>(m.files.buildings, onShard);
}

export async function loadRoads(
  onShard?: (r: RoadRecord[], i: number, n: number) => void,
): Promise<RoadRecord[]> {
  const m = await loadManifest();
  return loadSharded<RoadRecord>(m.files.roads, onShard);
}

export async function loadAreas(
  onShard?: (a: AreaRecord[], i: number, n: number) => void,
): Promise<AreaRecord[]> {
  const m = await loadManifest();
  return loadSharded<AreaRecord>(m.files.areas, onShard);
}

export async function loadProps(): Promise<PropSet[]> {
  const m = await loadManifest();
  return loadSharded<PropSet>(m.files.props);
}

/**
 * Terrain ships as a JSON header plus a raw Float32 payload, since a heightfield
 * of a few hundred thousand posts is unreasonable to encode as JSON numbers.
 * The header file is `<name>.json`, the payload `<name>.bin`.
 */
export async function loadTerrain(): Promise<TerrainData> {
  const m = await loadManifest();
  const headerFile = m.files.terrain;
  const header = await loadJson<Omit<TerrainData, 'elevations'> & { data?: string }>(headerFile);
  const binFile = header.data ?? headerFile.replace(/\.json$/, '.bin');
  const buf = await loadBinary(binFile);
  const elevations = new Float32Array(buf);

  const expected = header.width * header.height;
  if (elevations.length < expected) {
    throw new Error(`terrain: expected ${expected} samples, got ${elevations.length}`);
  }
  return { ...header, elevations };
}

/** True when the data pipeline has produced output; lets modules degrade gracefully. */
export async function hasData(): Promise<boolean> {
  try {
    await loadManifest();
    return true;
  } catch {
    return false;
  }
}
