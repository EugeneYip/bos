/**
 * Hand-digitised Boston neighbourhood envelopes plus the architectural profile of
 * each one. This is the difference between "a city" and "Boston": OSM tells us
 * where the walls are, but not that Back Bay is four storeys of mansarded
 * brownstone and the Financial District is thirty of glass.
 *
 * Polygons are deliberately coarse (4-8 vertices, lon/lat) and are tested in
 * priority order — first match wins — so specific cores are listed before the
 * districts that surround them.
 */
import { lonLatToWorld } from './geo.mjs';
import { pointInRing, hash32, rand1 } from './geom.mjs';

/**
 * @typedef {object} Profile
 * @property {[number,number]} residential  min/max storeys for dwellings
 * @property {[number,number]} commercial
 * @property {[number,number]} civic        schools, churches, institutions
 * @property {[number,number]} industrial
 * @property {number} aLo   sqrt(footprint m2) that maps to the bottom of the range
 * @property {number} aHi   sqrt(footprint m2) that maps to the top
 * @property {string[]} walls   weighted material bag (repeat an entry to weight it)
 * @property {string[]} roofs   weighted RoofShape bag for small footprints
 * @property {number} towerBias 0..1 — how often a large footprint goes high-rise
 */

/** @type {Record<string, Profile>} */
export const PROFILES = {
  downtown: {
    residential: [6, 30], commercial: [5, 34], civic: [3, 12], industrial: [2, 6],
    aLo: 16, aHi: 70, towerBias: 0.85,
    walls: ['glass', 'glass', 'glass', 'stone', 'stone', 'concrete', 'brick', 'metal'],
    roofs: ['flat', 'flat', 'flat', 'flat', 'flat', 'pyramidal'],
  },
  government_center: {
    residential: [4, 10], commercial: [4, 14], civic: [3, 10], industrial: [2, 5],
    aLo: 18, aHi: 70, towerBias: 0.5,
    walls: ['concrete', 'concrete', 'concrete', 'stone', 'brick', 'glass'],
    roofs: ['flat', 'flat', 'flat', 'flat'],
  },
  back_bay: {
    residential: [4, 6], commercial: [4, 9], civic: [2, 5], industrial: [2, 4],
    aLo: 11, aHi: 34, towerBias: 0.22,
    walls: ['brick', 'brick', 'brick', 'brownstone', 'brownstone', 'brownstone', 'stone'],
    roofs: ['mansard', 'mansard', 'mansard', 'flat', 'flat', 'gabled'],
  },
  beacon_hill: {
    residential: [3, 5], commercial: [3, 6], civic: [2, 4], industrial: [2, 3],
    aLo: 9, aHi: 26, towerBias: 0.08,
    walls: ['brick', 'brick', 'brick', 'brick', 'brownstone', 'stone'],
    roofs: ['flat', 'flat', 'flat', 'gabled', 'gabled', 'mansard'],
  },
  north_end: {
    residential: [4, 5], commercial: [3, 6], civic: [2, 4], industrial: [2, 4],
    aLo: 9, aHi: 26, towerBias: 0.08,
    walls: ['brick', 'brick', 'brick', 'brick', 'brick', 'plaster', 'brownstone'],
    roofs: ['flat', 'flat', 'flat', 'flat', 'gabled'],
  },
  west_end: {
    residential: [6, 16], commercial: [4, 12], civic: [3, 9], industrial: [2, 5],
    aLo: 16, aHi: 60, towerBias: 0.6,
    walls: ['concrete', 'brick', 'brick', 'glass', 'stone'],
    roofs: ['flat', 'flat', 'flat', 'flat'],
  },
  chinatown: {
    residential: [4, 12], commercial: [4, 14], civic: [3, 7], industrial: [2, 5],
    aLo: 11, aHi: 40, towerBias: 0.45,
    walls: ['brick', 'brick', 'brick', 'concrete', 'stone', 'glass'],
    roofs: ['flat', 'flat', 'flat', 'flat', 'mansard'],
  },
  south_end: {
    residential: [3, 5], commercial: [3, 6], civic: [2, 4], industrial: [2, 4],
    aLo: 10, aHi: 30, towerBias: 0.12,
    walls: ['brick', 'brick', 'brick', 'brick', 'brownstone', 'brownstone', 'brownstone'],
    roofs: ['mansard', 'mansard', 'flat', 'flat', 'flat', 'gabled'],
  },
  fort_point: {
    residential: [4, 8], commercial: [4, 9], civic: [3, 6], industrial: [3, 7],
    aLo: 14, aHi: 48, towerBias: 0.3,
    walls: ['brick', 'brick', 'brick', 'brick', 'stone', 'concrete'],
    roofs: ['flat', 'flat', 'flat', 'flat', 'flat', 'gabled'],
  },
  seaport: {
    residential: [6, 20], commercial: [5, 22], civic: [2, 8], industrial: [1, 4],
    aLo: 18, aHi: 70, towerBias: 0.75,
    walls: ['glass', 'glass', 'glass', 'metal', 'concrete', 'stone', 'brick'],
    roofs: ['flat', 'flat', 'flat', 'flat', 'flat', 'skillion'],
  },
  fenway: {
    residential: [4, 10], commercial: [3, 12], civic: [3, 8], industrial: [2, 5],
    aLo: 12, aHi: 45, towerBias: 0.4,
    walls: ['brick', 'brick', 'brick', 'brownstone', 'concrete', 'glass', 'stone'],
    roofs: ['flat', 'flat', 'flat', 'mansard', 'gabled'],
  },
  longwood: {
    residential: [4, 9], commercial: [4, 14], civic: [4, 15], industrial: [2, 6],
    aLo: 16, aHi: 60, towerBias: 0.6,
    walls: ['brick', 'brick', 'concrete', 'glass', 'glass', 'stone'],
    roofs: ['flat', 'flat', 'flat', 'flat'],
  },
  mission_hill: {
    residential: [3, 4], commercial: [2, 5], civic: [2, 5], industrial: [1, 4],
    aLo: 9, aHi: 26, towerBias: 0.1,
    walls: ['wood', 'wood', 'wood', 'brick', 'brick', 'plaster'],
    roofs: ['gabled', 'gabled', 'hipped', 'hipped', 'flat', 'mansard'],
  },
  triple_decker: {
    // Dorchester / Southie / Roxbury / Somerville / Charlestown / East Boston:
    // three-storey wood-frame flats, ~10.5 m, hipped or gabled.
    residential: [2, 3], commercial: [1, 4], civic: [1, 4], industrial: [1, 3],
    aLo: 8, aHi: 24, towerBias: 0.05,
    walls: ['wood', 'wood', 'wood', 'wood', 'wood', 'brick', 'plaster'],
    roofs: ['gabled', 'gabled', 'hipped', 'hipped', 'hipped', 'flat'],
  },
  charlestown: {
    residential: [2, 4], commercial: [2, 5], civic: [2, 5], industrial: [1, 4],
    aLo: 8, aHi: 24, towerBias: 0.08,
    walls: ['brick', 'brick', 'brick', 'wood', 'wood', 'plaster'],
    roofs: ['gabled', 'gabled', 'flat', 'flat', 'hipped', 'mansard'],
  },
  suburban: {
    residential: [1, 3], commercial: [1, 3], civic: [1, 4], industrial: [1, 3],
    aLo: 8, aHi: 22, towerBias: 0.04,
    walls: ['wood', 'wood', 'wood', 'wood', 'brick', 'plaster', 'stone'],
    roofs: ['gabled', 'gabled', 'gabled', 'hipped', 'hipped', 'pyramidal'],
  },
  campus: {
    residential: [3, 8], commercial: [2, 8], civic: [3, 9], industrial: [1, 4],
    aLo: 13, aHi: 55, towerBias: 0.3,
    walls: ['brick', 'brick', 'brick', 'stone', 'stone', 'concrete', 'glass'],
    roofs: ['flat', 'flat', 'flat', 'gabled', 'hipped', 'mansard'],
  },
  kendall: {
    residential: [4, 14], commercial: [4, 18], civic: [3, 9], industrial: [1, 5],
    aLo: 15, aHi: 60, towerBias: 0.7,
    walls: ['glass', 'glass', 'concrete', 'brick', 'brick', 'metal'],
    roofs: ['flat', 'flat', 'flat', 'flat'],
  },
  industrial: {
    residential: [2, 4], commercial: [1, 4], civic: [1, 4], industrial: [1, 4],
    aLo: 12, aHi: 60, towerBias: 0.05,
    walls: ['metal', 'metal', 'concrete', 'concrete', 'brick', 'wood'],
    roofs: ['flat', 'flat', 'flat', 'skillion', 'gabled'],
  },
  airport: {
    residential: [1, 3], commercial: [1, 5], civic: [1, 6], industrial: [1, 4],
    aLo: 15, aHi: 80, towerBias: 0.15,
    walls: ['metal', 'metal', 'concrete', 'glass', 'glass'],
    roofs: ['flat', 'flat', 'flat', 'skillion'],
  },
};

