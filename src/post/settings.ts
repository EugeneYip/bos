/**
 * Tunables for the post-processing chain.
 *
 * Everything here is authored in linear-HDR terms unless noted. Values are
 * chosen to look like a good photograph, not a graded action movie: the
 * defaults are deliberately restrained and every lens effect can be switched
 * off independently.
 */

export type GradePresetName = 'neutral' | 'autumn' | 'winter' | 'teal-orange' | 'nightfall';

export type TonemapOperator = 'aces' | 'agx' | 'none';

/** Lift / gamma / gain, ASC-CDL style, per channel plus a master. */
export interface GradeCurve {
  /** Shadow offset. 0 = untouched. Small values only (+-0.04). */
  lift: [number, number, number];
  /** Midtone power. 1 = untouched. */
  gamma: [number, number, number];
  /** Highlight multiplier. 1 = untouched. */
  gain: [number, number, number];
}

export interface GradeSettings {
  preset: GradePresetName;
  tonemap: TonemapOperator;
  /** Scene-referred white point fed to the tonemapper. */
  whitePoint: number;
  /** Post-tonemap contrast pivoted at `contrastPivot`. */
  contrast: number;
  contrastPivot: number;
  /** 1 = untouched, 0 = greyscale, >1 = punchier. */
  saturation: number;
  /** Kelvin-ish white balance shift, -1 (cool) .. +1 (warm). */
  temperature: number;
  /** Green/magenta trim, -1 .. +1. */
  tint: number;
  curve: GradeCurve;
  /** Channel-mixer style split toning: shadow and highlight tints. */
  shadowTint: [number, number, number];
  highlightTint: [number, number, number];
  splitToneBalance: number;
  /** Strength of the optional 3D LUT, 0 disables it entirely. */
  lutStrength: number;
}

export interface PostSettings {
  enabled: boolean;

  /** Fraction of the native backbuffer the scene is rendered at (0.5 .. 1). */
  renderScale: number;
  /** FSR1-style EASU + RCAS when renderScale < 1. */
  upscaleSharpness: number;

  taa: {
    enabled: boolean;
    /** Sub-pixel jitter amplitude in pixels (1 = a full pixel box). */
    jitterScale: number;
    /** Base history blend for a static camera; higher = steadier, softer. */
    feedbackStill: number;
    /** History blend while moving; lower = crisper, noisier. */
    feedbackMoving: number;
    /** Neighbourhood variance clipping width in standard deviations. */
    varianceClipGamma: number;
    /** Post-resolve sharpening (RCAS), 0 .. 1. */
    sharpness: number;
  };

  ao: {
    enabled: boolean;
    /** World-space radius in metres. City scale: building bases + reveals. */
    radius: number;
    /** Occlusion strength applied to the image, 0 .. 1.5. */
    intensity: number;
    /** Exponent on the visibility term; >1 darkens contact regions. */
    power: number;
    /** Assumed slab thickness in metres for the horizon test. */
    thickness: number;
    /** Directional slices per pixel. */
    slices: number;
    /** Fade AO out beyond this view distance (metres). */
    maxDistance: number;
    /** Render AO at half resolution and bilateral-upsample. */
    halfRes: boolean;
    /** Blend AO only into the ambient-ish part of the image. */
    bounceStrength: number;
  };

  ssr: {
    enabled: boolean;
    /** Maximum ray length in metres. */
    maxDistance: number;
    /** Coarse march steps. */
    steps: number;
    /** Binary-refinement iterations after a hit. */
    refineSteps: number;
    /** Screen-space thickness tolerance in metres. */
    thickness: number;
    /** Global multiplier on the reflection contribution. */
    intensity: number;
    /** Roughness above which SSR is skipped entirely. */
    maxRoughness: number;
    /** Auto-enrol scene materials smoother/shinier than these thresholds. */
    autoEnrolRoughness: number;
    autoEnrolMetalness: number;
  };

  bloom: {
    enabled: boolean;
    /** Scene luminance where bloom starts, in linear HDR units. */
    threshold: number;
    /** Soft-knee width around the threshold. */
    knee: number;
    /** Final blend amount. Restraint: 0.03 .. 0.08 looks photographic. */
    intensity: number;
    /** Number of down/up mip levels. */
    levels: number;
    /** 0 = tight glow, 1 = wide halation. */
    spread: number;
    /** Anamorphic streak strength (horizontal), 0 disables. */
    streak: number;
    streakTint: [number, number, number];
  };

