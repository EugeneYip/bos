/**
 * Curated Boston landmark index and the camera framing for each.
 *
 * This is the *fallback* list. If the Landmarks module ships a
 * `src/landmarks/registry.ts` the HUD prefers that (see `landmarks.ts`), and
 * merges anything this list adds that the registry doesn't have.
 *
 * Positions are WGS84 and converted with `lonLatToWorld()` at click time.
 * `bearing` is the compass direction *from the subject to the camera*, chosen
 * for the most photogenic side of each building.
 */
import { lonLatToWorld } from '../core/geo';
import type { Ctx } from '../core/Context';

export interface LandmarkEntry {
  id: string;
  name: string;
  group: string;
  lon: number;
  lat: number;
  /** Approximate subject height, metres. The aim point sits at 55% of it. */
  height: number;
  /** Compass degrees from the subject to the camera (0 = camera due north). */
  bearing: number;
  /** Horizontal camera distance, metres. */
  distance: number;
  /** Camera height above local terrain, metres. */
  altitude: number;
  /** Suggested time of day. */
  hour?: number;
  /** Extra search terms. */
  alt?: string;
}

const L = (
  id: string,
  name: string,
  group: string,
  lat: number,
  lon: number,
  height: number,
  bearing: number,
  distance: number,
  altitude: number,
  hour?: number,
  alt?: string,
): LandmarkEntry => ({ id, name, group, lon, lat, height, bearing, distance, altitude, hour, alt });

