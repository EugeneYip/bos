/**
 * Solar and lunar ephemeris for the Boston sky.
 *
 * The sun follows the NOAA Solar Position Algorithm (the same equations the
 * NOAA Global Monitoring Laboratory solar calculator uses, after Meeus'
 * *Astronomical Algorithms*, ch. 25): geometric mean longitude and anomaly,
 * the equation of the centre, apparent longitude corrected for nutation and
 * aberration, true obliquity, and the equation of time. Accuracy is a fraction
 * of an arc-minute over any year we care about — far below a pixel.
 *
 * The moon uses a truncated Meeus ch. 47 series (the largest ~19 longitude,
 * ~10 latitude and ~4 distance terms), good to roughly 0.05 deg in longitude,
 * which is a tenth of the lunar disc. Phase comes out of the geocentric
 * elongation, so the terminator is correct for the date.
 *
 * Conventions used throughout:
 *   - `dayOfYear` is 1..365 against {@link REFERENCE_YEAR} (a common year, so
 *     day 172 is always 21 June).
 *   - Azimuth is measured clockwise from true north, in radians.
 *   - Altitude/elevation is above the astronomical horizon, in radians.
 *   - Direction vectors are in world space: +X east, +Y up, +Z south.
 */

const DEG = Math.PI / 180;
const RAD = 180 / Math.PI;

/**
 * `ctx.dayOfYear` carries no year, so we peg the ephemeris to a common year.
 * Day 172 is 21 June and day 355 is 21 December, matching the almanac dates
 * quoted in the module's validation.
 */
export const REFERENCE_YEAR = 2025;

/** Julian Date of 00:00 UT on 1 January of a Gregorian year. */
export function julianDateOfNewYear(year: number): number {
  const y = year - 1;
  return 1721425.5 + 365 * y + Math.floor(y / 4) - Math.floor(y / 100) + Math.floor(y / 400);
}

const JD_YEAR_START = julianDateOfNewYear(REFERENCE_YEAR);

/**
 * Julian Date for a local civil time.
 *
 * @param dayOfYear 1-based day index into {@link REFERENCE_YEAR}; fractional
 *   values are allowed so a scrubbing clock stays continuous across midnight.
 * @param localHours local civil time, hours.
 * @param utcOffsetHours the local zone's offset from UTC.
 */
export function julianDate(dayOfYear: number, localHours: number, utcOffsetHours: number): number {
  return JD_YEAR_START + (dayOfYear - 1) + (localHours - utcOffsetHours) / 24;
}

/** Equatorial position plus the bits of the solar series other code wants. */
export interface EquatorialPosition {
  /** Right ascension, radians. */
  rightAscension: number;
  /** Declination, radians. */
  declination: number;
  /** Distance in astronomical units for the sun, kilometres for the moon. */
  distance: number;
}

/** Horizontal (topocentric) position. */
export interface HorizontalPosition {
  /** Geometric altitude above the horizon, radians. */
  elevation: number;
  /** Altitude after atmospheric refraction, radians — what you actually see. */
  apparentElevation: number;
  /** Azimuth clockwise from true north, radians. */
  azimuth: number;
  /** Unit vector toward the body: +X east, +Y up, +Z south. */
  direction: { x: number; y: number; z: number };
}

/** Everything the renderer needs about the sun this instant. */
export interface SolarSample extends HorizontalPosition, EquatorialPosition {
  /** Equation of time, minutes (apparent solar time minus mean solar time). */
  equationOfTime: number;
  /** Hour angle, radians; 0 at local solar noon, positive in the afternoon. */
  hourAngle: number;
  /** Local apparent solar time, hours. */
  solarTime: number;
}

/** Everything the renderer needs about the moon this instant. */
export interface LunarSample extends HorizontalPosition, EquatorialPosition {
  /**
   * Illuminated fraction of the disc, 0 (new) .. 1 (full). This is the
   * *amount* of light, not where the terminator is.
   */
  illumination: number;
  /**
   * Signed phase angle in radians, -PI..PI. Negative is waxing (lit limb to
   * the west/right in the northern hemisphere), positive is waning. The
   * terminator is drawn from this.
   */
  phase: number;
  /** Angular radius of the disc as seen from the ground, radians. */
  angularRadius: number;
  /**
   * Position angle of the bright limb, radians, measured anticlockwise from
   * celestial north. Used to rotate the terminator in screen space.
   */
  brightLimbAngle: number;
  /** Parallactic angle, radians: celestial north relative to the local zenith. */
  parallacticAngle: number;
}

