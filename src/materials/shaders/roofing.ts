/**
 * Roofs: Beacon Hill slate, architectural asphalt shingle, clay pantile,
 * standing-seam metal, and the grey EPDM + ballast of flat commercial roofs.
 *
 * Lapped courses are modelled as a sawtooth: the exposed lower edge of each
 * course stands one slate-thickness proud of the course below and the face tilts
 * gently back under the next one. That single discontinuity is what gives a
 * slate roof its hard shadow lines at low sun.
 */
export const ROOFING_GLSL = /* glsl */ `
uniform float uMode;        // 0 slate, 1 asphalt shingle, 2 pantile, 3 standing seam, 4 EPDM
uniform vec2  uUnits;       // units across, courses down
uniform float uThickness;   // metres of lap relief
uniform float uGap;         // side gap as a fraction of a unit
uniform float uWear;
uniform vec3  uBase;        // sRGB tint

// ---- lapped-course helper --------------------------------------------------

void bosCourse(vec2 uv, out vec2 f, out vec4 rnd, out float side, out float lap) {
  vec2 g = uv * uUnits;
  float row = floor(g.y);
  float gx = g.x + 0.5 * mod(row, 2.0);
  float col = floor(gx);
  f = vec2(fract(gx), fract(g.y));
  rnd = bosHash42(bosWrap(vec2(col, row), uUnits) + 0.37);

  // Side joint between neighbours, jittered a little so the coursing is not
  // machine-perfect.
  float jx = (rnd.x - 0.5) * uGap * 0.7;
  float dx = min(f.x, 1.0 - f.x) + jx;
  side = 1.0 - smoothstep(uGap * 0.5, uGap * 1.2, dx);
  lap = 1.0 - smoothstep(0.0, 0.10, f.y);
}

void bosShade(vec2 uv, inout BosSurface s) {
  vec3 albedo = bosSrgb(uBase);
  float rough = 0.85;
  float metal = 0.0;
  float h = 0.0;
  float ao = 1.0;

  if (uMode < 0.5) {
    // ---- slate -------------------------------------------------------------
    vec2 f; vec4 rnd; float side, lap;
    bosCourse(uv, f, rnd, side, lap);

    vec3 blueGrey = bosSrgb8(76.0, 82.0, 92.0);
    vec3 black    = bosSrgb8(48.0, 50.0, 55.0);
    vec3 purple   = bosSrgb8(84.0, 68.0, 78.0);
    vec3 green    = bosSrgb8(74.0, 84.0, 68.0);
    vec3 weather  = bosSrgb8(112.0, 112.0, 108.0);

    float t = rnd.y;
    vec3 c = mix(black, blueGrey, smoothstep(0.0, 0.55, t));
    c = mix(c, purple, smoothstep(0.60, 0.80, t));
    c = mix(c, green, smoothstep(0.84, 0.94, t));
    c *= 0.86 + 0.28 * rnd.z;

    // Cleft face: slate splits along its bedding into shallow rippled steps.
    float cleft = bosFbm01(vec2(uv.x * 210.0, uv.y * 34.0), vec2(210.0, 34.0), 4, 0.6);
    float flake = bosFbm01(uv * 620.0, vec2(620.0), 2, 0.5);
    c *= 0.88 + 0.22 * cleft;
    c *= 0.95 + 0.10 * flake;

    // Age: lichen and mineral wash on the exposed lower third.
    float lichenF = bosWarpFbm(uv * 16.0, vec2(16.0), 4, 0.55, 1.1) * 0.5 + 0.5;
    float lichen = smoothstep(0.66, 0.82, lichenF) * uWear;
    c = mix(c, mix(weather, bosSrgb8(146.0, 148.0, 124.0), 0.45), lichen * 0.8);

    h = uThickness * (1.0 - f.y * 0.82)
      + (rnd.w - 0.5) * uThickness * 0.55                 // slates settle unevenly
      + (cleft - 0.5) * uThickness * 0.22;
    h -= side * uThickness * 1.15;
    h -= lap * 0.0;

    albedo = c;
    rough = 0.72 + 0.18 * cleft + 0.12 * lichen - 0.10 * smoothstep(0.6, 0.95, flake);
    ao = 1.0 - 0.62 * side - 0.30 * smoothstep(0.12, 0.0, f.y);

  } else if (uMode < 1.5) {
    // ---- architectural asphalt shingle -------------------------------------
    vec2 f; vec4 rnd; float side, lap;
    bosCourse(uv, f, rnd, side, lap);

    // Laminated dragon-tooth: a second layer covers the lower half unevenly.
    float toothPhase = floor(f.x * 3.0);
    vec4 trnd = bosHash42(bosWrap(floor(uv * uUnits) + toothPhase * 0.31, uUnits) + 7.7);
    float toothH = 0.30 + 0.22 * trnd.x;
    float laminate = step(f.y, toothH);

    vec3 charcoal = bosSrgb8(60.0, 60.0, 62.0);
    vec3 driftwood = bosSrgb8(104.0, 96.0, 86.0);
    vec3 brownMix = bosSrgb8(84.0, 70.0, 60.0);
    vec3 c = mix(charcoal, driftwood, smoothstep(0.2, 0.8, rnd.y));
    c = mix(c, brownMix, smoothstep(0.7, 1.0, rnd.z) * 0.6);

    // Ceramic granules.
    vec3 gr = bosWorley(uv * 900.0, vec2(900.0), 1.0);
    float granule = smoothstep(0.30, 0.0, gr.x);
    c *= 0.78 + 0.44 * gr.z;
    c *= 0.92 + 0.16 * granule;
    c *= mix(1.0, 0.80, laminate * 0.5);

    h = uThickness * (1.0 - f.y * 0.7) + laminate * uThickness * 0.9
      + (gr.z - 0.5) * uThickness * 0.10
      + (granule - 0.5) * 0.00035;
    h -= side * uThickness * 0.9;

    albedo = c;
    rough = 0.90 + 0.08 * gr.z;
    ao = 1.0 - 0.45 * side - 0.35 * smoothstep(0.10, 0.0, f.y) - 0.2 * laminate * lap;

  } else if (uMode < 2.5) {
    // ---- clay pantile ------------------------------------------------------
    vec2 g = uv * uUnits;
    float row = floor(g.y);
    float gx = g.x + 0.5 * mod(row, 2.0);
    float col = floor(gx);
    vec2 f = vec2(fract(gx), fract(g.y));
    vec4 rnd = bosHash42(bosWrap(vec2(col, row), uUnits) + 0.37);

    // S-profile across the tile: a pan and a cover roll.
    float prof = sin((f.x - 0.25) * BOS_TAU) * 0.5 + 0.5;
    float roll = pow(prof, 1.35);

    vec3 terracotta = bosSrgb8(168.0, 88.0, 56.0);
    vec3 aged = bosSrgb8(132.0, 78.0, 56.0);
    vec3 dark = bosSrgb8(96.0, 58.0, 46.0);
    vec3 c = mix(terracotta, aged, rnd.x);
    c = mix(c, dark, smoothstep(0.75, 1.0, rnd.y) * 0.7);
    float grain = bosFbm01(uv * 320.0, vec2(320.0), 3, 0.5);
    c *= 0.88 + 0.22 * grain;

    float moss = smoothstep(0.6, 0.85, bosFbm01(uv * 20.0, vec2(20.0), 4, 0.55)) * uWear;
    moss *= 1.0 - roll * 0.7;                       // moss lives in the pans
    c = mix(c, bosSrgb8(78.0, 92.0, 58.0), moss * 0.8);

    h = roll * uThickness * 3.2 + uThickness * (1.0 - f.y * 0.6)
      + (rnd.z - 0.5) * uThickness * 0.4 + (grain - 0.5) * 0.0005;
    albedo = c;
    rough = 0.78 + 0.14 * grain + 0.14 * moss;
    ao = mix(1.0, 0.55, (1.0 - roll)) * (1.0 - 0.3 * smoothstep(0.1, 0.0, f.y));

  } else if (uMode < 3.5) {
    // ---- standing seam -----------------------------------------------------
    float gx = uv.x * uUnits.x;
    float f = fract(gx);
    float d = min(f, 1.0 - f);
    vec4 rnd = bosHash42(vec2(floor(gx), 0.0) + 0.37);

    float seam = 1.0 - smoothstep(0.012, 0.030, d);
    float seamCore = 1.0 - smoothstep(0.0, 0.013, d);

    // Oil-canning: wide panels never stay flat.
    float pan = (f - 0.5);
    float oil = (1.0 - pan * pan * 4.0)
              * bosFbm(vec2(uv.x * 3.0, uv.y * 7.0), vec2(3.0, 7.0), 3, 0.5) * 0.0035;

    // Clip lines and fasteners along the seam.
    float clip = smoothstep(0.03, 0.0, abs(fract(uv.y * 22.0) - 0.5)) * seam;

    albedo *= 0.94 + 0.12 * bosFbm01(uv * 40.0, vec2(40.0), 3, 0.5);
    albedo *= 0.96 + 0.08 * rnd.x;
    metal = 0.75;
    rough = 0.35 + 0.12 * bosFbm01(uv * 260.0, vec2(260.0), 2, 0.5);

    // Rust weeping from the seams downslope.
    float weep = smoothstep(0.45, 0.9, bosFbm01(vec2(uv.x * 120.0, uv.y * 3.0), vec2(120.0, 3.0), 4, 0.6));
    float rust = weep * uWear * (0.35 + 0.65 * seam);
    albedo = mix(albedo, bosSrgb8(122.0, 74.0, 44.0), rust * 0.6);
    rough = mix(rough, 0.92, rust * 0.7);
    metal = mix(metal, 0.1, rust * 0.8);

    h = oil + seam * uThickness * 1.4 + seamCore * uThickness * 1.8 - clip * uThickness * 0.35;
    ao = 1.0 - 0.35 * (seam - seamCore) - 0.2 * clip;

  } else {
    // ---- EPDM membrane + gravel ballast ------------------------------------
    // Sheets run in one direction with a lapped, taped seam every ~3 m.
    float sheet = uv.y * uUnits.y;
    float sf = fract(sheet);
    float sd = min(sf, 1.0 - sf);
    float seam = 1.0 - smoothstep(0.004, 0.016, sd);
    vec4 srnd = bosHash42(vec2(0.0, floor(sheet)) + 0.37);

    float wrinkle = bosFbm(uv * vec2(9.0, 26.0), vec2(9.0, 26.0), 4, 0.55);
    float grit = bosFbm01(uv * 700.0, vec2(700.0), 2, 0.5);

    vec3 epdm = bosSrgb(uBase) * (0.90 + 0.18 * srnd.x);
    epdm *= 0.92 + 0.14 * (wrinkle * 0.5 + 0.5);
    epdm *= 0.95 + 0.10 * grit;

    // Ponding stains: dark rings where water sits between drains.
    float pondF = bosWarpFbm(uv * 3.0, vec2(3.0), 4, 0.5, 1.4) * 0.5 + 0.5;
    float pond = smoothstep(0.52, 0.68, pondF);
    epdm = mix(epdm, epdm * 0.62 + 0.006, pond * 0.8);

    // Patches: rectangles of newer membrane with sloppy adhesive edges.
    vec2 pg = uv * 4.0;
    vec2 pid = floor(pg);
    vec2 pf = fract(pg) - 0.5;
    vec4 prnd = bosHash42(bosWrap(pid, vec2(4.0)) + 3.9);
    vec2 psz = vec2(0.16 + 0.16 * prnd.x, 0.14 + 0.18 * prnd.y);
    float wob = bosFbm(uv * 60.0, vec2(60.0), 2, 0.5) * 0.02;
    float patch = step(0.68, prnd.z) * (1.0 - smoothstep(0.0, 0.02, bosSdBox(pf, psz) + wob));
    epdm = mix(epdm, epdm * 1.18 + 0.01, patch * 0.9);

    // Gravel ballast drifts.
    float ballastMask = smoothstep(0.58, 0.72, bosFbm01(uv * 5.0, vec2(5.0), 4, 0.55));
    vec3 bv = bosWorley(uv * 170.0, vec2(170.0), 1.0);
    float stoneTop = smoothstep(0.34, 0.06, bv.x);
    vec3 ballast = mix(bosSrgb8(128.0, 122.0, 110.0), bosSrgb8(92.0, 88.0, 82.0), bv.z);
    ballast *= 0.85 + 0.3 * grit;

    albedo = mix(epdm, ballast, ballastMask * stoneTop);
    h = wrinkle * 0.0022 + seam * 0.0016 + patch * 0.0012
      + ballastMask * stoneTop * 0.008 + (grit - 0.5) * 0.0004;
    rough = mix(0.62 + 0.16 * grit + 0.2 * pond, 0.93, ballastMask * stoneTop);
    ao = 1.0 - 0.30 * seam - 0.45 * ballastMask * (1.0 - stoneTop) - 0.2 * pond;
  }

  s.albedo = albedo;
  s.rough = clamp(rough, 0.04, 1.0);
  s.metal = clamp(metal, 0.0, 1.0);
  s.ao = clamp(ao, 0.0, 1.0);
  s.height = h;
}
`;
