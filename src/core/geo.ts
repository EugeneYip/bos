/**
 * Geodetic <-> local-world conversion.
 *
 * The city is small enough (~10 km across) that a tangent-plane ("local ENU")
 * projection referenced to ORIGIN is accurate to well under a metre, which is
 * far below the precision of the source data. We use an ellipsoidal
 * meridian/normal radius at the origin latitude rather than a spherical
 * approximation so that north-south scale is correct to ~0.1 m across the bounds.
 *
 * World axes: +X = east, +Y = up, +Z = south.
 * (three.js is Y-up right-handed, so north maps to -Z.)
 */
import { ORIGIN } from './config';

const WGS84_A = 6378137.0;
const WGS84_F = 1 / 298.257223563;
const WGS84_E2 = WGS84_F * (2 - WGS84_F);

const lat0 = (ORIGIN.lat * Math.PI) / 180;
const sinLat0 = Math.sin(lat0);
const w = Math.sqrt(1 - WGS84_E2 * sinLat0 * sinLat0);

/** Radius of curvature in the meridian (north-south) at the origin. */
export const METERS_PER_DEG_LAT = (Math.PI / 180) * ((WGS84_A * (1 - WGS84_E2)) / (w * w * w));
/** Radius of curvature in the prime vertical (east-west) at the origin. */
export const METERS_PER_DEG_LON = (Math.PI / 180) * ((WGS84_A / w) * Math.cos(lat0));

/** Longitude/latitude (degrees) -> world X/Z (metres). */
export function lonLatToWorld(lon: number, lat: number): [number, number] {
  return [(lon - ORIGIN.lon) * METERS_PER_DEG_LON, -(lat - ORIGIN.lat) * METERS_PER_DEG_LAT];
}

/** World X/Z (metres) -> longitude/latitude (degrees). */
export function worldToLonLat(x: number, z: number): [number, number] {
  return [ORIGIN.lon + x / METERS_PER_DEG_LON, ORIGIN.lat - z / METERS_PER_DEG_LAT];
}

/** Web-Mercator tile x/y for a lon/lat at a given zoom. */
export function lonLatToTile(lon: number, lat: number, z: number): [number, number] {
  const n = 2 ** z;
  const latRad = (lat * Math.PI) / 180;
  const x = ((lon + 180) / 360) * n;
  const y = ((1 - Math.asinh(Math.tan(latRad)) / Math.PI) / 2) * n;
  return [x, y];
}

/** Inverse of {@link lonLatToTile}; accepts fractional tile coordinates. */
export function tileToLonLat(x: number, y: number, z: number): [number, number] {
  const n = 2 ** z;
  const lon = (x / n) * 360 - 180;
  const lat = (Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / n))) * 180) / Math.PI;
  return [lon, lat];
}
