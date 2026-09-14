/**
 * Solar position for HUD readouts (NOAA's low-precision algorithm).
 *
 * This drives *display* only — the Sky module owns the real sun. The two agree
 * to well under a degree, which is far tighter than anyone can read off a
 * scrubber. Having it locally means the clock and the sunrise/sunset gradient
 * are correct even before the Sky module publishes anything.
 */
import { ORIGIN, ATMOSPHERE } from '../core/config';

const RAD = Math.PI / 180;

export interface SolarPosition {
  /** Degrees above the horizon; negative at night. */
  elevation: number;
  /** Degrees clockwise from north. */
  azimuth: number;
}

function fractionalYear(hour: number, dayOfYear: number): number {
  return ((2 * Math.PI) / 365) * (dayOfYear - 1 + (hour - 12) / 24);
}

function declination(g: number): number {
  return (
    0.006918 -
    0.399912 * Math.cos(g) +
    0.070257 * Math.sin(g) -
    0.006758 * Math.cos(2 * g) +
    0.000907 * Math.sin(2 * g) -
    0.002697 * Math.cos(3 * g) +
    0.00148 * Math.sin(3 * g)
  );
}

function equationOfTime(g: number): number {
  return (
    229.18 *
    (0.000075 +
      0.001868 * Math.cos(g) -
      0.032077 * Math.sin(g) -
      0.014615 * Math.cos(2 * g) -
      0.040849 * Math.sin(2 * g))
  );
}

export function solarPosition(hour: number, dayOfYear: number): SolarPosition {
  const g = fractionalYear(hour, dayOfYear);
  const decl = declination(g);
  const eqTime = equationOfTime(g);
  const offset = eqTime + 4 * ORIGIN.lon - 60 * ATMOSPHERE.utcOffsetHours;
  const trueSolar = hour * 60 + offset;
  const ha = (trueSolar / 4 - 180) * RAD;
  const lat = ORIGIN.lat * RAD;

  const cosZen = Math.sin(lat) * Math.sin(decl) + Math.cos(lat) * Math.cos(decl) * Math.cos(ha);
  const zen = Math.acos(Math.max(-1, Math.min(1, cosZen)));
  const elevation = 90 - zen / RAD;

  const sinZen = Math.sin(zen);
  let azimuth = 180;
  if (sinZen > 1e-6) {
    const cosAz = (Math.sin(lat) * Math.cos(zen) - Math.sin(decl)) / (Math.cos(lat) * sinZen);
    azimuth = Math.acos(Math.max(-1, Math.min(1, cosAz))) / RAD;
    if (ha > 0) azimuth = 360 - azimuth;
  }
  return { elevation, azimuth };
}

/** Local sunrise/sunset in decimal hours; null when the sun never sets/rises. */
export function sunTimes(dayOfYear: number): { sunrise: number; sunset: number } | null {
  const g = fractionalYear(12, dayOfYear);
  const decl = declination(g);
  const lat = ORIGIN.lat * RAD;
  // 90.833° accounts for refraction and the solar disc radius.
  const cosHa = Math.cos(90.833 * RAD) / (Math.cos(lat) * Math.cos(decl)) - Math.tan(lat) * Math.tan(decl);
  if (cosHa < -1 || cosHa > 1) return null;
  const ha = Math.acos(cosHa) / RAD;
  const eqTime = equationOfTime(g);
  const noon = (720 - 4 * ORIGIN.lon - eqTime) / 60 + ATMOSPHERE.utcOffsetHours;
  return { sunrise: noon - ha / 15, sunset: noon + ha / 15 };
}

/**
 * CSS gradient stops describing night / civil twilight / day for a given day,
 * used to tint the time scrubber so the control itself reads as a sky.
 */
export function daylightGradient(dayOfYear: number): string {
  const t = sunTimes(dayOfYear);
  const night = 'rgba(26,38,56,.95)';
  const twilight = 'rgba(196,116,86,.9)';
  const day = 'rgba(120,178,238,.9)';
  if (!t) return `linear-gradient(90deg, ${day}, ${day})`;
  const p = (h: number): string => `${Math.max(0, Math.min(100, (h / 24) * 100)).toFixed(2)}%`;
  const { sunrise, sunset } = t;
  return (
    `linear-gradient(90deg,` +
    `${night} 0%,` +
    `${night} ${p(sunrise - 0.9)},` +
    `${twilight} ${p(sunrise + 0.15)},` +
    `${day} ${p(sunrise + 1.3)},` +
    `${day} ${p(sunset - 1.3)},` +
    `${twilight} ${p(sunset - 0.15)},` +
    `${night} ${p(sunset + 0.9)},` +
    `${night} 100%)`
  );
}