function norm360(d: number): number {
  const r = d % 360;
  return r < 0 ? r + 360 : r;
}

/**
 * Mean obliquity of the ecliptic corrected for the dominant nutation term.
 * @param t Julian centuries since J2000.
 */
function obliquity(t: number): number {
  const e0 = 23 + (26 + (21.448 - t * (46.815 + t * (0.00059 - t * 0.001813))) / 60) / 60;
  const omega = 125.04 - 1934.136 * t;
  return (e0 + 0.00256 * Math.cos(omega * DEG)) * DEG;
}

/**
 * Greenwich mean sidereal time, radians. Meeus eq. 12.4.
 */
export function greenwichMeanSiderealTime(jd: number): number {
  const d = jd - 2451545.0;
  const t = d / 36525;
  const theta =
    280.46061837 + 360.98564736629 * d + 0.000387933 * t * t - (t * t * t) / 38710000;
  return norm360(theta) * DEG;
}

/**
 * Bennett's atmospheric refraction, as used by NOAA: geometric altitude in,
 * apparent altitude out. Both radians.
 */
export function refract(elevation: number): number {
  const e = elevation * RAD;
  if (e > 85) return elevation;
  let arcsec: number;
  if (e > 5) {
    const t = Math.tan(elevation);
    arcsec = 58.1 / t - 0.07 / (t * t * t) + 0.000086 / (t * t * t * t * t);
  } else if (e > -0.575) {
    arcsec = 1735 + e * (-518.2 + e * (103.4 + e * (-12.79 + e * 0.711)));
  } else {
    arcsec = -20.772 / Math.tan(elevation);
  }
  return elevation + (arcsec / 3600) * DEG;
}

/**
 * Converts an equatorial position to the local horizon frame.
 *
 * @param hourAngle local hour angle, radians (0 on the meridian, +ve west).
 * @param declination radians.
 * @param latitude observer latitude, radians.
 */
export function equatorialToHorizontal(
  hourAngle: number,
  declination: number,
  latitude: number,
): HorizontalPosition {
  const sinD = Math.sin(declination);
  const cosD = Math.cos(declination);
  const sinP = Math.sin(latitude);
  const cosP = Math.cos(latitude);
  const cosH = Math.cos(hourAngle);
  const sinH = Math.sin(hourAngle);

  // East-north-up components of the unit vector toward the body.
  const up = sinD * sinP + cosD * cosP * cosH;
  const north = sinD * cosP - cosD * sinP * cosH;
  const east = -cosD * sinH;

  const elevation = Math.asin(Math.max(-1, Math.min(1, up)));
  const apparentElevation = refract(elevation);
  const azimuth = Math.atan2(east, north);

  // Re-derive the direction from the *apparent* elevation so the rendered body
  // sits where you would photograph it, not where it geometrically is.
  const c = Math.cos(apparentElevation);
  return {
    elevation,
    apparentElevation,
    azimuth: azimuth < 0 ? azimuth + Math.PI * 2 : azimuth,
    direction: {
      x: Math.sin(azimuth) * c,
      y: Math.sin(apparentElevation),
      z: -Math.cos(azimuth) * c,
    },
  };
}

/**
 * Sun position by the NOAA algorithm.
 *
 * @param dayOfYear 1-based, fractional allowed.
 * @param localHours local civil time in hours.
 * @param latDeg observer latitude, degrees north.
 * @param lonDeg observer longitude, degrees east (Boston is negative).
 * @param utcOffsetHours local zone offset from UTC.
 */