export const LANDMARKS: LandmarkEntry[] = [
  // --- Skyline ------------------------------------------------------------
  L('hancock', '200 Clarendon (Hancock Tower)', 'Skyline', 42.3489, -71.0751, 241, 318, 760, 250, 17.4, 'john hancock glass tower back bay'),
  L('prudential', 'Prudential Tower', 'Skyline', 42.3473, -71.0821, 228, 296, 820, 235, 17.0, 'pru back bay skywalk'),
  L('custom-house', 'Custom House Tower', 'Skyline', 42.3594, -71.0534, 151, 104, 470, 160, 9.3, 'clock tower financial district'),
  L('intl-place', 'One International Place', 'Skyline', 42.3565, -71.0522, 184, 118, 560, 185, 10.2, 'financial district'),
  L('financial-district', 'Financial District', 'Skyline', 42.3570, -71.0560, 170, 128, 1250, 330, 16.6, 'downtown towers'),
  L('back-bay-skyline', 'Back Bay Skyline', 'Skyline', 42.3487, -71.0790, 220, 330, 1750, 320, 17.8, 'hancock prudential charles'),

  // --- Historic -----------------------------------------------------------
  L('state-house', 'Massachusetts State House', 'Historic', 42.3588, -71.0638, 58, 196, 300, 78, 18.1, 'golden dome beacon hill bulfinch'),
  L('old-state-house', 'Old State House', 'Historic', 42.3588, -71.0576, 27, 142, 190, 44, 15.2, 'boston massacre'),
  L('faneuil-hall', 'Faneuil Hall & Quincy Market', 'Historic', 42.3600, -71.0545, 30, 132, 260, 62, 14.4, 'marketplace cradle of liberty'),
  L('park-street', 'Park Street Church', 'Historic', 42.3566, -71.0623, 66, 200, 210, 52, 16.4, 'granary burying ground'),
  L('old-north', 'Old North Church', 'Historic', 42.3663, -71.0544, 53, 188, 200, 54, 15.8, 'one if by land north end steeple'),
  L('revere-house', 'Paul Revere House', 'Historic', 42.3637, -71.0537, 14, 150, 130, 26, 12.6, 'north square'),
  L('constitution', 'USS Constitution', 'Historic', 42.3724, -71.0556, 56, 204, 280, 48, 10.4, 'old ironsides navy yard'),
  L('bunker-hill', 'Bunker Hill Monument', 'Historic', 42.3763, -71.0608, 67, 158, 340, 78, 17.2, 'charlestown obelisk'),

  // --- Parks --------------------------------------------------------------
  L('common', 'Boston Common', 'Parks', 42.3551, -71.0656, 20, 196, 400, 105, 15.0, 'frog pond parkman bandstand'),
  L('public-garden', 'Public Garden', 'Parks', 42.3541, -71.0703, 18, 118, 330, 78, 16.8, 'swan boats lagoon bridge'),
  L('comm-ave', 'Commonwealth Avenue Mall', 'Parks', 42.3520, -71.0818, 22, 86, 620, 58, 8.4, 'green mall back bay elms'),
  L('esplanade', 'Charles River Esplanade', 'Parks', 42.3565, -71.0740, 12, 338, 420, 66, 18.4, 'hatch shell riverbank'),
  L('fens', 'Back Bay Fens', 'Parks', 42.3430, -71.0960, 14, 70, 520, 88, 9.6, 'emerald necklace olmsted'),

  // --- Neighbourhoods -----------------------------------------------------
  L('beacon-hill', 'Beacon Hill', 'Neighbourhoods', 42.3580, -71.0690, 18, 212, 240, 52, 8.6, 'acorn street gas lamps brick'),
  L('back-bay-rows', 'Back Bay Rowhouses', 'Neighbourhoods', 42.3527, -71.0812, 20, 22, 340, 62, 8.0, 'marlborough brownstone'),
  L('north-end', 'The North End', 'Neighbourhoods', 42.3647, -71.0542, 22, 122, 400, 92, 17.6, 'hanover street little italy'),
  L('seaport', 'Seaport & Fort Point', 'Neighbourhoods', 42.3505, -71.0430, 60, 124, 820, 190, 21.4, 'innovation district channel'),
  L('charlestown', 'Charlestown Navy Yard', 'Neighbourhoods', 42.3730, -71.0542, 24, 116, 520, 110, 10.8, 'dry dock piers'),
  L('south-boston', 'South Boston Waterfront', 'Neighbourhoods', 42.3400, -71.0350, 30, 116, 900, 200, 18.0, 'southie dorchester bay'),

  // --- Waterfront ---------------------------------------------------------
  L('rowes-wharf', 'Rowes Wharf', 'Waterfront', 42.3560, -71.0503, 46, 112, 400, 96, 9.0, 'harbor arch ferry'),
  L('long-wharf', 'Long Wharf', 'Waterfront', 42.3597, -71.0498, 20, 96, 340, 74, 8.6, 'aquarium harbour'),
  L('ica', 'Institute of Contemporary Art', 'Waterfront', 42.3531, -71.0466, 26, 74, 300, 58, 19.2, 'cantilever museum'),
  L('logan', 'Logan & East Boston', 'Waterfront', 42.3656, -71.0180, 20, 232, 1100, 260, 11.4, 'airport runway harbour'),

  // --- Bridges ------------------------------------------------------------
  L('zakim', 'Zakim Bunker Hill Bridge', 'Bridges', 42.3690, -71.0630, 82, 352, 720, 120, 18.6, 'cable stayed inverted y'),
  L('longfellow', 'Longfellow Bridge', 'Bridges', 42.3614, -71.0705, 28, 322, 470, 86, 7.8, 'salt and pepper charles'),
  L('harvard-bridge', 'Harvard Bridge', 'Bridges', 42.3540, -71.0920, 16, 340, 560, 78, 18.2, 'mass ave smoot charles'),

  // --- Culture & Sport ----------------------------------------------------
  L('fenway', 'Fenway Park', 'Culture & Sport', 42.3467, -71.0972, 34, 142, 560, 165, 16.2, 'green monster red sox ballpark'),
  L('td-garden', 'TD Garden', 'Culture & Sport', 42.3662, -71.0621, 44, 248, 460, 118, 19.8, 'celtics bruins north station'),
  L('bpl', 'Boston Public Library & Trinity Church', 'Culture & Sport', 42.3496, -71.0765, 32, 202, 240, 56, 16.0, 'copley square mckim richardson'),
  L('christian-science', 'Christian Science Plaza', 'Culture & Sport', 42.3443, -71.0855, 68, 204, 430, 120, 18.6, 'reflecting pool mother church'),
  L('mfa', 'Museum of Fine Arts', 'Culture & Sport', 42.3394, -71.0942, 26, 30, 380, 82, 10.4, 'huntington avenue'),
];

export interface Framing {
  pos: [number, number, number];
  target: [number, number, number];
  hour?: number;
}

/** Build a camera pose that frames `entry` well, respecting local terrain. */
export function framingFor(entry: LandmarkEntry, ctx: Ctx): Framing {
  const [tx, tz] = lonLatToWorld(entry.lon, entry.lat);
  const tGround = safeHeight(ctx, tx, tz);
  const target: [number, number, number] = [tx, tGround + entry.height * 0.55, tz];

  // World: +X east, +Z south, so north is -Z.
  const rad = (entry.bearing * Math.PI) / 180;
  const px = tx + Math.sin(rad) * entry.distance;
  const pz = tz - Math.cos(rad) * entry.distance;
  const py = safeHeight(ctx, px, pz) + entry.altitude;
  return { pos: [px, py, pz], target, hour: entry.hour };
}

function safeHeight(ctx: Ctx, x: number, z: number): number {
  const h = ctx.sampleHeight(x, z);
  return Number.isFinite(h) ? h : 0;
}