/** Priority-ordered neighbourhood envelopes. First containing polygon wins. */
export const NEIGHBOURHOODS = [
  ['government-center', 'government_center', [[-71.0632, 42.3578], [-71.0552, 42.3572], [-71.0540, 42.3632], [-71.0636, 42.3634]]],
  ['financial-district', 'downtown', [[-71.0648, 42.3548], [-71.0578, 42.3500], [-71.0472, 42.3522], [-71.0462, 42.3606], [-71.0552, 42.3644], [-71.0650, 42.3604]]],
  ['north-end', 'north_end', [[-71.0612, 42.3618], [-71.0524, 42.3592], [-71.0474, 42.3662], [-71.0532, 42.3712], [-71.0624, 42.3684]]],
  ['beacon-hill', 'beacon_hill', [[-71.0742, 42.3552], [-71.0618, 42.3542], [-71.0604, 42.3622], [-71.0736, 42.3628]]],
  ['west-end', 'west_end', [[-71.0714, 42.3596], [-71.0602, 42.3600], [-71.0566, 42.3690], [-71.0700, 42.3684]]],
  ['chinatown', 'chinatown', [[-71.0668, 42.3474], [-71.0540, 42.3478], [-71.0546, 42.3536], [-71.0662, 42.3540]]],
  ['bay-village', 'south_end', [[-71.0726, 42.3462], [-71.0660, 42.3468], [-71.0664, 42.3512], [-71.0724, 42.3510]]],
  ['back-bay', 'back_bay', [[-71.0698, 42.3562], [-71.0686, 42.3486], [-71.0892, 42.3452], [-71.0912, 42.3528]]],
  ['fort-point', 'fort_point', [[-71.0576, 42.3432], [-71.0472, 42.3428], [-71.0468, 42.3524], [-71.0578, 42.3528]]],
  ['seaport', 'seaport', [[-71.0548, 42.3396], [-71.0286, 42.3392], [-71.0282, 42.3538], [-71.0474, 42.3552], [-71.0562, 42.3488]]],
  ['south-end', 'south_end', [[-71.0688, 42.3492], [-71.0600, 42.3424], [-71.0688, 42.3344], [-71.0836, 42.3394], [-71.0894, 42.3468]]],
  ['kenmore-fenway', 'fenway', [[-71.1096, 42.3396], [-71.0872, 42.3402], [-71.0878, 42.3534], [-71.1090, 42.3520]]],
  ['longwood', 'longwood', [[-71.1150, 42.3318], [-71.0966, 42.3320], [-71.0972, 42.3442], [-71.1148, 42.3438]]],
  ['mission-hill', 'mission_hill', [[-71.1136, 42.3234], [-71.0930, 42.3238], [-71.0938, 42.3370], [-71.1132, 42.3362]]],
  ['charlestown', 'charlestown', [[-71.0790, 42.3672], [-71.0502, 42.3648], [-71.0460, 42.3874], [-71.0800, 42.3902]]],
  ['logan-airport', 'airport', [[-71.0348, 42.3540], [-71.0060, 42.3536], [-71.0060, 42.3822], [-71.0344, 42.3800]]],
  ['east-boston', 'triple_decker', [[-71.0466, 42.3538], [-71.0060, 42.3530], [-71.0060, 42.3960], [-71.0452, 42.3960]]],
  ['chelsea', 'triple_decker', [[-71.0530, 42.3800], [-71.0060, 42.3790], [-71.0060, 42.3960], [-71.0516, 42.3960]]],
  ['everett-industrial', 'industrial', [[-71.0800, 42.3880], [-71.0520, 42.3872], [-71.0520, 42.3960], [-71.0800, 42.3960]]],
  ['south-boston', 'triple_decker', [[-71.0586, 42.3286], [-71.0220, 42.3282], [-71.0222, 42.3438], [-71.0580, 42.3446]]],
  ['columbia-point', 'campus', [[-71.0520, 42.3180], [-71.0270, 42.3180], [-71.0270, 42.3306], [-71.0520, 42.3306]]],
  ['dorchester', 'triple_decker', [[-71.0920, 42.3180], [-71.0400, 42.3180], [-71.0404, 42.3352], [-71.0918, 42.3346]]],
  ['roxbury', 'triple_decker', [[-71.1010, 42.3180], [-71.0620, 42.3184], [-71.0616, 42.3420], [-71.1006, 42.3402]]],
  ['allston-brighton', 'triple_decker', [[-71.1320, 42.3432], [-71.1020, 42.3440], [-71.1024, 42.3712], [-71.1320, 42.3706]]],
  ['brookline', 'suburban', [[-71.1320, 42.3180], [-71.1020, 42.3184], [-71.1026, 42.3436], [-71.1320, 42.3430]]],
  ['kendall-square', 'kendall', [[-71.0960, 42.3574], [-71.0744, 42.3568], [-71.0748, 42.3708], [-71.0956, 42.3714]]],
  ['mit-campus', 'campus', [[-71.1052, 42.3528], [-71.0930, 42.3536], [-71.0938, 42.3646], [-71.1058, 42.3640]]],
  ['east-cambridge', 'triple_decker', [[-71.0960, 42.3700], [-71.0700, 42.3696], [-71.0706, 42.3800], [-71.0958, 42.3806]]],
  ['central-square', 'triple_decker', [[-71.1180, 42.3528], [-71.1040, 42.3532], [-71.1046, 42.3760], [-71.1176, 42.3752]]],
  ['harvard-square', 'campus', [[-71.1320, 42.3644], [-71.1160, 42.3650], [-71.1166, 42.3846], [-71.1320, 42.3840]]],
  ['north-cambridge', 'suburban', [[-71.1320, 42.3840], [-71.1100, 42.3838], [-71.1104, 42.3960], [-71.1320, 42.3960]]],
  ['somerville', 'triple_decker', [[-71.1110, 42.3730], [-71.0680, 42.3722], [-71.0684, 42.3960], [-71.1110, 42.3960]]],
];