export function sunPosition(
  dayOfYear: number,
  localHours: number,
  latDeg: number,
  lonDeg: number,
  utcOffsetHours: number,
): SolarSample {
  const jd = julianDate(dayOfYear, localHours, utcOffsetHours);
  const t = (jd - 2451545.0) / 36525;

  // Geometric mean longitude and mean anomaly of the sun, degrees.
  const l0 = norm360(280.46646 + t * (36000.76983 + t * 0.0003032));
  const m = 357.52911 + t * (35999.05029 - 0.0001537 * t);
  const e = 0.016708634 - t * (0.000042037 + 0.0000001267 * t);

  // Equation of the centre.
  const mRad = m * DEG;
  const c =
    Math.sin(mRad) * (1.914602 - t * (0.004817 + 0.000014 * t)) +
    Math.sin(2 * mRad) * (0.019993 - 0.000101 * t) +
    Math.sin(3 * mRad) * 0.000289;

  const trueLong = l0 + c;
  const trueAnomaly = m + c;
  // Sun-earth distance in AU (Meeus 25.5).
  const radius = (1.000001018 * (1 - e * e)) / (1 + e * Math.cos(trueAnomaly * DEG));

  const omega = 125.04 - 1934.136 * t;
  const appLong = (trueLong - 0.00569 - 0.00478 * Math.sin(omega * DEG)) * DEG;
  const eps = obliquity(t);

  const declination = Math.asin(Math.sin(eps) * Math.sin(appLong));
  const rightAscension = Math.atan2(Math.cos(eps) * Math.sin(appLong), Math.cos(appLong));

  // Equation of time, minutes (Meeus 28.3, the "y" form NOAA uses).
  const y = Math.tan(eps / 2) ** 2;
  const l0r = l0 * DEG;
  const equationOfTime =
    4 *
    RAD *
    (y * Math.sin(2 * l0r) -
      2 * e * Math.sin(mRad) +
      4 * e * y * Math.sin(mRad) * Math.cos(2 * l0r) -
      0.5 * y * y * Math.sin(4 * l0r) -
      1.25 * e * e * Math.sin(2 * mRad));

  // True solar time in minutes past local midnight, then the hour angle.
  const trueSolarMinutes =
    ((localHours * 60 + equationOfTime + 4 * lonDeg - 60 * utcOffsetHours) % 1440 + 1440) % 1440;
  const hourAngle = (trueSolarMinutes / 4 - 180) * DEG;

  const horiz = equatorialToHorizontal(hourAngle, declination, latDeg * DEG);
  return {
    ...horiz,
    rightAscension: rightAscension < 0 ? rightAscension + Math.PI * 2 : rightAscension,
    declination,
    distance: radius,
    equationOfTime,
    hourAngle,
    solarTime: trueSolarMinutes / 60,
  };
}

/* -------------------------------------------------------------------------- */
/* Moon                                                                        */
/* -------------------------------------------------------------------------- */

/** Meeus table 47.A, truncated: [D, M, M', F, sin coeff (1e-6 deg), cos coeff (1e-3 km)]. */
const MOON_LON: ReadonlyArray<readonly [number, number, number, number, number, number]> = [
  [0, 0, 1, 0, 6288774, -20905355],
  [2, 0, -1, 0, 1274027, -3699111],
  [2, 0, 0, 0, 658314, -2955968],
  [0, 0, 2, 0, 213618, -569925],
  [0, 1, 0, 0, -185116, 48888],
  [0, 0, 0, 2, -114332, -3149],
  [2, 0, -2, 0, 58793, 246158],
  [2, -1, -1, 0, 57066, -152138],
  [2, 0, 1, 0, 53322, -170733],
  [2, -1, 0, 0, 45758, -204586],
  [0, 1, -1, 0, -40923, -129620],
  [1, 0, 0, 0, -34720, 108743],
  [0, 1, 1, 0, -30383, 104755],
  [2, 0, 0, -2, 15327, 10321],
  [0, 0, 1, 2, -12528, 0],
  [0, 0, 1, -2, 10980, 79661],
  [4, 0, -1, 0, 10675, -34782],
  [0, 0, 3, 0, 10034, -23210],
  [4, 0, -2, 0, 8548, -21636],
  [2, 1, -1, 0, -7888, 24208],
  [2, 1, 0, 0, -6766, 30824],
  [1, 0, -1, 0, -5163, -8379],
  [1, 1, 0, 0, 4987, -16675],
  [2, -1, 1, 0, 4036, -12831],
  [2, 0, 2, 0, 3994, -10445],
  [4, 0, 0, 0, 3861, -11650],
  [2, 0, -3, 0, 3665, 14403],
];

/** Meeus table 47.B, truncated: [D, M, M', F, sin coeff (1e-6 deg)]. */
const MOON_LAT: ReadonlyArray<readonly [number, number, number, number, number]> = [
  [0, 0, 0, 1, 5128122],
  [0, 0, 1, 1, 280602],
  [0, 0, 1, -1, 277693],
  [2, 0, 0, -1, 173237],
  [2, 0, -1, 1, 55413],
  [2, 0, -1, -1, 46271],
  [2, 0, 0, 1, 32573],
  [0, 0, 2, 1, 17198],
  [2, 0, 1, -1, 9266],
  [0, 0, 2, -1, 8822],
  [2, -1, 0, -1, 8216],
  [2, 0, -2, -1, 4324],
  [2, 0, 1, 1, 4200],
  [2, 1, 0, -1, -3359],
  [2, -1, -1, 1, 2463],
  [2, -1, 0, 1, 2211],
  [2, -1, -1, -1, 2065],
  [0, 1, -1, -1, -1870],
  [4, 0, -1, -1, 1828],
  [0, 1, 0, 1, -1794],
  [0, 0, 0, 3, -1749],
];

