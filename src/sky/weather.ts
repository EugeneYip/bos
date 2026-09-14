/**
 * Weather presets for the Boston sky.
 *
 * New England weather turns over fast, so the presets are deliberately far
 * apart: a clear day has a handful of fair-weather cumulus at 1.8 km, a storm
 * has a 5 km-deep convective deck that kills the direct sun. Every field is
 * interpolated continuously when the preset changes, so switching is a
 * transition rather than a cut.
 */

export type WeatherPreset = 'clear' | 'scattered' | 'overcast' | 'storm';

export interface WeatherState {
  /** 0..1 fraction of sky the cloud field is allowed to occupy. */
  coverage: number;
  /** Extinction per metre inside a fully dense cloud. */
  density: number;
  /** Base of the main cloud deck, metres above sea level. */
  bottom: number;
  /** Top of the main cloud deck, metres above sea level. */
  top: number;
  /** Metres/second of horizontal drift. */
  windSpeed: number;
  /** Wind bearing, radians clockwise from north (the direction it blows to). */
  windBearing: number;
  /** 0 = flat stratus, 1 = towering cumulus. Drives the height gradient. */
  cumuliform: number;
  /** Extra high cirrus veil, 0..1. */
  cirrus: number;
  /** Multiplier on the Mie/haze term of the atmosphere. */
  haze: number;
  /** How much the cloud deck dims the sun, 0..1. */
  sunOcclusion: number;
  /** Scale of the largest cloud structures, metres. */
  featureScale: number;
}

const PRESETS: Record<WeatherPreset, WeatherState> = {
  clear: {
    coverage: 0.24,
    density: 0.055,
    bottom: 1750,
    top: 3000,
    windSpeed: 7,
    windBearing: 3.9,
    cumuliform: 0.85,
    cirrus: 0.16,
    haze: 1.0,
    sunOcclusion: 0.0,
    featureScale: 9000,
  },
  scattered: {
    coverage: 0.46,
    density: 0.075,
    bottom: 1350,
    top: 3900,
    windSpeed: 11,
    windBearing: 4.2,
    cumuliform: 0.78,
    cirrus: 0.3,
    haze: 1.25,
    sunOcclusion: 0.12,
    featureScale: 11000,
  },
  overcast: {
    coverage: 0.84,
    density: 0.1,
    bottom: 900,
    top: 2900,
    windSpeed: 14,
    windBearing: 4.4,
    cumuliform: 0.22,
    cirrus: 0.5,
    haze: 1.9,
    sunOcclusion: 0.72,
    featureScale: 16000,
  },
  storm: {
    coverage: 0.95,
    density: 0.16,
    bottom: 650,
    top: 6200,
    windSpeed: 22,
    windBearing: 4.9,
    cumuliform: 0.62,
    cirrus: 0.7,
    haze: 2.6,
    sunOcclusion: 0.9,
    featureScale: 20000,
  },
};

export function weatherPreset(name: WeatherPreset): WeatherState {
  return { ...PRESETS[name] };
}

export const WEATHER_NAMES: readonly WeatherPreset[] = ['clear', 'scattered', 'overcast', 'storm'];

/** Component-wise lerp so preset changes cross-fade instead of popping. */
export function lerpWeather(a: WeatherState, b: WeatherState, t: number, out: WeatherState): WeatherState {
  const k = t < 0 ? 0 : t > 1 ? 1 : t;
  out.coverage = a.coverage + (b.coverage - a.coverage) * k;
  out.density = a.density + (b.density - a.density) * k;
  out.bottom = a.bottom + (b.bottom - a.bottom) * k;
  out.top = a.top + (b.top - a.top) * k;
  out.windSpeed = a.windSpeed + (b.windSpeed - a.windSpeed) * k;
  // Bearings are close enough across presets that a plain lerp is safe.
  out.windBearing = a.windBearing + (b.windBearing - a.windBearing) * k;
  out.cumuliform = a.cumuliform + (b.cumuliform - a.cumuliform) * k;
  out.cirrus = a.cirrus + (b.cirrus - a.cirrus) * k;
  out.haze = a.haze + (b.haze - a.haze) * k;
  out.sunOcclusion = a.sunOcclusion + (b.sunOcclusion - a.sunOcclusion) * k;
  out.featureScale = a.featureScale + (b.featureScale - a.featureScale) * k;
  return out;
}