  dof: {
    enabled: boolean;
    /** Focus distance in metres; <=0 means autofocus on the screen centre. */
    focusDistance: number;
    fStop: number;
    /** Physical focal length in millimetres; derived from FOV when 0. */
    focalLengthMm: number;
    /** 0 = circular aperture, 1 = hard hexagon. */
    bladeCurvature: number;
    blades: number;
    /** Maximum circle of confusion in pixels at 1080p. */
    maxCoCPixels: number;
    /** Highlight boost inside the bokeh gather. */
    bokehBias: number;
  };

  motionBlur: {
    enabled: boolean;
    /** Shutter angle in degrees (180 = film standard). */
    shutterAngle: number;
    samples: number;
    /** Clamp on the blur length in pixels. */
    maxBlurPixels: number;
  };

  exposure: {
    enabled: boolean;
    /** Target middle-grey the metering drives towards. */
    keyValue: number;
    /** Exposure-value compensation applied on top. */
    compensation: number;
    /** Clamp on the metered luminance so night stays dark. */
    minLuminance: number;
    maxLuminance: number;
    /** Adaptation speeds in EV/second. */
    speedUp: number;
    speedDown: number;
    /** 0 = fully manual (Sky's value), 1 = fully automatic. */
    strength: number;
    /** Centre-weighted metering: 0 = flat average, 1 = spot. */
    centerWeight: number;
  };

  grade: GradeSettings;

  lens: {
    chromaticAberration: boolean;
    /** Pixel offset at the very corner of the frame. */
    chromaticStrength: number;
    vignette: boolean;
    vignetteStrength: number;
    /** Cos^4 style natural falloff exponent. */
    vignetteRoundness: number;
    grain: boolean;
    grainStrength: number;
    /** Extra grain in the shadows relative to highlights. */
    grainShadowBias: number;
    /** Anamorphic-ish sun streaks driven by the bloom pyramid. */
    flare: boolean;
    flareStrength: number;
    /** Sensor dirt / bloom-driven halation ring. */
    halation: boolean;
    halationStrength: number;
  };

  /** Final cleanup AA: used when TAA is off, optional on top when it is on. */
  finalAA: 'none' | 'fxaa' | 'smaa';

  /** Ordered-dither before the 8-bit write, kills gradient banding. */
  dither: boolean;

  /** Show per-pass GPU timings in ctx.stats. */
  profile: boolean;
}

const NEUTRAL_CURVE = (): GradeCurve => ({
  lift: [0, 0, 0],
  gamma: [1, 1, 1],
  gain: [1, 1, 1],
});

export function defaultSettings(): PostSettings {
  return {
    enabled: true,
    renderScale: 1,
    upscaleSharpness: 0.35,

    taa: {
      enabled: true,
      jitterScale: 1.0,
      feedbackStill: 0.94,
      feedbackMoving: 0.82,
      varianceClipGamma: 1.15,
      sharpness: 0.35,
    },

    ao: {
      enabled: true,
      radius: 2.6,
      intensity: 0.95,
      power: 1.6,
      thickness: 1.2,
      slices: 3,
      maxDistance: 900,
      halfRes: true,
      bounceStrength: 0.22,
    },

    ssr: {
      enabled: true,
      maxDistance: 420,
      steps: 28,
      refineSteps: 5,
      thickness: 1.6,
      intensity: 1.0,
      maxRoughness: 0.45,
      autoEnrolRoughness: 0.36,
      autoEnrolMetalness: 0.55,
    },

    bloom: {
      enabled: true,
      threshold: 1.55,
      knee: 0.55,
      intensity: 0.038,
      levels: 6,
      spread: 0.55,
      streak: 0.0,
      streakTint: [0.45, 0.6, 1.0],
    },

    dof: {
      enabled: false,
      focusDistance: 0,
      fStop: 4.0,
      focalLengthMm: 0,
      bladeCurvature: 0.55,
      blades: 6,
      maxCoCPixels: 22,
      bokehBias: 1.35,
    },

    motionBlur: {
      enabled: true,
      shutterAngle: 150,
      samples: 12,
      maxBlurPixels: 42,
    },

    exposure: {
      enabled: true,
      keyValue: 0.16,
      compensation: 0.0,
      minLuminance: 0.0025,
      maxLuminance: 14.0,
      speedUp: 2.6,
      speedDown: 1.1,
      // The sky module already computes a physically-motivated exposure for
      // the time of day. Metering should trim that, not replace it: at 0.85 a
      // dark cityscape drove the aperture open until the Charles blew out.
      // Trim, do not replace: the sky module's exposure already tracks the
      // time of day physically, and letting metering move it far destroys
      // both ends — a dark cityscape opened the aperture until the Charles
      // blew out, and bright sky through a tree canopy stopped it down until
      // Boston Common went black.
      strength: 0.52,
      // Meter the subject rather than the sky: at 0.45 the bright patches
      // between the leaves dominated a frame that is almost entirely ground.
      centerWeight: 0.72,
    },

    grade: preset('neutral'),

    lens: {
      chromaticAberration: true,
      chromaticStrength: 0.9,
      vignette: true,
      vignetteStrength: 0.3,
      vignetteRoundness: 1.1,
      grain: true,
      // Grain is applied after the tonemap, so it is not averaged away by TAA
      // and reads at full strength in a still frame.
      grainStrength: 0.013,
      grainShadowBias: 1.15,
      flare: true,
      flareStrength: 0.35,
      halation: true,
      halationStrength: 0.18,
    },

    finalAA: 'fxaa',
    dither: true,
    profile: true,
  };
}