/**
 * Moon position and phase.
 *
 * @param sun the sun sample for the same instant — the phase is the geocentric
 *   elongation from it, so passing a stale sun gives a stale terminator.
 */
export function moonPosition(
  dayOfYear: number,
  localHours: number,
  latDeg: number,
  lonDeg: number,
  utcOffsetHours: number,
  sun: SolarSample,
): LunarSample {
  const jd = julianDate(dayOfYear, localHours, utcOffsetHours);
  const t = (jd - 2451545.0) / 36525;

  const lp =
    norm360(218.3164477 + 481267.88123421 * t - 0.0015786 * t * t + (t * t * t) / 538841 - (t ** 4) / 65194000);
  const d =
    norm360(297.8501921 + 445267.1114034 * t - 0.0018819 * t * t + (t * t * t) / 545868 - (t ** 4) / 113065000);
  const m = norm360(357.5291092 + 35999.0502909 * t - 0.0001536 * t * t + (t * t * t) / 24490000);
  const mp =
    norm360(134.9633964 + 477198.8675055 * t + 0.0087414 * t * t + (t * t * t) / 69699 - (t ** 4) / 14712000);
  const f =
    norm360(93.272095 + 483202.0175233 * t - 0.0036539 * t * t - (t * t * t) / 3526000 + (t ** 4) / 863310000);

  // Eccentricity correction applied to terms involving the sun's anomaly.
  const ecc = 1 - 0.002516 * t - 0.0000074 * t * t;

  let sumL = 0;
  let sumR = 0;
  for (const [cd, cm, cmp, cf, sl, sr] of MOON_LON) {
    const arg = (cd * d + cm * m + cmp * mp + cf * f) * DEG;
    const damp = cm === 0 ? 1 : Math.abs(cm) === 1 ? ecc : ecc * ecc;
    sumL += sl * damp * Math.sin(arg);
    sumR += sr * damp * Math.cos(arg);
  }
  let sumB = 0;
  for (const [cd, cm, cmp, cf, sb] of MOON_LAT) {
    const arg = (cd * d + cm * m + cmp * mp + cf * f) * DEG;
    const damp = cm === 0 ? 1 : Math.abs(cm) === 1 ? ecc : ecc * ecc;
    sumB += sb * damp * Math.sin(arg);
  }

  const lambda = (lp + sumL / 1e6) * DEG;
  const beta = (sumB / 1e6) * DEG;
  const distance = 385000.56 + sumR / 1000; // km

  const eps = obliquity(t);
  const sinB = Math.sin(beta);
  const cosB = Math.cos(beta);
  const rightAscension = Math.atan2(
    Math.sin(lambda) * Math.cos(eps) - Math.tan(beta) * Math.sin(eps),
    Math.cos(lambda),
  );
  const declination = Math.asin(sinB * Math.cos(eps) + cosB * Math.sin(eps) * Math.sin(lambda));

  const lst = greenwichMeanSiderealTime(jd) + lonDeg * DEG;
  const hourAngle = lst - rightAscension;
  const horiz = equatorialToHorizontal(hourAngle, declination, latDeg * DEG);

  // Geocentric elongation and phase angle (Meeus 48.2/48.3).
  const cosElong =
    Math.sin(sun.declination) * Math.sin(declination) +
    Math.cos(sun.declination) * Math.cos(declination) * Math.cos(sun.rightAscension - rightAscension);
  const elongation = Math.acos(Math.max(-1, Math.min(1, cosElong)));
  const sunDistKm = sun.distance * 149597870.7;
  const phaseAngle = Math.atan2(
    sunDistKm * Math.sin(elongation),
    distance - sunDistKm * Math.cos(elongation),
  );
  const illumination = (1 + Math.cos(phaseAngle)) / 2;

  // Waxing or waning: compare ecliptic longitudes. The moon leads the sun
  // eastward while waxing.
  const sunLambda = Math.atan2(
    Math.sin(sun.rightAscension) * Math.cos(eps) + Math.tan(sun.declination) * Math.sin(eps),
    Math.cos(sun.rightAscension),
  );
  let dl = lambda - sunLambda;
  while (dl < 0) dl += Math.PI * 2;
  while (dl > Math.PI * 2) dl -= Math.PI * 2;
  const waxing = dl < Math.PI;
  const phase = waxing ? -phaseAngle : phaseAngle;

  // Position angle of the bright limb (Meeus 48.5).
  const brightLimbAngle = Math.atan2(
    Math.cos(sun.declination) * Math.sin(sun.rightAscension - rightAscension),
    Math.sin(sun.declination) * Math.cos(declination) -
      Math.cos(sun.declination) * Math.sin(declination) * Math.cos(sun.rightAscension - rightAscension),
  );

  const lat = latDeg * DEG;
  const parallacticAngle = Math.atan2(
    Math.sin(hourAngle),
    Math.tan(lat) * Math.cos(declination) - Math.sin(declination) * Math.cos(hourAngle),
  );

  return {
    ...horiz,
    rightAscension: rightAscension < 0 ? rightAscension + Math.PI * 2 : rightAscension,
    declination,
    distance,
    illumination,
    phase,
    // Mean lunar radius 1737.4 km.
    angularRadius: Math.asin(1737.4 / distance),
    brightLimbAngle,
    parallacticAngle,
  };
}