// Pre-project the envelopes to world metres so the hot loop is cheap.
const RINGS = NEIGHBOURHOODS.map(([name, profile, ll]) => {
  const flat = [];
  for (const [lon, lat] of ll) { const [x, z] = lonLatToWorld(lon, lat); flat.push(x, z); }
  let minX = Infinity, minZ = Infinity, maxX = -Infinity, maxZ = -Infinity;
  for (let i = 0; i < flat.length; i += 2) {
    minX = Math.min(minX, flat[i]); maxX = Math.max(maxX, flat[i]);
    minZ = Math.min(minZ, flat[i + 1]); maxZ = Math.max(maxZ, flat[i + 1]);
  }
  return { name, profile, flat, minX, minZ, maxX, maxZ };
});

/** Downtown centre (State St) used for the distance-based fallback. */
const [DTX, DTZ] = lonLatToWorld(-71.0570, 42.3580);

/** @returns {{name:string, profile:Profile, key:string}} */
export function neighbourhoodAt(x, z) {
  for (const r of RINGS) {
    if (x < r.minX || x > r.maxX || z < r.minZ || z > r.maxZ) continue;
    if (pointInRing(r.flat, x, z)) {
      return { name: r.name, key: r.profile, profile: PROFILES[r.profile] };
    }
  }
  // Anything unclaimed: near the core reads as mixed urban, far out as suburban.
  const d = Math.hypot(x - DTX, z - DTZ);
  const key = d < 1500 ? 'chinatown' : d < 3500 ? 'triple_decker' : 'suburban';
  return { name: 'other', key, profile: PROFILES[key] };
}

