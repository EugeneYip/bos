/**
 * Known Boston landmarks. Another agent swaps a bespoke mesh in for each of
 * these, so the only job here is to flag the right footprint with a stable slug.
 *
 * Matching is name-based AND position-guarded: a building only earns a slug if
 * its name matches one of the aliases *and* its centroid is within `r` metres of
 * the real thing. That keeps "Trinity Church" in Copley Square from colliding
 * with an identically-named parish in Dorchester.
 */
import { lonLatToWorld } from './geo.mjs';

/**
 * Kept deliberately tight. A slug tells the renderer "a bespoke mesh exists for
 * this footprint", so over-flagging punches holes in the skyline if the mesh
 * never arrives. Every landmark record still carries a complete, valid
 * outline/height/material, so extruding one is always a safe fallback.
 *
 * slug, aliases (normalised), lat, lon, radius m
 */
const RAW = [
  // Not 'prudential center': that is the 263 x 316 m retail podium the tower
  // stands on, a separate relation and a separate building. Claiming it here
  // suppressed the whole mall in favour of a mesh that models only the tower,
  // and left the Prudential standing in an empty block.
  ['prudential-tower', ['prudential tower', 'the prudential tower', '800 boylston street'], 42.3475, -71.0821, 260],
  ['hancock-tower', ['200 clarendon', '200 clarendon street', 'john hancock tower', 'john hancock building'], 42.3488, -71.0749, 220],
  ['one-dalton', ['one dalton', 'one dalton street', 'four seasons hotel one dalton street', 'one dalton place'], 42.3466, -71.0839, 200],
  ['millennium-tower', ['millennium tower', 'millennium tower boston'], 42.3552, -71.0605, 200],
  ['state-house', ['massachusetts state house', 'the massachusetts state house', 'massachusetts statehouse', 'state house'], 42.3588, -71.0638, 220],
  ['custom-house-tower', ['custom house tower', 'custom house', "marriott's custom house", 'marriott vacation club pulse at custom house'], 42.3593, -71.0533, 200],
  // Fenway's building relation is tagged `building=stadium` and carries no
  // name, so a name-only match never finds it — and the hand-authored ballpark
  // was being placed straight through the extruded one.
  ['fenway-park', ['fenway park'], 42.3467, -71.0972, 380, { building: 'stadium' }],
  ['bunker-hill-monument', ['bunker hill monument'], 42.3763, -71.0609, 220],
  ['zakim-bridge', ['leonard p. zakim bunker hill memorial bridge', 'leonard p zakim bunker hill memorial bridge', 'zakim bridge', 'leonard p. zakim bunker hill bridge'], 42.3660, -71.0620, 700],
  ['longfellow-bridge', ['longfellow bridge'], 42.3614, -71.0742, 700],
  ['old-north-church', ['old north church', 'christ church in the city of boston', "christ church (old north church)"], 42.3663, -71.0544, 180],
  ['faneuil-hall', ['faneuil hall'], 42.3600, -71.0555, 200],
  ['quincy-market', ['quincy market'], 42.3601, -71.0546, 200],
  // MIT names its buildings by number, so the Great Dome's is called '10'. On
  // its own that alias would be reckless; guarded to 240 m of the dome it can
  // only ever be Building 10.
  ['mit-great-dome', ['great dome', 'building 10', '10', 'maclaurin buildings', 'building 10 (maclaurin buildings)', 'rogers building'], 42.3601, -71.0920, 240],
  ['south-station', ['south station', 'south station transportation center'], 42.3519, -71.0552, 340],
  ['boston-public-library', ['boston public library', 'mckim building', 'boston public library, mckim building', 'boston public library - central library', 'central library'], 42.3494, -71.0784, 250],
  ['trinity-church', ['trinity church', 'trinity church in the city of boston'], 42.3499, -71.0757, 180],
  ['old-state-house', ['old state house'], 42.3588, -71.0576, 150],
  ['boston-city-hall', ['boston city hall', 'city hall'], 42.3603, -71.0578, 220],
  ['td-garden', ['td garden', 'td banknorth garden', 'boston garden'], 42.3662, -71.0621, 300],
  // OpenStreetMap traces the ship herself as `building=yes` + `historic=ship`
  // (w166151194), so without this she extrudes as a 62 x 11 m, 9.6 m tall
  // plaster slab in the middle of the hand-authored frigate.
  // Campus landmarks. Each hand-authored mesh needs its OSM footprint claimed,
  // or both are drawn — the mistake that had every landmark in the city doubled
  // until `main.ts` was reordered. Radii are tight: 'Richards Hall' and
  // 'Memorial Church' are not unique names in greater Boston.
  ['harvard-widener', ['widener library', 'harry elkins widener memorial library', 'widener'], 42.373476, -71.116471, 90],
  ['harvard-memorial-church', ['memorial church', 'the memorial church'], 42.374904, -71.116060, 80],
  ['harvard-sever-hall', ['sever hall'], 42.374333, -71.115446, 80],
  ['mit-kresge', ['kresge auditorium', 'w16 kresge auditorium'], 42.358145, -71.095050, 90],
  ['mit-stata-center', ['stata center', 'ray and maria stata center', '32 stata center'], 42.361671, -71.090597, 110],
  // OpenStreetMap has no building named 'Snell Library' or 'Matthews Arena'
  // anywhere in the extract; the nearest footprint to this anchor is Ell Hall,
  // six metres away. These two therefore claim nothing and suppress nothing,
  // which is the safe failure: a mesh drawn beside a building that is also
  // drawn, rather than a hole where a building used to be.
  ['neu-snell-library', ['snell library'], 42.339799, -71.088003, 70],
  ['neu-churchill-hall', ['churchill hall'], 42.33877, -71.08890, 50],
  ['neu-richards-hall', ['richards hall'], 42.33987, -71.08884, 55],
  ['neu-matthews-arena', ['matthews arena'], 42.34111, -71.08444, 80],
  ['uss-constitution', ['uss constitution'], 42.3724, -71.0566, 120],
  // Logan's control tower. Unlike Fenway's relation this way *is* named in
  // OpenStreetMap ('Boston Air Traffic Control Tower', w197731405), so the
  // ordinary name rule reaches it and no tag- or id-guarded special case is
  // needed. The radius is tight because 'air traffic control tower' on its own
  // is a generic string that any airfield in the extract could carry.
  ['boston-atc-tower', ['boston air traffic control tower', 'boston atc tower', 'logan control tower', 'logan airport control tower', 'air traffic control tower'], 42.365753, -71.018422, 120],
];

