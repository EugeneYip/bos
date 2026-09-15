/**
 * Where Boston's flags go.
 *
 * Props owns no building geometry, so this module reads the same
 * `public/data/buildings-*.json` records the Buildings module extrudes and
 * works out mounting points from the footprints. Three products:
 *
 *  - **staff** — a bracket on a street facade, just above the storefront
 *    cornice, carrying a staff raked out of the wall. By far the commonest.
 *  - **pole** — a vertical pole on a flat parapet, civic and older commercial.
 *  - **banner** — the vertically hung kind, several storeys of drop, on the
 *    most open facade of a prominent tower.
 *
 * Two things decide whether a wall can take a flag at all:
 *
 *  1. **Winding.** `BuildingRecord.outline` is not consistently wound in the
 *     data — roughly half the downtown footprints come through with negative
 *     signed area — so the outward normal of edge `i -> i+1` is `(dz, -dx)`
 *     only after the ring has been canonicalised. Get this wrong and every
 *     other flag points into the building it is bolted to.
 *  2. **Openness.** A wall with a neighbour two metres away is a party wall or
 *     an alley, not a frontage; a staff there would spear the building next
 *     door. Each candidate edge is probed outward against a grid index of
 *     every footprint in the flag zone, and only walls with at least eight
 *     metres of clear air in front are eligible. This is also what keeps
 *     rowhouse terraces flying flags from their *ends* rather than from the
 *     party walls they share.
 *
 * Selection is a hash of the OSM id, so a given building always flies the
 * same flags. The rate is weighted by a name-derived tier (courts, post
 * offices and city halls first; hotels, banks and churches next; anything
 * named after that; a thin scatter of ordinary frontage last) and by
 * proximity to the parts of the city that actually fly them. Banners are
 * ranked rather than sampled: there are only a couple of dozen in the whole
 * model and they belong on the towers, not wherever the dice fall.
 */
import * as THREE from 'three';
import type { BuildingMaterial, BuildingRecord, CityManifest } from '../../core/types';
import { dataUrl, loadManifest } from '../../core/data';

// ---------------------------------------------------------------------------
// tunables
// ---------------------------------------------------------------------------

/** Neighbourhoods that fly flags: x, z, falloff radius, weight. */
const ANCHORS: ReadonlyArray<readonly [number, number, number, number]> = [
  [500, -200, 1150, 1.00],   // Financial District / Downtown Crossing
  [-150, -250, 700, 0.95],   // Beacon Hill and the State House
  [-1050, 450, 1000, 0.85],  // Back Bay
  [450, -700, 800, 0.80],    // Faneuil Hall / North End
  [800, -1800, 650, 0.60],   // Charlestown and the Navy Yard
  [950, 450, 850, 0.55],     // Fort Point / Seaport
  [-4200, -2000, 700, 0.50], // Harvard Square
  [-2300, 1100, 650, 0.45],  // Fenway / Longwood
  [-2050, -200, 700, 0.40],  // MIT / Kendall
  [-1800, 1700, 600, 0.40],  // South End / Northeastern
];

/** Per-tier chance of a facade staff, before the neighbourhood weight. */
const P_STAFF = [0.72, 0.30, 0.145, 0.0165];
/** Per-tier chance of a parapet flagpole. */
const P_POLE = [0.62, 0.155, 0.062, 0.0055];
/** How many hanging banners exist in the whole city. */
const BANNERS = 26;

const TIER_A =
  /city hall|town hall|court|post office|federal|state house|custom house|capitol|library|museum|memorial|police|fire (?:station|dep)|veteran|armor|masonic|historical soc|old state|faneuil|city of boston/i;
const TIER_B =
  /hotel|\binn\b|bank|trust|insurance|exchange|\bclub\b|church|cathedral|chapel|temple|synagogue|school|college|academy|universit|hospital|theat|station|market|\bhall\b|building|tower|company|savings|society|institute/i;

/** Outward probe distances for the openness test, metres. */
const PROBE = [3, 8, 16, 28, 45, 68];
const MIN_OPEN = 8;
/** Cell size of the footprint index, metres. */
const CELL = 40;

// ---------------------------------------------------------------------------
// facade subdivision — mirrors buildings/build.ts `floorPlan`
// ---------------------------------------------------------------------------
// Duplicated rather than imported: the flag brackets have to land on the same
// storefront cornice the facade shader draws, and this is the whole of what
// that takes. Keep the constants in step with buildings/atlas.ts.