// ---------------------------------------------------------------------------
// Colour
// ---------------------------------------------------------------------------

function hsl(h, s, l) {
  h = ((h % 360) + 360) / 360;
  const a = s * Math.min(l, 1 - l);
  const f = (n) => {
    const k = (n + h * 12) % 12;
    return l - a * Math.max(-1, Math.min(k - 3, Math.min(9 - k, 1)));
  };
  const r = Math.round(Math.min(255, Math.max(0, f(0) * 255)));
  const g = Math.round(Math.min(255, Math.max(0, f(8) * 255)));
  const b = Math.round(Math.min(255, Math.max(0, f(4) * 255)));
  return (r << 16) | (g << 8) | b;
}

const lerp = (a, b, t) => a + (b - a) * t;

/** Clapboard families for the wood-frame belts; picked per building, not per zone. */
const WOOD_FAMILIES = [
  [95, 0.04, 0.56],   // weathered grey
  [108, 0.14, 0.44],  // muted sage green
  [140, 0.12, 0.36],  // dark forest green
  [48, 0.30, 0.66],   // pale ochre / buttercream
  [40, 0.10, 0.80],   // white
  [205, 0.12, 0.55],  // blue-grey
  [28, 0.14, 0.50],   // taupe
  [18, 0.24, 0.42],   // barn red-brown
  [210, 0.06, 0.36],  // charcoal
];