/**
 * Looks. `neutral` is the default and is intentionally close to a straight
 * photographic render; the others are gentle departures, not Instagram filters.
 */
export function preset(name: GradePresetName): GradeSettings {
  const base: GradeSettings = {
    preset: name,
    tonemap: 'aces',
    // The grade divides by whitePoint * 0.125 before the tonemap, so 4.8
    // reproduces the /0.6 that three.js's own ACES applies to exposure.
    // At the nominal 8.0 the divisor is 1.0 and every frame came out 1.67x
    // darker than the renderer's tonemapper had been producing.
    whitePoint: 4.8,
    contrast: 1.04,
    contrastPivot: 0.42,
    saturation: 1.02,
    temperature: 0.0,
    tint: 0.0,
    curve: NEUTRAL_CURVE(),
    shadowTint: [0, 0, 0],
    highlightTint: [0, 0, 0],
    splitToneBalance: 0,
    lutStrength: 0,
  };

  switch (name) {
    case 'neutral':
      return base;

    case 'autumn':
      // New England October: warm low sun, russet foliage, cool sky retained.
      return {
        ...base,
        temperature: 0.16,
        tint: -0.04,
        saturation: 1.1,
        contrast: 1.07,
        curve: {
          lift: [0.006, 0.002, -0.004],
          gamma: [0.98, 1.0, 1.03],
          gain: [1.045, 1.005, 0.955],
        },
        shadowTint: [-0.012, -0.004, 0.02],
        highlightTint: [0.022, 0.008, -0.014],
        splitToneBalance: 0.1,
      };

    case 'winter':
      // Crisp, blue-shadowed, high-clarity: snow-light New England January.
      return {
        ...base,
        temperature: -0.14,
        tint: 0.03,
        saturation: 0.94,
        contrast: 1.11,
        contrastPivot: 0.45,
        curve: {
          lift: [-0.004, -0.002, 0.008],
          gamma: [1.02, 1.01, 0.985],
          gain: [0.98, 0.995, 1.035],
        },
        shadowTint: [-0.016, -0.006, 0.03],
        highlightTint: [0.012, 0.012, 0.016],
        splitToneBalance: -0.1,
      };

    case 'teal-orange':
      // The cinematic cliche, available on request. Still restrained.
      return {
        ...base,
        saturation: 1.0,
        contrast: 1.12,
        curve: {
          lift: [-0.008, 0.0, 0.012],
          gamma: [1.0, 1.0, 1.0],
          gain: [1.06, 1.0, 0.94],
        },
        shadowTint: [-0.03, 0.004, 0.05],
        highlightTint: [0.05, 0.012, -0.035],
        splitToneBalance: 0.0,
      };

    case 'nightfall':
      // Blue-hour / night: protects shadow separation, avoids muddy blacks.
      return {
        ...base,
        temperature: -0.08,
        saturation: 0.98,
        contrast: 1.02,
        contrastPivot: 0.3,
        curve: {
          lift: [0.004, 0.005, 0.012],
          gamma: [1.04, 1.03, 0.99],
          gain: [0.99, 0.995, 1.02],
        },
        shadowTint: [-0.006, 0.0, 0.024],
        highlightTint: [0.014, 0.006, -0.006],
        splitToneBalance: -0.2,
      };
  }
}

/** Recursive partial so the debug API can patch nested groups by hand. */
export type DeepPartial<T> = { [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K] };

export function mergeSettings<T extends object>(dst: T, src: DeepPartial<T>): T {
  for (const k of Object.keys(src) as Array<keyof T>) {
    const v = src[k] as unknown;
    if (v === undefined) continue;
    const cur = dst[k] as unknown;
    if (v && typeof v === 'object' && !Array.isArray(v) && cur && typeof cur === 'object' && !Array.isArray(cur)) {
      mergeSettings(cur as object, v as DeepPartial<object>);
    } else {
      dst[k] = v as T[keyof T];
    }
  }
  return dst;
}
