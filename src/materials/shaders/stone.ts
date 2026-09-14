/**
 * Cut stone: Back Bay brownstone, Indiana-style limestone ashlar, and Quincy
 * granite (Boston's signature grey, coarse and speckled with feldspar, smoky
 * quartz and biotite).
 *
 * Blocks are laid in courses with a quantised per-course bond offset and an
 * occasional double-length block, which is what real ashlar looks like — a
 * strictly regular grid reads as wallpaper.
 */
export const STONE_GLSL = /* glsl */ `
uniform float uMode;        // 0 brownstone, 1 limestone, 2 granite
uniform vec2  uBlocks;      // blocks across, courses down (uBlocks.x must be even)
uniform vec2  uJointFrac;   // joint width as a fraction of the block, per axis
uniform float uJointDepth;  // metres
uniform float uJoints;      // 0 = monolithic stone, 1 = ashlar coursing
uniform float uGrain;       // mineral grain frequency, cycles per tile
uniform float uSoot;        // urban blackening
uniform float uDrafted;     // 0..1 chance a block has a tooled margin

// ---- ashlar layout ---------------------------------------------------------

void bosAshlar(vec2 uv, out vec2 local, out float jm, out vec4 rnd, out float widthMul) {
  vec2 g = uv * uBlocks;
  float row = floor(g.y);
  float off = floor(bosHash11(mod(row, uBlocks.y) * 7.13 + 0.3) * 4.0) * 0.25;
  float gx = g.x + off;
  float col = floor(gx);

  // Occasionally fuse a pair of cells into one long block.
  float pair = floor(col * 0.5);
  vec2 pairId = bosWrap(vec2(pair, row), vec2(uBlocks.x * 0.5, uBlocks.y));
  float merge = step(0.58, bosHash12(pairId + 3.17));

  float lx, hx;
  if (merge > 0.5) {
    lx = (gx - (pair * 2.0 + 1.0)) * 0.5;
    hx = 0.5;
    widthMul = 2.0;
    rnd = bosHash42(pairId + 0.37);
  } else {
    lx = fract(gx) - 0.5;
    hx = 0.5;
    widthMul = 1.0;
    rnd = bosHash42(bosWrap(vec2(col, row), uBlocks) + 0.91);
  }

  local = vec2(lx, fract(g.y) - 0.5);
  vec2 jh = vec2(uJointFrac.x * 0.5 / widthMul, uJointFrac.y * 0.5);
  vec2 t = clamp((abs(local) - (hx - jh)) / max(jh, 1e-4), 0.0, 1.0);
  jm = max(t.x, t.y) * uJoints;
}

// ---- stone bodies ----------------------------------------------------------

vec3 bosBrownstone(vec2 uv, vec2 local, vec4 rnd, out float relief, out float rough) {
  // Warm chocolate -> tan Portland/Connecticut brownstone.
  vec3 dark = bosSrgb8(76.0, 48.0, 35.0);
  vec3 mid  = bosSrgb8(112.0, 74.0, 50.0);
  vec3 tan_ = bosSrgb8(150.0, 110.0, 76.0);
  vec3 base = mix(dark, mid, smoothstep(0.0, 0.6, rnd.x));
  base = mix(base, tan_, smoothstep(0.55, 1.0, rnd.x) * 0.8);

  // Fine bedding laminations, slightly tilted per block.
  vec2 bp = bosRot((rnd.z - 0.5) * 0.22) * local;
  float bed = bosFbm01(vec2(bp.x * 2.5, bp.y * 130.0 + rnd.y * 40.0), vec2(48.0, 512.0), 3, 0.55);
  float bedFine = bosFbm01(vec2(bp.x * 6.0, bp.y * 420.0), vec2(64.0, 1024.0), 2, 0.5);
  base *= 0.88 + 0.24 * bed;
  base *= 0.95 + 0.10 * bedFine;

  // Sand grain.
  float sand = bosFbm01(uv * 620.0, vec2(620.0), 2, 0.5);
  base *= 0.94 + 0.12 * sand;

  // Spalling: brownstone delaminates in sheets, exposing a paler, rougher core.
  float spallMask = step(0.72, rnd.w);
  float spallShape = bosFbm01(local * 7.0 + rnd.xy * 13.0, vec2(28.0), 4, 0.55);
  float spall = spallMask * smoothstep(0.52, 0.66, spallShape);
  base = mix(base, base * 1.32 + 0.012, spall * 0.8);

  relief = (bed - 0.5) * 0.0016 + (sand - 0.5) * 0.0006 - spall * 0.009;
  rough = 0.82 + 0.10 * bedFine + 0.10 * spall;
  return base;
}

vec3 bosLimestone(vec2 uv, vec2 local, vec4 rnd, out float relief, out float rough) {
  vec3 base = mix(bosSrgb8(196.0, 188.0, 166.0), bosSrgb8(168.0, 160.0, 140.0), rnd.x);
  float mottle = bosFbm01(uv * 90.0, vec2(90.0), 4, 0.55);
  float fine = bosFbm01(uv * 480.0, vec2(480.0), 3, 0.5);
  base *= 0.90 + 0.18 * mottle;
  base *= 0.95 + 0.10 * fine;

  // Fossil / shell flecks.
  vec3 sh = bosWorley(uv * 320.0, vec2(320.0), 1.0);
  float fleck = smoothstep(0.16, 0.04, sh.x) * step(0.70, sh.z);
  base = mix(base, base * 1.25 + 0.02, fleck * 0.8);

  // Drafted margin: a chiselled band round the block face, recessed a few mm.
  vec2 e = abs(local);
  float drafted = step(1.0 - uDrafted, rnd.z);
  float band = smoothstep(0.36, 0.43, max(e.x, e.y));
  float chisel = bosFbm01(vec2(local.x * 170.0, local.y * 9.0), vec2(256.0, 32.0), 2, 0.5);
  float margin = -drafted * band * (0.0022 + 0.0014 * chisel);
  float tooled = drafted * band;

  relief = (mottle - 0.5) * 0.0022 + (fine - 0.5) * 0.0008 + fleck * 0.0006 + margin;
  base *= 1.0 - 0.06 * tooled;
  rough = 0.80 + 0.12 * mottle + 0.08 * tooled;
  return base;
}

vec3 bosGranite(vec2 uv, vec4 rnd, out float relief, out float rough, out float metal) {
  // Interlocking crystals: a coarse Voronoi for the feldspar/quartz phases and a
  // finer one for the dark mica flakes.
  vec2 wp = uv * uGrain + vec2(bosFbm(uv * 18.0, vec2(18.0), 2, 0.5) * 0.35);
  vec4 v = bosVoronoi(wp, vec2(uGrain), 0.95);
  float t = v.y;

  vec3 feldspar = bosSrgb8(168.0, 166.0, 160.0);
  vec3 greyFeld = bosSrgb8(126.0, 128.0, 131.0);
  vec3 quartz   = bosSrgb8(96.0, 100.0, 108.0);
  vec3 biotite  = bosSrgb8(34.0, 34.0, 38.0);

  vec3 c = mix(greyFeld, feldspar, smoothstep(0.26, 0.52, t));
  c = mix(c, quartz, smoothstep(0.60, 0.80, t));
  c = mix(c, biotite, smoothstep(0.855, 0.925, t));

  // Intra-crystal shading so the grains are not flat chips of colour.
  float within = bosFbm01(uv * uGrain * 3.5, vec2(uGrain * 4.0), 3, 0.55);
  c *= 0.88 + 0.24 * within;

  // Fine black mica flakes scattered over everything.
  vec3 mica = bosWorley(uv * uGrain * 3.2, vec2(uGrain * 3.0), 1.0);
  float flake = smoothstep(0.13, 0.02, mica.x) * step(0.55, mica.z);
  c = mix(c, biotite * 0.7, flake * 0.85);

  // Broad tonal drift so a big ashlar block is not perfectly uniform.
  float drift = bosFbm01(uv * 5.0, vec2(5.0), 3, 0.5);
  c *= 0.93 + 0.14 * drift;
  c *= 0.94 + 0.12 * rnd.x;

  // Thermal (flamed) finish: the surface spalls along crystal boundaries.
  float edge = smoothstep(0.0, 0.22, v.x);
  relief = (edge - 0.6) * 0.0022 + (within - 0.5) * 0.0010 - flake * 0.0006
         + (drift - 0.5) * 0.0025;

  // Quartz is glassy, feldspar semi-matte, biotite mirror-flat but tiny.
  rough = 0.62 + 0.20 * within;
  rough -= 0.22 * smoothstep(0.60, 0.80, t);
  rough -= 0.34 * flake;
  rough += 0.10 * (1.0 - edge);
  metal = flake * 0.25;
  return c;
}

// ---- shading ---------------------------------------------------------------

void bosShade(vec2 uv, inout BosSurface s) {
  vec2 local; float jm; vec4 rnd; float widthMul;
  bosAshlar(uv, local, jm, rnd, widthMul);

  float relief = 0.0, rough = 0.8, metal = 0.0;
  vec3 body;
  if (uMode < 0.5)      body = bosBrownstone(uv, local, rnd, relief, rough);
  else if (uMode < 1.5) body = bosLimestone(uv, local, rnd, relief, rough);
  else                  body = bosGranite(uv, rnd, relief, rough, metal);

  // ---- mortar joint -------------------------------------------------------
  float inJoint = smoothstep(0.10, 0.60, jm);
  float mortarNoise = bosFbm01(uv * 380.0, vec2(380.0), 3, 0.5);
  vec3 mortarCol = mix(bosSrgb8(150.0, 145.0, 134.0), bosSrgb8(108.0, 104.0, 96.0), 0.35);
  mortarCol *= 0.82 + 0.34 * mortarNoise;

  vec3 albedo = mix(body, mortarCol, inJoint);
  float h = mix(relief, -uJointDepth * (0.55 + 0.45 * jm) + (mortarNoise - 0.5) * 0.0012,
                smoothstep(0.0, 0.32, jm));

  // ---- urban weathering ---------------------------------------------------
  // Soot sticks where rain cannot reach: under the top arris of each course and
  // in the joints. Rain-washed zones stay pale.
  float wash = bosFbm01(vec2(uv.x * 9.0, uv.y * 3.0), vec2(9.0, 3.0), 4, 0.55);
  float ledge = smoothstep(0.34, 0.50, local.y) * (1.0 - smoothstep(0.46, 0.50, local.y));
  float soot = uSoot * (0.30 + 0.70 * wash) * (0.30 + 0.55 * inJoint + 0.6 * ledge);
  albedo *= mix(1.0, 0.55, clamp(soot, 0.0, 1.0));

  float streak = bosFbm01(vec2(uv.x * 46.0, uv.y * 2.2), vec2(46.0, 2.0), 4, 0.6);
  float startY = 0.1 + 0.8 * bosFbm01(vec2(uv.x * 4.0, 7.7), vec2(4.0, 8.0), 2, 0.5);
  float rain = smoothstep(0.55, 0.9, streak) * exp(-fract(startY - uv.y) * 3.6);
  albedo *= mix(1.0, 0.78, rain * uSoot * 1.4);

  s.albedo = albedo;
  s.rough = clamp(mix(rough, 0.93, inJoint) + 0.05 * soot, 0.04, 1.0);
  s.metal = metal * (1.0 - inJoint);
  s.ao = clamp((1.0 - 0.60 * smoothstep(0.0, 0.85, jm)) * (0.92 + 0.08 * mortarNoise), 0.0, 1.0);
  s.height = h;
}
`;
