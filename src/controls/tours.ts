/**
 * Scripted flythroughs of Boston.
 *
 * Waypoints are authored in WGS84 and converted with `lonLatToWorld()` at play
 * time — never hand-placed in world metres — so the paths stay correct if the
 * projection origin ever moves. Heights are *above local terrain*; the actual
 * Y is resolved against `ctx.sampleHeight` when the tour starts.
 */
import { lonLatToWorld } from '../core/geo';

export interface TourKey {
  lon: number;
  lat: number;
  /** Metres above local terrain. */
  agl: number;
  /** Point the camera looks at: lon/lat plus an absolute altitude in metres. */
  look: [lon: number, lat: number, alt: number];
}

export interface Tour {
  id: string;
  name: string;
  subtitle: string;
  /** Seconds for one pass. */
  duration: number;
  /** Suggested time of day; the HUD applies it when the tour starts. */
  hour?: number;
  loop?: boolean;
  keys: TourKey[];
}

function k(lon: number, lat: number, agl: number, look: [number, number, number]): TourKey {
  return { lon, lat, agl, look };
}

/** A smooth arc around a point — used for the establishing shot. */
function arcTour(
  id: string,
  name: string,
  subtitle: string,
  centre: [lon: number, lat: number, alt: number],
  radiusM: number,
  altitude: number,
  fromDeg: number,
  toDeg: number,
  steps: number,
  duration: number,
  hour: number,
): Tour {
  const keys: TourKey[] = [];
  // ~111 320 m per degree of latitude; longitude shrinks with cos(lat).
  const dLat = radiusM / 111320;
  const dLon = radiusM / (111320 * Math.cos((centre[1] * Math.PI) / 180));
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const a = ((fromDeg + (toDeg - fromDeg) * t) * Math.PI) / 180;
    keys.push(k(centre[0] + Math.sin(a) * dLon, centre[1] + Math.cos(a) * dLat, altitude, centre));
  }
  return { id, name, subtitle, duration, hour, keys };
}

export const TOURS: Tour[] = [
  {
    id: 'charles',
    name: 'Down the Charles',
    subtitle: 'Back Bay skyline from the river',
    duration: 58,
    hour: 18.1,
    keys: [
      k(-71.1165, 42.3548, 135, [-71.0900, 42.3490, 130]),
      k(-71.1040, 42.3545, 112, [-71.0862, 42.3480, 120]),
      k(-71.0928, 42.3538, 92, [-71.0821, 42.3473, 150]),
      k(-71.0842, 42.3557, 82, [-71.0751, 42.3489, 165]),
      k(-71.0772, 42.3586, 76, [-71.0700, 42.3520, 95]),
      k(-71.0710, 42.3612, 72, [-71.0638, 42.3588, 70]),
      k(-71.0692, 42.3658, 88, [-71.0600, 42.3592, 90]),
      k(-71.0660, 42.3702, 118, [-71.0575, 42.3600, 110]),
    ],
  },
  {
    id: 'harbor',
    name: 'In from the Harbour',
    subtitle: 'Over the water into the Financial District',
    duration: 52,
    hour: 9.4,
    keys: [
      k(-71.0165, 42.3396, 210, [-71.0530, 42.3560, 130]),
      k(-71.0318, 42.3448, 176, [-71.0538, 42.3566, 135]),
      k(-71.0428, 42.3499, 140, [-71.0540, 42.3580, 140]),
      k(-71.0486, 42.3534, 108, [-71.0534, 42.3594, 150]),
      k(-71.0524, 42.3561, 86, [-71.0572, 42.3600, 70]),
      k(-71.0566, 42.3586, 74, [-71.0616, 42.3601, 55]),
    ],
  },
  {
    id: 'freedom-trail',
    name: 'The Freedom Trail',
    subtitle: 'Boston Common to Bunker Hill at street height',
    duration: 76,
    hour: 15.4,
    keys: [
      k(-71.0660, 42.3546, 17, [-71.0638, 42.3588, 42]),
      k(-71.0648, 42.3570, 14, [-71.0637, 42.3588, 36]),
      k(-71.0623, 42.3566, 13, [-71.0576, 42.3588, 22]),
      k(-71.0596, 42.3576, 13, [-71.0562, 42.3592, 20]),
      k(-71.0580, 42.3581, 14, [-71.0545, 42.3600, 18]),
      k(-71.0546, 42.3600, 17, [-71.0537, 42.3637, 22]),
      k(-71.0537, 42.3637, 15, [-71.0544, 42.3663, 44]),
      k(-71.0545, 42.3663, 24, [-71.0566, 42.3724, 32]),
      k(-71.0555, 42.3728, 28, [-71.0608, 42.3763, 48]),
      k(-71.0592, 42.3756, 42, [-71.0608, 42.3765, 62]),
    ],
  },
  arcTour(
    'downtown-arc',
    'Downtown Arc',
    'A slow half-orbit of the Financial District',
    [-71.0565, 42.3572, 120],
    1650,
    430,
    35,
    260,
    9,
    64,
    17.7,
  ),
];

export function findTour(id: string): Tour | undefined {
  return TOURS.find((t) => t.id === id);
}

/** Convert a key's lon/lat to world X/Z (Y still needs the terrain sample). */
export function keyToWorldXZ(key: TourKey): [number, number] {
  return lonLatToWorld(key.lon, key.lat);
}

export function lookToWorld(key: TourKey): [number, number, number] {
  const [x, z] = lonLatToWorld(key.look[0], key.look[1]);
  return [x, key.look[2], z];
}