const REF_FLOOR = [3.35, 3.5, 3.9, 3.55, 3.85, 3.6, 3.05, 3.3];
const REF_GROUND = [4.5, 4.3, 5.2, 4.6, 4.9, 4.4, 3.4, 4.2];
const CROWN_FRAC = 0.42;
const FAMILY: Record<BuildingMaterial, number> = {
  brick: 0, brownstone: 1, stone: 2, concrete: 3, glass: 4, metal: 5, wood: 6, plaster: 7,
};

const clamp = (v: number, a: number, b: number): number => (v < a ? a : v > b ? b : v);

/** Height of the ground floor, so a bracket can sit on its cornice. */
function groundFloorHeight(H: number, levels: number, family: number): number {
  const fh0 = REF_FLOOR[family];
  const gr = REF_GROUND[family] / fh0;
  let L = Math.max(1, Math.round(levels || 0));
  const est = Math.max(1, Math.round((H - REF_GROUND[family]) / fh0) + 1);
  if (!Number.isFinite(L) || L < est * 0.45 || L > est * 2.4) L = est;
  const solve = (n: number): number => H / (gr + (n - 1) + CROWN_FRAC);
  let floorH = solve(L);
  if (floorH < 2.15 || floorH > 6.2) {
    floorH = clamp(floorH, 2.15, 6.2);
    L = Math.max(1, Math.round((H - floorH * (gr + CROWN_FRAC)) / floorH) + 1);
    floorH = solve(L);
  }
  floorH = clamp(floorH, 1.9, 7.5);
  let gh = H - (L - 1) * floorH - floorH * CROWN_FRAC;
  if (gh < 1.6 && L > 1) gh = H - (L - 2) * floorH - floorH * CROWN_FRAC;
  if (!(gh > 0.4)) gh = Math.max(H * 0.5, 0.4);
  return gh;
}

// ---------------------------------------------------------------------------
// results
// ---------------------------------------------------------------------------

/** A staff bracketed to a wall. `n` is the wall's outward normal. */
export interface StaffSite {
  p: THREE.Vector3;
  n: THREE.Vector2;
  /** Radians above horizontal. */
  tilt: number;
  /** +1 / -1: which way along the wall the flag streams. */
  side: number;
  scale: number;
}

/** A vertical pole standing on a roof deck. */
export interface PoleSite {
  p: THREE.Vector3;
  scale: number;
}

/** A banner hung from the top of its own drop; `p` is the top edge centre. */
export interface BannerSite {
  p: THREE.Vector3;
  n: THREE.Vector2;
  scale: number;
}

export interface FlagPlan {
  staff: StaffSite[];
  pole: PoleSite[];
  banner: BannerSite[];
  /** Buildings considered, for the log line. */
  examined: number;
}

// ---------------------------------------------------------------------------
// footprint index
// ---------------------------------------------------------------------------

/**
 * Every footprint in (and just around) the flag zone, packed into typed
 * arrays with a coarse grid over them. The JSON records are dropped a shard at
 * a time; holding 61k of them to the end of placement costs eighty megabytes
 * for no reason, and `core/data.ts` would cache them forever besides — hence
 * the bare `fetch` below rather than `loadBuildings`.
 */
class Footprints {
  private vx: number[] = [];
  private off: number[] = [0];
  private bb: number[] = [];
  private grid = new Map<number, number[]>();
  count = 0;

  add(outline: number[]): number {
    let x0 = Infinity; let z0 = Infinity; let x1 = -Infinity; let z1 = -Infinity;
    for (let i = 0; i + 1 < outline.length; i += 2) {
      const x = outline[i];
      const z = outline[i + 1];
      this.vx.push(x, z);
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (z < z0) z0 = z;
      if (z > z1) z1 = z;
    }
    const id = this.count++;
    this.off.push(this.vx.length >> 1);
    this.bb.push(x0, z0, x1, z1);
    for (let cx = Math.floor(x0 / CELL); cx <= Math.floor(x1 / CELL); cx++) {
      for (let cz = Math.floor(z0 / CELL); cz <= Math.floor(z1 / CELL); cz++) {
        const key = (cx + 512) * 4096 + (cz + 512);
        const b = this.grid.get(key);
        if (b) b.push(id);
        else this.grid.set(key, [id]);
      }
    }
    return id;
  }

