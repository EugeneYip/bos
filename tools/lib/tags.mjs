/** OSM tag value parsing: lengths with units, colours, materials, roof shapes. */

/**
 * Parse an OSM length. Handles `12`, `12 m`, `12m`, `12.5`, `12,5`,
 * `40'`, `40 ft`, `40 feet`, `12'6"`.
 * @returns {number|null} metres
 */
export function parseLength(v) {
  if (v == null) return null;
  let s = String(v).trim().toLowerCase().replace(/’/g, "'").replace(/”/g, '"');
  if (!s) return null;
  // feet + inches, e.g. 12'6"
  let m = s.match(/^(-?\d+(?:[.,]\d+)?)\s*(?:'|ft|feet|foot)\s*(\d+(?:[.,]\d+)?)?\s*(?:"|''|in|inch|inches)?$/);
  if (m) {
    const ft = parseFloat(m[1].replace(',', '.'));
    const inch = m[2] ? parseFloat(m[2].replace(',', '.')) : 0;
    if (!Number.isFinite(ft)) return null;
    return ft * 0.3048 + inch * 0.0254;
  }
  m = s.match(/^(-?\d+(?:[.,]\d+)?)\s*(m|meter|meters|metre|metres)?$/);
  if (m) {
    const n = parseFloat(m[1].replace(',', '.'));
    return Number.isFinite(n) ? n : null;
  }
  // last resort: leading number
  m = s.match(/^(-?\d+(?:[.,]\d+)?)/);
  if (!m) return null;
  const n = parseFloat(m[1].replace(',', '.'));
  if (!Number.isFinite(n)) return null;
  return /ft|feet|'/.test(s) ? n * 0.3048 : n;
}

/** Parse a levels tag; tolerates `4`, `4.5`, `3;4` (takes the max). */
export function parseLevels(v) {
  if (v == null) return null;
  const parts = String(v).split(/[;,]/).map((p) => parseFloat(p.replace(',', '.'))).filter(Number.isFinite);
  if (!parts.length) return null;
  const n = Math.max(...parts);
  return n > 0 && n < 200 ? n : null;
}

const CSS_COLOURS = {
  white: 0xffffff, silver: 0xc0c0c0, gray: 0x808080, grey: 0x808080, black: 0x1a1a1a,
  red: 0xb03a2e, maroon: 0x800000, brown: 0x8b5a2b, sienna: 0xa0522d, tan: 0xd2b48c,
  beige: 0xe8dcc0, cream: 0xf0e6d2, ivory: 0xf2ead3, yellow: 0xd9c35a, gold: 0xc8a63a,
  orange: 0xd08030, olive: 0x808000, green: 0x4a7a4a, darkgreen: 0x2f4f2f, lime: 0x7ab648,
  teal: 0x3f7f7f, blue: 0x40607f, navy: 0x2a3a55, lightblue: 0x9fb6c8, skyblue: 0x87ceeb,
  purple: 0x6a4a7a, pink: 0xd8a0a8, darkred: 0x7a2e28, lightgrey: 0xd0d0d0,
  lightgray: 0xd0d0d0, darkgrey: 0x4a4a4a, darkgray: 0x4a4a4a, sandstone: 0xc2a476,
  brick: 0x9c4a35, terracotta: 0xb45f3f, copper: 0x7a9a7a, bronze: 0x7a5a3a,
};

/** Parse `#rrggbb`, `#rgb`, `rgb(r,g,b)` or a CSS colour name. @returns {number|null} */
export function parseColour(v) {
  if (v == null) return null;
  const s = String(v).trim().toLowerCase();
  let m = s.match(/^#([0-9a-f]{6})$/);
  if (m) return parseInt(m[1], 16);
  m = s.match(/^#([0-9a-f]{3})$/);
  if (m) {
    const r = parseInt(m[1][0], 16), g = parseInt(m[1][1], 16), b = parseInt(m[1][2], 16);
    return (r * 17 << 16) | (g * 17 << 8) | (b * 17);
  }
  m = s.match(/^rgb\s*\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*\)$/);
  if (m) return (+m[1] << 16) | (+m[2] << 8) | (+m[3]);
  const key = s.replace(/[\s_-]/g, '');
  if (key in CSS_COLOURS) return CSS_COLOURS[key];
  return null;
}

const MATERIALS = {
  brick: 'brick', bricks: 'brick', brick_block: 'brick', red_brick: 'brick',
  brickwork: 'brick', clinker: 'brick', terracotta: 'brick', tile: 'brick',
  sandstone: 'brownstone', brownstone: 'brownstone',
  glass: 'glass', mirror: 'glass', glass_curtain_wall: 'glass',
  concrete: 'concrete', reinforced_concrete: 'concrete', cement: 'concrete',
  cement_block: 'concrete', precast_concrete: 'concrete', breeze_block: 'concrete',
  stone: 'stone', granite: 'stone', limestone: 'stone', marble: 'stone',
  masonry: 'stone', slate: 'stone', ashlar: 'stone', travertine: 'stone', rock: 'stone',
  metal: 'metal', steel: 'metal', aluminium: 'metal', aluminum: 'metal',
  corrugated_metal: 'metal', copper: 'metal', zinc: 'metal', iron: 'metal', tin: 'metal',
  wood: 'wood', timber: 'wood', timber_framing: 'wood', clapboard: 'wood',
  shingle: 'wood', shingles: 'wood', log: 'wood', vinyl_siding: 'wood', vinyl: 'wood',
  wood_shingle: 'wood', weatherboard: 'wood', siding: 'wood',
  plaster: 'plaster', stucco: 'plaster', render: 'plaster', plastered: 'plaster',
  cement_render: 'plaster', eifs: 'plaster', roughcast: 'plaster',
};

/** @returns {import('../../src/core/types').BuildingMaterial|null} */
export function parseMaterial(v) {
  if (v == null) return null;
  const s = String(v).trim().toLowerCase().split(/[;,]/)[0].replace(/[\s-]/g, '_');
  return MATERIALS[s] ?? null;
}

const ROOFS = {
  flat: 'flat', gabled: 'gabled', 'gabled_height_moved': 'gabled',
  hipped: 'hipped', 'half-hipped': 'hipped', half_hipped: 'hipped',
  'side_hipped': 'hipped', 'hipped_gabled': 'hipped',
  pyramidal: 'pyramidal', 'square': 'pyramidal', 'cone': 'pyramidal', conical: 'pyramidal',
  dome: 'dome', onion: 'dome', round: 'dome', sphere: 'dome', cupola: 'dome',
  mansard: 'mansard', gambrel: 'mansard', 'double_saltbox': 'mansard',
  skillion: 'skillion', 'lean_to': 'skillion', 'shed': 'skillion', 'monopitch': 'skillion',
  'quadruple_saltbox': 'gabled', saltbox: 'gabled', 'crosspitched': 'gabled',
  'cross_gabled': 'gabled', 'gabled_row': 'gabled',
  sawtooth: 'flat', 'many': 'flat', 'terrace': 'flat', 'butterfly': 'flat',
};

/** @returns {import('../../src/core/types').RoofShape|null} */
export function parseRoofShape(v) {
  if (v == null) return null;
  const s = String(v).trim().toLowerCase().replace(/\s+/g, '_');
  return ROOFS[s] ?? null;
}

const SURFACES = {
  asphalt: 'asphalt', paved: 'asphalt', chipseal: 'asphalt', bitumen: 'asphalt',
  tarmac: 'asphalt', asphalt_concrete: 'asphalt',
  concrete: 'concrete', 'concrete:plates': 'concrete', 'concrete:lanes': 'concrete',
  cement: 'concrete', metal: 'concrete', wood: 'concrete',
  sett: 'cobblestone', cobblestone: 'cobblestone', unhewn_cobblestone: 'cobblestone',
  'cobblestone:flattened': 'cobblestone', pebblestone: 'gravel', stone: 'cobblestone',
  granite: 'cobblestone', rock: 'cobblestone',
  paving_stones: 'brick', bricks: 'brick', brick: 'brick', 'paving_stones:30': 'brick',
  tiles: 'brick', tile: 'brick', flagstone: 'brick',
  gravel: 'gravel', fine_gravel: 'gravel', compacted: 'gravel', crushed_limestone: 'gravel',
  ground: 'ground', dirt: 'ground', earth: 'ground', grass: 'ground', sand: 'ground',
  mud: 'ground', unpaved: 'ground', woodchips: 'ground', grass_paver: 'ground',
};

export function parseSurface(v, fallback = 'asphalt') {
  if (v == null) return fallback;
  const s = String(v).trim().toLowerCase().split(/[;,]/)[0];
  return SURFACES[s] ?? fallback;
}

export const isTrue = (v) => v === 'yes' || v === 'true' || v === '1';