/**
 * Deterministic wall colour. Seeded from the OSM id so a rebuild produces the
 * exact same city, and varied enough that no two neighbours match.
 */
export function wallColour(material, id) {
  const r1 = rand1(id, 'h'), r2 = rand1(id, 's'), r3 = rand1(id, 'l');
  switch (material) {
    case 'brick':
      return hsl(lerp(6, 22, r1), lerp(0.28, 0.55, r2), lerp(0.27, 0.45, r3));
    case 'brownstone':
      return hsl(lerp(16, 34, r1), lerp(0.16, 0.36, r2), lerp(0.24, 0.40, r3));
    case 'glass': {
      // Two families: the cool blue-green curtain wall and the bronze/grey one.
      if (r2 < 0.22) return hsl(lerp(28, 44, r1), lerp(0.08, 0.20, r2 * 4), lerp(0.30, 0.44, r3));
      return hsl(lerp(178, 218, r1), lerp(0.10, 0.34, r2), lerp(0.26, 0.48, r3));
    }
    case 'stone':
      return hsl(lerp(26, 50, r1), lerp(0.04, 0.17, r2), lerp(0.52, 0.76, r3));
    case 'concrete':
      return hsl(lerp(24, 46, r1), lerp(0.01, 0.09, r2), lerp(0.46, 0.68, r3));
    case 'metal':
      return hsl(lerp(196, 224, r1), lerp(0.01, 0.09, r2), lerp(0.46, 0.68, r3));
    case 'wood': {
      const f = WOOD_FAMILIES[Math.floor(r1 * WOOD_FAMILIES.length) % WOOD_FAMILIES.length];
      return hsl(f[0] + (r2 - 0.5) * 14, f[1] * lerp(0.75, 1.3, r3), f[2] * lerp(0.9, 1.1, r2));
    }
    case 'plaster':
    default:
      return hsl(lerp(30, 54, r1), lerp(0.06, 0.26, r2), lerp(0.62, 0.84, r3));
  }
}

export function roofColour(shape, material, id) {
  const r1 = rand1(id, 'rh'), r2 = rand1(id, 'rl');
  if (shape === 'dome') return r1 < 0.5 ? hsl(152, 0.30, 0.42) : hsl(44, 0.32, 0.52);
  if (shape === 'mansard') return hsl(lerp(200, 226, r1), lerp(0.03, 0.10, r2), lerp(0.17, 0.27, r2));
  if (shape === 'flat') {
    // Tar-and-gravel and single-ply membrane: near-neutral, slightly warm.
    return hsl(lerp(24, 226, r1), 0.04, lerp(0.16, 0.30, r2));
  }
  if (material === 'wood' || material === 'plaster') {
    return r1 < 0.5
      ? hsl(lerp(20, 36, r2), lerp(0.06, 0.18, r1), lerp(0.20, 0.34, r2)) // asphalt shingle
      : hsl(lerp(200, 220, r2), lerp(0.03, 0.10, r1), lerp(0.22, 0.36, r2)); // slate grey
  }
  return hsl(lerp(200, 224, r1), lerp(0.02, 0.09, r2), lerp(0.18, 0.32, r2));
}

/** Pick from a weighted bag deterministically. */
export const pick = (bag, id, salt) => bag[Math.floor(rand1(id, salt) * bag.length) % bag.length];

export { hsl, hash32 };