  /** Vertex range of footprint `id`, as [startVertex, endVertex). */
  range(id: number): [number, number] {
    return [this.off[id], this.off[id + 1]];
  }

  vert(v: number, out: THREE.Vector2): THREE.Vector2 {
    return out.set(this.vx[v * 2], this.vx[v * 2 + 1]);
  }

  private hits(id: number, px: number, pz: number): boolean {
    if (px < this.bb[id * 4] || px > this.bb[id * 4 + 2]) return false;
    if (pz < this.bb[id * 4 + 1] || pz > this.bb[id * 4 + 3]) return false;
    const s = this.off[id];
    const e = this.off[id + 1];
    const n = e - s;
    let inside = false;
    for (let i = 0, j = n - 1; i < n; j = i++) {
      const xi = this.vx[(s + i) * 2];
      const zi = this.vx[(s + i) * 2 + 1];
      const xj = this.vx[(s + j) * 2];
      const zj = this.vx[(s + j) * 2 + 1];
      if (zi > pz !== zj > pz && px < ((xj - xi) * (pz - zi)) / (zj - zi) + xi) inside = !inside;
    }
    return inside;
  }

  /** True when any footprint other than `self` covers the point. */
  occupied(px: number, pz: number, self: number): boolean {
    const cx = Math.floor(px / CELL);
    const cz = Math.floor(pz / CELL);
    for (let a = cx - 1; a <= cx + 1; a++) {
      for (let b = cz - 1; b <= cz + 1; b++) {
        const bucket = this.grid.get((a + 512) * 4096 + (b + 512));
        if (!bucket) continue;
        for (let i = 0; i < bucket.length; i++) {
          const id = bucket[i];
          if (id !== self && this.hits(id, px, pz)) return true;
        }
      }
    }
    return false;
  }
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function hash32(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

function neighbourhood(x: number, z: number): number {
  let w = 0;
  for (const [ax, az, rad, amp] of ANCHORS) {
    const d = Math.hypot(x - ax, z - az) / rad;
    const k = amp * Math.exp(-d * Math.sqrt(d));
    if (k > w) w = k;
  }
  return w;
}

function smoothstep(a: number, b: number, x: number): number {
  const t = clamp((x - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
}

function signedArea(o: readonly number[]): number {
  const n = o.length >> 1;
  let a = 0;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    a += o[j * 2] * o[i * 2 + 1] - o[i * 2] * o[j * 2 + 1];
  }
  return a * 0.5;
}

interface Edge {
  /** Endpoints. */
  x0: number; z0: number; x1: number; z1: number;
  /** Outward normal. */
  nx: number; nz: number;
  len: number;
  /** Clear metres in front of the wall's midpoint. */
  open: number;
}

/** Street-facing edges of one footprint, longest-and-most-open first. */
function frontages(fp: Footprints, id: number, minLen: number): Edge[] {
  const [s, e] = fp.range(id);
  const n = e - s;
  if (n < 3) return [];
  const a = new THREE.Vector2();
  const b = new THREE.Vector2();
  // Canonical winding first: outward is (dz, -dx) only for a positive ring.
  let area = 0;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    fp.vert(s + i, a);
    fp.vert(s + j, b);
    area += b.x * a.y - a.x * b.y;
  }
  const sgn = area >= 0 ? 1 : -1;

  const out: Edge[] = [];
  for (let i = 0; i < n; i++) {
    fp.vert(s + i, a);
    fp.vert(s + ((i + 1) % n), b);
    const dx = b.x - a.x;
    const dz = b.y - a.y;
    const len = Math.hypot(dx, dz);
    if (len < minLen) continue;
    const nx = (dz / len) * sgn;
    const nz = (-dx / len) * sgn;
    const mx = (a.x + b.x) * 0.5;
    const mz = (a.y + b.y) * 0.5;
    let open = 0;
    for (const d of PROBE) {
      if (fp.occupied(mx + nx * d, mz + nz * d, id)) break;
      open = d;
    }
    if (open < MIN_OPEN) continue;
    out.push({ x0: a.x, z0: a.y, x1: b.x, z1: b.y, nx, nz, len, open });
  }
  return out;
}

// ---------------------------------------------------------------------------
// the pass
// ---------------------------------------------------------------------------

interface Candidate {
  fp: number;
  H: number;
  base: number;
  levels: number;
  family: number;
  flat: boolean;
  tier: number;
  /** Draws, taken up front so a building's flags never depend on each other. */
  rTilt: number;
  rScale: number;
  rPoleScale: number;
  wantStaff: boolean;
  wantPole: boolean;
  /** Banner desirability; banners are ranked, not sampled. -1 means never. */
  bannerScore: number;
  staffCount: 1 | 2 | 3;
}

/** Banner candidates are ranked, so they need a score alongside the site. */
interface RankedBanner extends BannerSite {
  score: number;
}

/** How many of the best banner candidates get their frontages measured. */
const BANNER_SHORTLIST = 220;

export async function planFlags(): Promise<FlagPlan> {
  let manifest: CityManifest;
  try {
    manifest = await loadManifest();
  } catch {
    return { staff: [], pole: [], banner: [], examined: 0 };
  }

  const t0 = performance.now();
  const fp = new Footprints();
  const cands: Candidate[] = [];
  let examined = 0;

  let tFetch = 0;
  let tParse = 0;
  let tScan = 0;
  for (const file of manifest.files.buildings) {
    let t = performance.now();
    const res = await fetch(dataUrl(file));
    if (!res.ok) continue;
    tFetch += performance.now() - t;
    t = performance.now();
    const recs = (await res.json()) as BuildingRecord[];
    tParse += performance.now() - t;
    t = performance.now();
    for (const r of recs) {
      examined++;
      const o = r.outline;
      if (!o || o.length < 8) continue;
      let cx = 0;
      let cz = 0;
      const n = o.length >> 1;
      for (let i = 0; i < n; i++) { cx += o[i * 2]; cz += o[i * 2 + 1]; }
      cx /= n;
      cz /= n;
      const core = neighbourhood(cx, cz);
      // Index anything that could be a *neighbour* of a candidate, so the
      // openness probe never mistakes an un-indexed building for open air.
      if (core < 0.02) continue;
      const id = fp.add(o);

      // `BuildingRecord.height` is the top of the walls above *local ground*,
      // not a height above `minHeight`; `buildings/build.ts` reads it that way
      // and so must this. Read as a relative height it put every flag on a
      // `building:part` its whole `minHeight` above the roof it is bolted to —
      // up to 88 m of clear air, which is a flag hanging in the sky.
      const minH = Math.max(0, r.minHeight || 0);
      const top = clamp(Number.isFinite(r.height) ? r.height : 6, 0, 460);
      const H = Math.max(top, minH + 2) - minH;
      // Parts are also excluded outright. They stack, so a tower modelled as
      // four of them would collect four parapet flagpoles one above the other,
      // and a part whose walls begin thirty metres up has no doorway to fly a
      // facade staff above. A flag belongs to the whole building.
      if (core < 0.1 || minH > 1 || H < 6 || r.landmark || Math.abs(signedArea(o)) < 24) continue;
      const name = r.name ?? '';
      const tier = !name ? 3 : TIER_A.test(name) ? 0 : TIER_B.test(name) ? 1 : 2;

      // Every draw up front and in a fixed order, so which flags a building
      // gets never depends on which ones it already got.
      const rnd = lcg(hash32(r.id));
      const rStaff = rnd();
      const rPole = rnd();
      const rBanner = rnd();
      const flat = (r.roof || 'flat') === 'flat';
      const wantStaff = rStaff < P_STAFF[tier] * (0.28 + 0.72 * core);
      const wantPole =
        rPole < P_POLE[tier] * (0.22 + 0.78 * core) && flat && H >= 11 && H <= 120;
      const bannerScore =
        H < 26
          ? -1
          : (0.3 + 0.7 * smoothstep(35, 170, H)) *
            core *
            [1.0, 0.85, 0.6, 0.35][tier] *
            (0.6 + 0.8 * rBanner);
      if (!wantStaff && !wantPole && bannerScore < 0) continue;

      cands.push({
        fp: id,
        H,
        base: (Number.isFinite(r.ground) ? r.ground : 0) + minH,
        levels: r.levels,
        family: FAMILY[r.material] ?? 0,
        flat,
        tier,
        rTilt: rnd(),
        rScale: rnd(),
        rPoleScale: rnd(),
        wantStaff,
        wantPole,
        bannerScore,
        staffCount: tier <= 1 ? 3 : 1,
      });
    }
    tScan += performance.now() - t;
    // Let the loading screen breathe between shards.
    await new Promise((r) => setTimeout(r, 0));
  }

  // Only the best banner candidates are worth measuring frontages for — the
  // openness probe is the one expensive thing in this module, and there are
  // two dozen banners in the whole city.
  const tIndex = performance.now();
  const scores = cands.map((c) => c.bannerScore).filter((s) => s > 0).sort((a, b) => b - a);
  const bannerFloor = scores.length > BANNER_SHORTLIST ? scores[BANNER_SHORTLIST] : 0;

  const staff: StaffSite[] = [];
  const pole: PoleSite[] = [];
  const banners: RankedBanner[] = [];

  for (const c of cands) {
    const { H, base, levels, family, flat, tier } = c;
    const wantBanner = c.bannerScore > bannerFloor;
    if (!c.wantStaff && !c.wantPole && !wantBanner) continue;

    const edges = frontages(fp, c.fp, 5);
    if (!edges.length) continue;
    edges.sort((a, b) => b.len * 0.5 + b.open * 1.6 - (a.len * 0.5 + a.open * 1.6));
    const front = edges[0];
    const { rTilt, rScale, rPoleScale } = c;

    // --- facade staffs ----------------------------------------------------
    if (c.wantStaff) {
      const gh = groundFloorHeight(H, levels, family);
      const y = base + clamp(gh + 0.25, 3.2, Math.max(3.2, H - 1.6));
      const count =
        c.staffCount === 3 && front.len >= 34 ? 3 : c.staffCount === 3 && front.len >= 17 ? 2 : 1;
      const ts = count === 1 ? [0.5] : count === 2 ? [0.35, 0.65] : [0.25, 0.5, 0.75];
      // Stream downwind: pick the along-wall direction the prevailing wind
      // favours, so a street of flags reads as one breeze and not confetti.
      const side = front.nz * 0.9394 - front.nx * 0.3429 > 0 ? 1 : -1;
      for (let i = 0; i < ts.length; i++) {
        const t = ts[i];
        staff.push({
          p: new THREE.Vector3(
            front.x0 + (front.x1 - front.x0) * t,
            y,
            front.z0 + (front.z1 - front.z0) * t,
          ),
          n: new THREE.Vector2(front.nx, front.nz),
          // 36 to 46 degrees; neighbouring staffs differ slightly, as brackets do.
          tilt: 0.63 + ((rTilt + i * 0.37) % 1) * 0.17,
          side,
          scale: 0.94 + ((rScale + i * 0.53) % 1) * 0.16,
        });
      }
    }

    // --- parapet flagpoles ------------------------------------------------
    if (c.wantPole && flat) {
      // Behind the parapet, on the deck, set back from the coping.
      const inset = Math.min(1.7, front.open * 0.25 + 1.2);
      pole.push({
        p: new THREE.Vector3(
          (front.x0 + front.x1) * 0.5 - front.nx * inset,
          base + H,
          (front.z0 + front.z1) * 0.5 - front.nz * inset,
        ),
        scale: 0.82 + rPoleScale * 0.42,
      });
    }

    // --- hanging banners --------------------------------------------------
    if (wantBanner) {
      // The most open facade, not merely the longest: a banner needs a street
      // or a square in front of it to be seen from.
      let best = front;
      let bestScore = -1;
      for (const e of edges) {
        const s = e.open * 3 + e.len * 0.35;
        if (s > bestScore) { bestScore = s; best = e; }
      }
      const drop = clamp(0.22 * H, 9, 18);
      const width = drop / 1.9;
      if (width < best.len * 0.62) {
        banners.push({
          score: c.bannerScore,
          p: new THREE.Vector3(
            (best.x0 + best.x1) * 0.5,
            base + clamp(H * 0.45, 16, Math.max(16, H - 6)),
            (best.z0 + best.z1) * 0.5,
          ),
          n: new THREE.Vector2(best.nx, best.nz),
          scale: drop / 16,
        });
      }
    }
  }

  banners.sort((a, b) => b.score - a.score);
  console.info(
    `[Props] flag sites: ${fp.count} footprints indexed, ${cands.length} candidates, ` +
    `${Math.round(tIndex - t0)} + ${Math.round(performance.now() - tIndex)} ms ` +
    `(fetch ${Math.round(tFetch)}, parse ${Math.round(tParse)}, scan ${Math.round(tScan)})`,
  );
  return { staff, pole, banner: banners.slice(0, BANNERS), examined };
}
