/**
 * Landmark index for the HUD search.
 *
 * Sources, in priority order:
 *   1. `src/landmarks/registry.ts` — owned by the Landmarks module, built
 *      concurrently. Discovered with `import.meta.glob`, which resolves to an
 *      empty object when the file doesn't exist, so there is no build-time
 *      dependency and no 404 at runtime.
 *   2. The curated list in `landmarkData.ts`.
 *   3. `qa/viewpoints.json` — the QA harness viewpoints, so the UI can always
 *      reproduce a review shot.
 *
 * The registry's exact shape isn't fixed yet, so entries are normalised
 * loosely: anything with a name plus lon/lat, a world position, or an explicit
 * pos/target pair is accepted.
 */
import type { Ctx } from '../core/Context';
import { lonLatToWorld } from '../core/geo';
import { framingFor, LANDMARKS, type Framing, type LandmarkEntry } from './landmarkData';
import viewpoints from '../../qa/viewpoints.json';

export interface IndexEntry {
  id: string;
  name: string;
  group: string;
  hour?: number;
  /** Lowercased haystack for the search box. */
  search: string;
  /** Terrain is sampled lazily so framings improve as the world streams in. */
  frame(ctx: Ctx): Framing;
}

const GROUP_ORDER = [
  'Skyline',
  'Historic',
  'Parks',
  'Neighbourhoods',
  'Waterfront',
  'Bridges',
  'Culture & Sport',
  'Landmarks',
  'Viewpoints',
];

function entryFromCurated(e: LandmarkEntry): IndexEntry {
  return {
    id: e.id,
    name: e.name,
    group: e.group,
    hour: e.hour,
    search: `${e.name} ${e.group} ${e.alt ?? ''}`.toLowerCase(),
    frame: (ctx) => framingFor(e, ctx),
  };
}

type Loose = Record<string, unknown>;

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function triple(v: unknown): [number, number, number] | null {
  if (Array.isArray(v) && v.length >= 3) {
    const a = num(v[0]);
    const b = num(v[1]);
    const c = num(v[2]);
    if (a !== null && b !== null && c !== null) return [a, b, c];
  }
  if (v && typeof v === 'object') {
    const o = v as Loose;
    const a = num(o.x);
    const b = num(o.y);
    const c = num(o.z);
    if (a !== null && c !== null) return [a, b ?? 0, c];
  }
  return null;
}

/**
 * Best-effort normalisation of one entry from an unknown registry shape.
 * Returns null when we can't work out where it is.
 */
function normalise(raw: unknown, i: number): IndexEntry | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Loose;
  const name =
    (typeof o.name === 'string' && o.name) ||
    (typeof o.title === 'string' && o.title) ||
    (typeof o.label === 'string' && o.label) ||
    (typeof o.id === 'string' && o.id) ||
    '';
  if (!name) return null;
  const id = typeof o.id === 'string' ? o.id : `lm-${i}`;
  const group = typeof o.group === 'string' ? o.group : typeof o.category === 'string' ? o.category : 'Landmarks';
  const hour = num(o.hour) ?? undefined;
  const height = num(o.height) ?? num(o.roofHeight) ?? 60;

  // 1. explicit camera framing
  const view = (o.view ?? o.camera ?? o) as Loose;
  const pos = triple(view.pos ?? view.position ?? view.eye);
  const target = triple(view.target ?? view.lookAt ?? view.focus);
  if (pos && target) {
    return {
      id, name, group, hour,
      search: `${name} ${group}`.toLowerCase(),
      frame: () => ({ pos, target, hour }),
    };
  }

  // 2. lon/lat
  const lon = num(o.lon) ?? num(o.lng) ?? num(o.longitude);
  const lat = num(o.lat) ?? num(o.latitude);
  if (lon !== null && lat !== null) {
    const curated: LandmarkEntry = {
      id, name, group, lon, lat,
      height,
      bearing: num(o.bearing) ?? 150,
      distance: num(o.distance) ?? Math.max(height * 3.4, 240),
      altitude: num(o.altitude) ?? Math.max(height * 0.9, 60),
      hour,
    };
    return entryFromCurated(curated);
  }

  // 3. world-space anchor
  const anchor = triple(o.position ?? o.center ?? o.centre ?? o.origin);
  if (anchor) {
    const dist = Math.max(height * 3.4, 240);
    return {
      id, name, group, hour,
      search: `${name} ${group}`.toLowerCase(),
      frame: (ctx) => {
        const g = ctx.sampleHeight(anchor[0], anchor[2]);
        const ground = Number.isFinite(g) ? g : 0;
        const px = anchor[0] + dist * 0.64;
        const pz = anchor[2] + dist * 0.77;
        const pg = ctx.sampleHeight(px, pz);
        return {
          pos: [px, (Number.isFinite(pg) ? pg : 0) + Math.max(height * 0.9, 60), pz],
          target: [anchor[0], ground + height * 0.55, anchor[2]],
          hour,
        };
      },
    };
  }
  return null;
}

