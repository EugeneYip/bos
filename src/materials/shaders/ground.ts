/**
 * Natural ground cover: mown grass, bare earth, crushed gravel, beach sand and
 * bark mulch. These are the surfaces the terrain and the parks stand on, so they
 * are authored top-down and are deliberately low-contrast in the normal map —
 * a ground plane seen at a grazing angle exaggerates slope enormously.
 *
 * Tiling discipline: every lattice used here is an integer that matches the
 * period handed to the noise, and all per-feature detail is evaluated in
 * *cell-local* coordinates (so a clump of grass can lean in its own direction
 * without breaking the seam, exactly like the gold-leaf wrinkles in metal.ts).
 */
export const GROUND_GLSL = /* glsl */ `
uniform float uMode;     // 0 grass, 1 dirt, 2 gravel, 3 sand, 4 mulch
uniform vec3  uBase;     // family tint, sRGB
uniform float uCells;    // primary feature lattice, integer cells per tile axis
uniform float uRelief;   // metres of primary relief
uniform float uWear;     // 0 lush / fresh, 1 dry / worn / trafficked
uniform float uDebris;   // scatter of foreign matter (leaves, twigs, litter)

// ------------------------------------------------------------------ grass ---

void bosGrass(vec2 uv, inout BosSurface s) {
  vec3 deep  = bosSrgb8(28.0, 44.0, 21.0);
  vec3 lush  = bosSrgb8(62.0, 90.0, 38.0);
  vec3 mid   = bosSrgb8(92.0, 112.0, 52.0);
  vec3 pale  = bosSrgb8(130.0, 138.0, 74.0);
  vec3 straw = bosSrgb8(154.0, 140.0, 86.0);
  vec3 soil  = bosSrgb8(74.0, 57.0, 42.0);

  // Broad patchiness: mowing bands, dry spots, tree shade.
  float patch = bosWarpFbm(uv * 3.0, vec2(3.0), 4, 0.55, 1.1) * 0.5 + 0.5;
  float dry = clamp(smoothstep(0.42, 0.82, patch) * (0.30 + uWear), 0.0, 1.0);

  // Tussocks. Each one leans its own way, which is what stops a lawn reading as
  // a single sheet of noise.
  vec2 g = uv * uCells;
  vec2 cell = floor(g);
  vec2 f = fract(g) - 0.5;
  vec4 rnd = bosHash42(bosWrap(cell, vec2(uCells)) + 0.37);
  vec2 lp = bosRot(rnd.x * BOS_TAU) * f;

  float blades = bosFbm01(vec2(lp.x * 44.0, lp.y * 5.0) + rnd.zw * 19.0, vec2(64.0, 8.0), 3, 0.62);
  float fine   = bosFbm01(vec2(lp.x * 118.0, lp.y * 12.0) + rnd.yx * 7.0, vec2(128.0, 16.0), 2, 0.5);
  float blade = blades * 0.66 + fine * 0.34;

  float r = length(f);
  float mound = 1.0 - smoothstep(0.12, 0.55, r);
  float gap = smoothstep(0.38, 0.50, max(abs(f.x), abs(f.y)));

  vec3 c = mix(deep, lush, smoothstep(0.12, 0.70, blade));
  c = mix(c, mid, smoothstep(0.44, 0.92, blade) * 0.70);
  c = mix(c, pale, smoothstep(0.58, 0.96, fine) * 0.32);
  c *= 0.82 + 0.36 * rnd.y;
  c = mix(c, straw, dry * (0.30 + 0.45 * blade));

  // Thatch and bare soil between the tussocks and in the worn patches.
  float soilN = bosFbm01(uv * 230.0, vec2(230.0), 3, 0.5);
  float bare = clamp(gap * 0.45 + smoothstep(0.74, 0.97, patch) * uWear * 1.3, 0.0, 1.0);
  c = mix(c, soil * (0.82 + 0.36 * soilN), bare * 0.55);

  // Clover rosettes and broadleaf weeds.
  vec3 wo = bosWorley(uv * 24.0, vec2(24.0), 1.0);
  float clover = smoothstep(0.15, 0.05, wo.x) * step(0.80, wo.z);
  c = mix(c, bosSrgb8(78.0, 108.0, 60.0), clover * 0.65);

  // Fallen leaves / litter.
  vec3 lv = bosWorley(uv * 40.0, vec2(40.0), 1.0);
  float leaf = smoothstep(0.11, 0.03, lv.x) * step(1.0 - uDebris, lv.z);
  c = mix(c, bosSrgb8(126.0, 92.0, 52.0) * (0.7 + 0.6 * lv.z), leaf * 0.8);

  s.albedo = c * bosSrgb(uBase);
  s.rough = clamp(0.86 - 0.10 * smoothstep(0.5, 1.0, blade) + 0.06 * dry + 0.06 * bare, 0.2, 1.0);
  s.metal = 0.0;
  s.ao = clamp(1.0 - 0.42 * (1.0 - blade) - 0.22 * gap + 0.10 * mound, 0.0, 1.0);
  s.height = (blade - 0.5) * uRelief + mound * uRelief * 0.9 + (rnd.w - 0.5) * uRelief * 0.7
           + leaf * uRelief * 0.4;
}

// ------------------------------------------------------------------- dirt ---

void bosDirt(vec2 uv, inout BosSurface s) {
  vec3 wetDark = bosSrgb8(58.0, 44.0, 32.0);
  vec3 loam    = bosSrgb8(96.0, 74.0, 53.0);
  vec3 dustPal = bosSrgb8(148.0, 126.0, 98.0);
  vec3 clay    = bosSrgb8(122.0, 86.0, 60.0);

  float broad = bosWarpFbm(uv * 4.0, vec2(4.0), 4, 0.55, 1.3) * 0.5 + 0.5;
  float mottle = bosFbm01(uv * 26.0, vec2(26.0), 4, 0.55);
  float grit = bosFbm01(uv * 380.0, vec2(380.0), 3, 0.5);

  vec3 c = mix(wetDark, loam, smoothstep(0.25, 0.70, broad));
  c = mix(c, clay, smoothstep(0.55, 0.90, mottle) * 0.55);
  c = mix(c, dustPal, smoothstep(0.40, 0.95, broad) * uWear * 0.8);
  c *= 0.88 + 0.24 * mottle;
  c *= 0.94 + 0.12 * grit;

  // Pebbles pressed into the surface and small clods.
  vec3 pb = bosWorley(uv * 96.0, vec2(96.0), 1.0);
  float pebble = smoothstep(0.16, 0.05, pb.x) * step(0.62, pb.z);
  vec3 stone = mix(bosSrgb8(132.0, 124.0, 112.0), bosSrgb8(92.0, 84.0, 74.0), pb.z);
  c = mix(c, stone, pebble * 0.85);

  vec3 cl = bosWorley(uv * 34.0, vec2(34.0), 1.0);
  float clod = smoothstep(0.24, 0.08, cl.x) * step(0.45, cl.z);

  // Desiccation cracks in the dry areas.
  float crackF = bosRidge(uv * 11.0, vec2(11.0), 4, 0.55);
  float crack = smoothstep(0.86, 0.97, crackF) * smoothstep(0.45, 0.85, broad) * uWear;

  // Tyre / boot scuffs: shallow parallel drags.
  float scuff = bosFbm01(vec2(uv.x * 8.0, uv.y * 150.0), vec2(8.0, 150.0), 3, 0.5);

  c *= 1.0 - 0.45 * crack;
  c *= 0.96 + 0.08 * scuff;

  s.albedo = c * bosSrgb(uBase);
  s.rough = clamp(0.90 + 0.08 * grit - 0.10 * pebble + 0.04 * crack, 0.3, 1.0);
  s.metal = 0.0;
  s.ao = clamp(1.0 - 0.55 * crack - 0.25 * (1.0 - clod) * 0.4, 0.0, 1.0);
  s.height = (mottle - 0.5) * uRelief * 0.9
           + clod * uRelief * 0.55
           + pebble * uRelief * 0.5
           + (grit - 0.5) * uRelief * 0.18
           - crack * uRelief * 1.6;
}

// ----------------------------------------------------------------- gravel ---

void bosGravel(vec2 uv, inout BosSurface s) {
  // Two grades of crushed stone so the size distribution is not uniform.
  vec4 big = bosVoronoi(uv * uCells, vec2(uCells), 1.0);
  vec3 small = bosWorley(uv * (uCells * 2.0), vec2(uCells * 2.0), 1.0);

  float crown = smoothstep(0.0, 0.16, big.x);
  crown = pow(crown, 0.55);
  float smallTop = smoothstep(0.26, 0.06, small.x);

  vec4 rnd = bosHash42(vec2(big.y * 91.7, big.y * 37.3) + 0.37);

  vec3 pale  = bosSrgb8(158.0, 152.0, 140.0);
  vec3 grey  = bosSrgb8(116.0, 114.0, 108.0);
  vec3 warm  = bosSrgb8(134.0, 116.0, 96.0);
  vec3 dark  = bosSrgb8(74.0, 72.0, 70.0);
  vec3 fines = bosSrgb8(86.0, 80.0, 70.0);

  float t = rnd.x;
  vec3 c = mix(grey, pale, smoothstep(0.0, 0.45, t));
  c = mix(c, warm, smoothstep(0.48, 0.72, t) * 0.8);
  c = mix(c, dark, smoothstep(0.80, 1.0, t));
  c *= 0.84 + 0.30 * rnd.y;

  // Crushed stone has flat fracture facets, not a smooth dome.
  float facet = bosFbm01(uv * 260.0, vec2(260.0), 2, 0.5);
  c *= 0.90 + 0.20 * facet;

  // Fines and dust packed between the stones.
  float dustN = bosFbm01(uv * 300.0, vec2(300.0), 3, 0.5);
  vec3 dust = fines * (0.82 + 0.34 * dustN);
  float inGap = 1.0 - crown;

  c = mix(c, mix(c, pale, 0.35), smallTop * 0.4 * inGap);
  vec3 albedo = mix(c, dust, inGap * (0.55 + 0.35 * uWear));

  s.albedo = albedo * bosSrgb(uBase);
  s.rough = clamp(mix(0.78 + 0.14 * facet, 0.95, inGap) - 0.06 * crown, 0.2, 1.0);
  s.metal = 0.0;
  s.ao = clamp(1.0 - 0.72 * inGap * inGap, 0.0, 1.0);
  s.height = crown * uRelief * (0.75 + 0.5 * rnd.z)
           + smallTop * uRelief * 0.28 * inGap
           + (facet - 0.5) * uRelief * 0.22
           + (dustN - 0.5) * uRelief * 0.10;
}

// ------------------------------------------------------------------- sand ---

void bosSand(vec2 uv, inout BosSurface s) {
  vec3 dryPale = bosSrgb8(214.0, 196.0, 162.0);
  vec3 warmTan = bosSrgb8(188.0, 164.0, 126.0);
  vec3 damp    = bosSrgb8(134.0, 116.0, 92.0);

  // Wind ripples: a low-frequency wave train, direction-warped so it meanders.
  float warp = bosFbm(uv * 3.0, vec2(3.0), 3, 0.5);
  float ripple = sin((uv.y * 26.0 + warp * 2.2) * BOS_TAU) * 0.5 + 0.5;
  float ripple2 = sin((uv.x * 5.0 + uv.y * 11.0 + warp * 1.4) * BOS_TAU) * 0.5 + 0.5;
  float rip = ripple * 0.72 + ripple2 * 0.28;

  float dampF = bosWarpFbm(uv * 2.0, vec2(2.0), 4, 0.5, 1.2) * 0.5 + 0.5;
  float grain = bosFbm01(uv * 620.0, vec2(620.0), 2, 0.5);
  float coarse = bosFbm01(uv * 150.0, vec2(150.0), 3, 0.5);

  vec3 c = mix(warmTan, dryPale, smoothstep(0.3, 0.8, rip));
  c = mix(c, damp, smoothstep(0.62, 0.92, dampF) * (0.55 + 0.4 * uWear));
  c *= 0.93 + 0.14 * grain;
  c *= 0.95 + 0.10 * coarse;

  // Shell fragments and dark heavy-mineral streaks.
  vec3 sh = bosWorley(uv * 260.0, vec2(260.0), 1.0);
  float shell = smoothstep(0.09, 0.02, sh.x) * step(0.88, sh.z);
  c = mix(c, vec3(0.86, 0.84, 0.80), shell * 0.8);
  float heavy = smoothstep(0.70, 0.92, bosFbm01(vec2(uv.x * 40.0, uv.y * 9.0), vec2(40.0, 9.0), 4, 0.6));
  c = mix(c, bosSrgb8(96.0, 84.0, 78.0), heavy * 0.35);

  // Footprints: shallow oval depressions, only where the sand is dry.
  vec3 fp = bosWorley(uv * 9.0, vec2(9.0), 1.0);
  float foot = smoothstep(0.20, 0.07, fp.x) * step(1.0 - uDebris, fp.z);

  s.albedo = c * bosSrgb(uBase);
  s.rough = clamp(0.92 - 0.16 * smoothstep(0.6, 0.95, dampF) + 0.05 * grain - 0.2 * shell, 0.2, 1.0);
  s.metal = 0.0;
  s.ao = clamp(1.0 - 0.22 * (1.0 - rip) - 0.35 * foot, 0.0, 1.0);
  s.height = (rip - 0.5) * uRelief
           + (coarse - 0.5) * uRelief * 0.25
           + (grain - 0.5) * uRelief * 0.08
           - foot * uRelief * 2.4;
}

// ------------------------------------------------------------------ mulch ---

void bosMulch(vec2 uv, inout BosSurface s) {
  // Shredded bark: long thin chips lying in random directions on dark compost.
  vec2 g = uv * uCells;
  vec2 cell = floor(g);
  vec2 f = fract(g) - 0.5;
  vec4 rnd = bosHash42(bosWrap(cell, vec2(uCells)) + 0.37);

  // One chip per cell, rotated and elongated in the cell's own frame.
  vec2 lp = bosRot(rnd.x * BOS_TAU) * f;
  vec2 halfSz = vec2(0.40 + 0.16 * rnd.y, 0.10 + 0.07 * rnd.z);
  float wob = bosFbm(lp * 9.0 + rnd.zw * 11.0, vec2(32.0), 3, 0.5) * 0.035;
  float sd = bosSdRound(lp, halfSz, 0.045) + wob;
  float chip = 1.0 - smoothstep(-0.012, 0.012, sd);

  // Chip fibre runs along its length.
  float fibre = bosFbm01(vec2(lp.x * 8.0, lp.y * 90.0) + rnd.yx * 13.0, vec2(16.0, 128.0), 3, 0.55);

  vec3 redBark  = bosSrgb8(118.0, 62.0, 40.0);
  vec3 brnBark  = bosSrgb8(92.0, 64.0, 44.0);
  vec3 greyBark = bosSrgb8(104.0, 92.0, 80.0);
  vec3 compost  = bosSrgb8(44.0, 34.0, 27.0);

  vec3 bark = mix(redBark, brnBark, rnd.w);
  bark = mix(bark, greyBark, smoothstep(0.55, 1.0, rnd.y) * uWear);
  bark *= 0.84 + 0.32 * fibre;

  float soilN = bosFbm01(uv * 340.0, vec2(340.0), 3, 0.5);
  vec3 floorCol = compost * (0.80 + 0.45 * soilN);

  // A second, offset chip layer so the bed does not read as a single grid.
  vec2 g2 = uv * uCells + 0.5;
  vec2 cell2 = floor(g2);
  vec2 f2 = fract(g2) - 0.5;
  vec4 rnd2 = bosHash42(bosWrap(cell2, vec2(uCells)) + 4.73);
  vec2 lp2 = bosRot(rnd2.x * BOS_TAU) * f2;
  float sd2 = bosSdRound(lp2, vec2(0.34 + 0.14 * rnd2.y, 0.08 + 0.06 * rnd2.z), 0.04)
            + bosFbm(lp2 * 9.0 + rnd2.zw * 5.0, vec2(32.0), 3, 0.5) * 0.03;
  float chip2 = (1.0 - smoothstep(-0.012, 0.012, sd2)) * step(0.28, rnd2.w);
  vec3 bark2 = mix(brnBark, redBark, rnd2.y) * (0.8 + 0.3 * soilN);

  vec3 c = mix(floorCol, bark2, chip2 * 0.9);
  c = mix(c, bark, chip);

  float cover = max(chip, chip2 * 0.9);

  s.albedo = c * bosSrgb(uBase);
  s.rough = clamp(mix(0.95, 0.86 + 0.10 * fibre, cover), 0.3, 1.0);
  s.metal = 0.0;
  s.ao = clamp(1.0 - 0.55 * (1.0 - cover), 0.0, 1.0);
  s.height = chip2 * uRelief * 0.55 + chip * uRelief
           + (fibre - 0.5) * uRelief * 0.18 * chip
           + (soilN - 0.5) * uRelief * 0.12;
}

void bosShade(vec2 uv, inout BosSurface s) {
  if (uMode < 0.5)      bosGrass(uv, s);
  else if (uMode < 1.5) bosDirt(uv, s);
  else if (uMode < 2.5) bosGravel(uv, s);
  else if (uMode < 3.5) bosSand(uv, s);
  else                  bosMulch(uv, s);
}
`;