/* -------------------------------------------------------------------------- */
/* Rise / set solving                                                          */
/* -------------------------------------------------------------------------- */

/**
 * The standard altitude of the solar upper limb at rise/set: -50 arc-minutes,
 * which is 16' of semidiameter plus 34' of horizontal refraction.
 */
export const SUNRISE_ALTITUDE = -0.833 * DEG;
export const CIVIL_TWILIGHT = -6 * DEG;
export const NAUTICAL_TWILIGHT = -12 * DEG;
export const ASTRONOMICAL_TWILIGHT = -18 * DEG;

/**
 * Solves for the local time at which the sun crosses `altitude`, by scanning
 * the day at one-minute resolution and bisecting the bracketing interval.
 *
 * @returns local hours, or `null` if the sun never crosses that altitude that
 *   day (polar day/night, or a twilight threshold that is never reached).
 */
export function solarEvent(
  dayOfYear: number,
  latDeg: number,
  lonDeg: number,
  utcOffsetHours: number,
  altitude: number,
  rising: boolean,
): number | null {
  const f = (h: number): number =>
    sunPosition(dayOfYear, h, latDeg, lonDeg, utcOffsetHours).elevation - altitude;

  const step = 1 / 60;
  let prevH = 0;
  let prev = f(0);
  for (let h = step; h <= 24 + 1e-9; h += step) {
    const cur = f(h);
    const crossed = rising ? prev < 0 && cur >= 0 : prev >= 0 && cur < 0;
    if (crossed) {
      let lo = prevH;
      let hi = h;
      for (let i = 0; i < 40; i++) {
        const mid = (lo + hi) / 2;
        const v = f(mid);
        if (rising ? v < 0 : v >= 0) lo = mid;
        else hi = mid;
      }
      return (lo + hi) / 2;
    }
    prev = cur;
    prevH = h;
  }
  return null;
}

/** Peak solar elevation for a day, radians, and the local time it occurs. */
export function solarNoon(
  dayOfYear: number,
  latDeg: number,
  lonDeg: number,
  utcOffsetHours: number,
): { hour: number; elevation: number } {
  let best = -Math.PI;
  let bestH = 12;
  for (let h = 0; h < 24; h += 1 / 60) {
    const e = sunPosition(dayOfYear, h, latDeg, lonDeg, utcOffsetHours).elevation;
    if (e > best) {
      best = e;
      bestH = h;
    }
  }
  // Golden-section-free refinement: parabolic step around the minute sample.
  let lo = bestH - 1 / 60;
  let hi = bestH + 1 / 60;
  for (let i = 0; i < 30; i++) {
    const a = lo + (hi - lo) / 3;
    const b = hi - (hi - lo) / 3;
    if (
      sunPosition(dayOfYear, a, latDeg, lonDeg, utcOffsetHours).elevation <
      sunPosition(dayOfYear, b, latDeg, lonDeg, utcOffsetHours).elevation
    ) {
      lo = a;
    } else {
      hi = b;
    }
  }
  const hour = (lo + hi) / 2;
  return { hour, elevation: sunPosition(dayOfYear, hour, latDeg, lonDeg, utcOffsetHours).elevation };
}