function fromViewpoints(): IndexEntry[] {
  const out: IndexEntry[] = [];
  for (const v of viewpoints as Array<Loose>) {
    const pos = triple(v.pos);
    const target = triple(v.target);
    const id = typeof v.id === 'string' ? v.id : '';
    if (!pos || !target || !id) continue;
    const title = typeof v.title === 'string' ? v.title : id;
    out.push({
      id: `vp-${id}`,
      name: title.replace(/\s*\(.*\)\s*$/, ''),
      group: 'Viewpoints',
      hour: num(v.hour) ?? undefined,
      search: `${id} ${title} viewpoint qa`.toLowerCase(),
      frame: () => ({ pos, target, hour: num(v.hour) ?? undefined }),
    });
  }
  return out;
}

/** Lazily pull the Landmarks module's registry if it has shipped one. */
async function fromRegistry(): Promise<IndexEntry[]> {
  try {
    const mods = import.meta.glob('../landmarks/*.ts');
    const key = Object.keys(mods).find((k) => /registry\.ts$/i.test(k));
    if (!key) return [];
    const mod = (await mods[key]()) as Record<string, unknown>;
    // Accept: default export array, any exported array, or a Map/record.
    const candidates: unknown[] = [];
    for (const value of Object.values(mod)) {
      if (Array.isArray(value)) candidates.push(...value);
      else if (value instanceof Map) candidates.push(...value.values());
      else if (value && typeof value === 'object' && !('length' in (value as Loose))) {
        const vals = Object.values(value as Loose);
        if (vals.length && vals.every((v) => v && typeof v === 'object')) candidates.push(...vals);
      }
    }
    const out: IndexEntry[] = [];
    const seen = new Set<string>();
    candidates.forEach((c, i) => {
      const e = normalise(c, i);
      if (e && !seen.has(e.id)) {
        seen.add(e.id);
        out.push(e);
      }
    });
    return out;
  } catch {
    return [];
  }
}

function sortEntries(list: IndexEntry[]): IndexEntry[] {
  return list.sort((a, b) => {
    const ga = GROUP_ORDER.indexOf(a.group);
    const gb = GROUP_ORDER.indexOf(b.group);
    const ra = ga === -1 ? GROUP_ORDER.length : ga;
    const rb = gb === -1 ? GROUP_ORDER.length : gb;
    return ra !== rb ? ra - rb : a.name.localeCompare(b.name);
  });
}

/** Curated + viewpoints; available synchronously so the panel never blocks. */
export function baseIndex(): IndexEntry[] {
  return sortEntries([...LANDMARKS.map(entryFromCurated), ...fromViewpoints()]);
}

/** Full index, including the Landmarks registry when it exists. */
export async function buildIndex(): Promise<IndexEntry[]> {
  const registry = await fromRegistry();
  if (!registry.length) return baseIndex();
  // Registry wins on name collisions; the curated list fills the gaps.
  const names = new Set(registry.map((e) => e.name.toLowerCase()));
  const extras = LANDMARKS.map(entryFromCurated).filter((e) => !names.has(e.name.toLowerCase()));
  return sortEntries([...registry, ...extras, ...fromViewpoints()]);
}

export { lonLatToWorld };
