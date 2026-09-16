/**
 * Global configuration for the Boston 3D model.
 * All distances are in metres; the world is Y-up, right-handed (three.js convention).
 */

/** Geographic origin of the local tangent-plane projection: Boston Common / Park St. */
export const ORIGIN = { lat: 42.3554, lon: -71.0655 } as const;

/**
 * Extent of the modelled city, in WGS84 degrees.
 * Covers Charlestown & Bunker Hill in the north, Columbia Point in the south,
 * Brighton/Allston in the west and Logan/East Boston in the east.
 */
export const BOUNDS = {
  south: 42.3180,
  west: -71.1320,
  north: 42.3960,
  east: -71.0060,
} as const;

/** Quality tiers. Auto-selected at boot from a GPU probe, overridable in the UI. */
export type QualityTier = 'low' | 'medium' | 'high' | 'ultra';

export interface QualitySettings {
  shadowMapSize: number;
  cascadeCount: number;
  shadowDistance: number;
  /** Device-pixel-ratio ceiling. */
  maxPixelRatio: number;
  ssao: boolean;
  ssaoSamples: number;
  ssr: boolean;
  bloom: boolean;
  motionBlur: boolean;
  taa: boolean;
  volumetricClouds: boolean;
  cloudSteps: number;
  /** Max distance at which individual building windows/details are drawn. */
  detailDistance: number;
  /** Instanced-tree budget. */
  treeBudget: number;
  anisotropy: number;
  waterReflections: boolean;
}

/**
 * Quality tiers.
 *
 * `maxPixelRatio` is the one number here that costs quadratically, and it used
 * to be the least considered. A 2.0 cap on `ultra` means a Retina panel renders
 * four times the pixels of a 1.0 cap — and this renderer is measurably
 * fill-bound: quartering the pixel count at `high` took 16 fps to 28 on the same
 * frame. So `ultra` at 2.0 was not a quality setting, it was a way to guarantee
 * single digits, and that is what "the whole scene keeps blinking at ultra"
 * turned out to be: a frame rate low enough to read as flicker.
 *
 * The caps are now 1.25 and 1.5. Supersampling is no longer the default on a
 * HiDPI display, which is ordinary practice for a renderer this heavy — TAA and
 * the FSR upscale exist to recover the edge quality. Anyone who wants their
 * screen's real resolution can still ask for it outright: the settings panel has
 * a Resolution control, and it overrides these.
 */
export const QUALITY: Record<QualityTier, QualitySettings> = {
  low: {
    shadowMapSize: 1024, cascadeCount: 2, shadowDistance: 600, maxPixelRatio: 1,
    ssao: false, ssaoSamples: 8, ssr: false, bloom: true, motionBlur: false, taa: false,
    volumetricClouds: false, cloudSteps: 0, detailDistance: 350, treeBudget: 4000,
    anisotropy: 2, waterReflections: false,
  },
  medium: {
    shadowMapSize: 2048, cascadeCount: 3, shadowDistance: 1200, maxPixelRatio: 1.25,
    ssao: true, ssaoSamples: 12, ssr: false, bloom: true, motionBlur: false, taa: true,
    volumetricClouds: true, cloudSteps: 24, detailDistance: 700, treeBudget: 7000,
    anisotropy: 4, waterReflections: true,
  },
  high: {
    // Three cascades rather than four: every shadow-casting mesh in the city
    // is submitted once per cascade, and the fourth buys very little on a
    // 2048 map at this distance.
    shadowMapSize: 2048, cascadeCount: 3, shadowDistance: 2200, maxPixelRatio: 1.25,
    ssao: true, ssaoSamples: 20, ssr: true, bloom: true, motionBlur: true, taa: true,
    volumetricClouds: true, cloudSteps: 48, detailDistance: 1400, treeBudget: 16000,
    anisotropy: 8, waterReflections: true,
  },
  ultra: {
    shadowMapSize: 4096, cascadeCount: 4, shadowDistance: 3500, maxPixelRatio: 1.5,
    ssao: true, ssaoSamples: 32, ssr: true, bloom: true, motionBlur: true, taa: true,
    volumetricClouds: true, cloudSteps: 80, detailDistance: 2600, treeBudget: 30000,
    anisotropy: 16, waterReflections: true,
  },
};

/** Physically-based sun/sky constants. */
export const ATMOSPHERE = {
  /** Peak direct-normal irradiance used to scale the sun light, in lux-equivalent units. */
  sunIntensity: 120000,
  /** Boston's timezone offset used when converting local time to solar position. */
  utcOffsetHours: -4,
  turbidity: 2.6,
  rayleigh: 1.8,
  mieCoefficient: 0.006,
  mieDirectionalG: 0.82,
} as const;

/** Mean sea level offset: OSM/USGS elevations are orthometric; water sits at y=0. */
export const SEA_LEVEL = 0;

export const RENDER = {
  near: 0.35,
  far: 26000,
  fov: 52,
  /** Exposure for the ACES tonemapper. */
  exposure: 0.78,
} as const;