const TABLE = RAW.filter((e) => e[4] > 0).map(([slug, names, lat, lon, r, tag]) => {
  const [x, z] = lonLatToWorld(lon, lat);
  return { slug, names: new Set(names), x, z, r2: r * r, tag };
});

export function normaliseName(n) {
  return String(n)
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[‘’“”]/g, "'")
    .replace(/[^a-z0-9' ,&().-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * @param {string|undefined} name  the building's name, if it has one
 * @param {number} x  world metres
 * @param {number} z  world metres
 * @param {object} [tags]  the raw OSM tags, for the few landmarks with no name
 * @returns {string|undefined} landmark slug
 */
export function matchLandmark(name, x, z, tags) {
  // A handful of landmarks are unnamed in OpenStreetMap and can only be
  // recognised by a tag. The tag rule is still position-guarded, and it is
  // deliberately per-landmark rather than general: `building=stadium` anywhere
  // else in the city must not claim Fenway's slug.
  for (const e of TABLE) {
    if (!e.tag || !tags) continue;
    let ok = true;
    for (const [k, v] of Object.entries(e.tag)) if (tags[k] !== v) { ok = false; break; }
    if (!ok) continue;
    const dx = x - e.x, dz = z - e.z;
    if (dx * dx + dz * dz <= e.r2) return e.slug;
  }
  if (!name) return undefined;
  const n = normaliseName(name);
  const bare = n.replace(/[,.()']/g, '').replace(/\s+/g, ' ').trim();
  for (const e of TABLE) {
    if (!e.names.has(n) && !e.names.has(bare)) {
      let hit = false;
      for (const alias of e.names) {
        if (alias.replace(/[,.()']/g, '') === bare) { hit = true; break; }
      }
      if (!hit) continue;
    }
    const dx = x - e.x, dz = z - e.z;
    if (dx * dx + dz * dz <= e.r2) return e.slug;
  }
  return undefined;
}

export const LANDMARK_SLUGS = TABLE.map((e) => e.slug);
