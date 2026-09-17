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
  /**
   * Fraction of the presented resolution the scene is shaded at, recovered by
   * the FSR upscale. `Post` used to hardcode these; they live here so `App`
   * and `Post` agree on the one number that decides the frame's cost.
   */
  renderScale: number;
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
    shadowMapSize: 1024, cascadeCount: 2, shadowDistance: 600, maxPixelRatio: 1, renderScale: 0.72,
    ssao: false, ssaoSamples: 8, ssr: false, bloom: true, motionBlur: false, taa: false,
    volumetricClouds: false, cloudSteps: 0, detailDistance: 350, treeBudget: 4000,
    anisotropy: 2, waterReflections: false,
  },
  medium: {
    shadowMapSize: 2048, cascadeCount: 3, shadowDistance: 1200, maxPixelRatio: 1.25, renderScale: 0.85,
    ssao: true, ssaoSamples: 12, ssr: false, bloom: true, motionBlur: false, taa: true,
    volumetricClouds: true, cloudSteps: 24, detailDistance: 700, treeBudget: 7000,
    anisotropy: 4, waterReflections: true,
  },
  high: {
    // Three cascades rather than four: every shadow-casting mesh in the city
    // is submitted once per cascade, and the fourth buys very little on a
    // 2048 map at this distance.
    shadowMapSize: 2048, cascadeCount: 3, shadowDistance: 2200, maxPixelRatio: 1.25, renderScale: 1,
    ssao: true, ssaoSamples: 20, ssr: true, bloom: true, motionBlur: true, taa: true,
    volumetricClouds: true, cloudSteps: 48, detailDistance: 1400, treeBudget: 16000,
    anisotropy: 8, waterReflections: true,
  },
  ultra: {
    shadowMapSize: 4096, cascadeCount: 4, shadowDistance: 3500, maxPixelRatio: 1.5, renderScale: 1,
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

/**
 * Presentation ceiling, in pixels per CSS pixel.
 *
 * Above 2 the returns are invisible and the cost is not: every
 * full-resolution post target scales with this, quadratically.
 */
export const PRESENT_CAP = 2;

/**
 * Floor on `renderScale`, which is also the ceiling on the upscale factor:
 * 1/0.5 = 2x linear is as far as FSR 1.0 holds up before it starts inventing.
 */
export const MIN_RENDER_SCALE = 0.5;

/** How many pixels we shade, how many we present, and the ratio between. */
export interface Presentation {
  /** Pixels shaded per CSS pixel. The frame's cost lives here. */
  sceneRatio: number;
  /** Pixels presented per CSS pixel — the renderer's pixel ratio. */
  presentRatio: number;
  /** `sceneRatio / presentRatio`: what EASU+RCAS upscales from. */
  renderScale: number;
}

/**
 * Decide the resolution path.
 *
 * The two quantities used to be one, and conflating them is what made months
 * of water and shoreline work invisible on a Retina MacBook. At dpr 2 on
 * `high` the renderer presented at the tier's 1.25 cap, the canvas is
 * CSS-sized, and so the *browser* stretched the result 1.6x with plain
 * bilinear — while the FSR upscaler this repo already owns sat switched off,
 * because `Post` only runs it when it is rendering below the canvas. The
 * critic measured the loss at 72-76% of high-frequency energy, uniformly
 * across five unrelated scenes, which is the signature of a filter rather
 * than of missing content.
 *
 * So: present at the panel's resolution and let EASU+RCAS do the upscale
 * instead of the compositor. `sceneRatio` is unchanged for every combination
 * of dpr, tier and pin — the scene is shaded at exactly the rate it was, and
 * only the presentation rises. See qa/respath/NOTES.md for the table proving
 * it.
 *
 * `mobile` opts out entirely and keeps today's presentation. The chain holds
 * about two dozen render targets sized by the *presented* resolution, and iOS
 * kills the tab on steady-state GPU footprint; a sharper image is not worth
 * making that worse, and the complaint came from a desktop anyway.
 */
export function presentationFor(opts: {
  dpr: number;
  tier: QualityTier;
  /** The user's explicit Resolution choice, or `null` to follow the tier. */
  pin: number | null;
  mobile: boolean;
}): Presentation {
  const q = QUALITY[opts.tier];
  const dpr = opts.dpr > 0 ? opts.dpr : 1;
  const pin = opts.pin !== null ? Math.max(0.4, Math.min(opts.pin, 4)) : null;

  // What the renderer's pixel ratio has always been.
  const legacy = pin ?? Math.min(dpr, q.maxPixelRatio);
  // Asking for a resolution outright is a request for that many *shaded*
  // pixels, so the tier's render scale does not then take it back off you.
  const sceneRatio = pin ?? legacy * q.renderScale;

  const presentRatio = opts.mobile
    ? legacy
    // Never below what we shade: a pin above the display's own dpr is
    // supersampling, and presenting under it would throw the pixels away.
    : Math.max(sceneRatio, Math.min(dpr, PRESENT_CAP, sceneRatio / MIN_RENDER_SCALE));

  const renderScale = Math.min(1, Math.max(MIN_RENDER_SCALE, sceneRatio / presentRatio));
  return { sceneRatio, presentRatio, renderScale };
}
