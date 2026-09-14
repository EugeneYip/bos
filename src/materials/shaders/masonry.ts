/**
 * Fired-clay masonry: running-bond brickwork and 45° herringbone pavers.
 *
 * Real-world module used by the registry:
 *   modular brick  194 x 57 mm + 10 mm joint  ->  204 x 68 mm module
 *   clay paver     200 x 100 mm + 3 mm joint
 *
 * Herringbone tiling note: with 2:1 units the pattern's translation lattice is
 * spanned by (2,2) and (2,-2) unit-widths, and a unit square at (i,j) belongs to
 * a horizontal unit when (i+j) mod 4 is 0 or 1 and a vertical one otherwise.
 * Rotating the sampling frame 45° makes the period axis-aligned again at
 * 2*sqrt(2) unit-widths, which is why `tileMeters` for pavers is 1.697 m.
 * Per-unit randomness is hashed in the rotated lattice basis (x+y, x-y) so it
 * stays seamless across the tile edge.
 */
export const MASONRY_GLSL = /* glsl */ `
uniform float uMode;        // 0 = running bond, 1 = herringbone 45
uniform vec2  uUnits;       // running bond: units across, courses down
uniform vec2  uJointFrac;   // joint width as a fraction of the module, per axis
uniform float uJointDepth;  // metres the mortar sits behind the face
uniform float uFaceRelief;  // metres of per-unit height jitter
uniform float uWPeriod;     // herringbone hash period in the rotated basis
uniform float uPaverW;      // herringbone: tile width measured in unit-widths
uniform float uEfflor;      // efflorescence / salt bloom amount
uniform float uGrime;       // soot and rain-wash amount
uniform float uWear;        // 0 = wall, 1 = trafficked paving
uniform vec3  uMortar;      // mortar colour, sRGB 0..1
uniform float uPalette;     // 0 = Boston red brick, 1 = wire-cut paver

vec3 bosBrickHue(float t) {
  vec3 c;
  if (uPalette < 0.5) {
    vec3 a = bosSrgb8(103.0, 47.0, 36.0);   // deep red-brown
    vec3 b = bosSrgb8(147.0, 63.0, 45.0);   // classic Boston red
    vec3 d = bosSrgb8(180.0, 95.0, 60.0);   // orange / salmon
    vec3 e = bosSrgb8(94.0, 51.0, 60.0);    // purple-brown
    vec3 f = bosSrgb8(78.0, 50.0, 47.0);    // clinker
    c = mix(a, b, smoothstep(0.00, 0.42, t));
    c = mix(c, d, smoothstep(0.38, 0.74, t));
    c = mix(c, e, smoothstep(0.79, 0.91, t));
    c = mix(c, f, smoothstep(0.955, 1.00, t));
  } else {
    vec3 a = bosSrgb8(128.0, 68.0, 52.0);
    vec3 b = bosSrgb8(154.0, 88.0, 64.0);
    vec3 d = bosSrgb8(110.0, 57.0, 47.0);
    vec3 e = bosSrgb8(80.0, 58.0, 56.0);
    c = mix(a, b, smoothstep(0.00, 0.50, t));
    c = mix(c, d, smoothstep(0.45, 0.86, t));
    c = mix(c, e, smoothstep(0.89, 1.00, t));
  }
  return c;
}

// ---- unit lookup -----------------------------------------------------------

void bosRunningBond(vec2 uv, out vec2 local, out float jm, out vec4 rnd, out float lengthwise) {
  vec2 g = uv * uUnits;
  float row = floor(g.y);
  float gx = g.x + 0.5 * mod(row, 2.0);
  float col = floor(gx);
  local = vec2(fract(gx), fract(g.y)) - 0.5;

  vec2 id = bosWrap(vec2(col, row), vec2(uUnits.x, uUnits.y));
  rnd = bosHash42(id + 0.37);

  vec2 q = abs(local);
  vec2 jh = uJointFrac * 0.5;
  vec2 t = clamp((q - (0.5 - jh)) / max(jh, 1e-4), 0.0, 1.0);
  jm = max(t.x, t.y);
  lengthwise = 1.0;
}

void bosHerringbone(vec2 uv, out vec2 local, out float jm, out vec4 rnd, out float lengthwise) {
  // Rotate the sampling frame -45° and measure in unit-widths.
  vec2 p = bosRot(-0.78539816) * (uv * uPaverW);
  vec2 i = floor(p);
  float k = mod(i.x + i.y, 4.0);

  vec2 base, half_;
  if (k < 0.5)       { base = i;                  half_ = vec2(1.0, 0.5); lengthwise = 1.0; }
  else if (k < 1.5)  { base = i - vec2(1.0, 0.0); half_ = vec2(1.0, 0.5); lengthwise = 1.0; }
  else if (k < 2.5)  { base = i;                  half_ = vec2(0.5, 1.0); lengthwise = 0.0; }
  else               { base = i - vec2(0.0, 1.0); half_ = vec2(0.5, 1.0); lengthwise = 0.0; }

  vec2 centre = base + half_;
  vec2 rel = (p - centre) / (half_ * 2.0);   // [-0.5,0.5] across the unit
  local = rel;

  vec2 w = bosWrap(vec2(base.x + base.y, base.x - base.y), vec2(uWPeriod));
  rnd = bosHash42(w * 0.5 + 0.37);

  // Joint width is constant in unit-widths, so convert per axis.
  vec2 jh = (uJointFrac * 0.5) / (half_ * 2.0);
  vec2 t = clamp((abs(rel) - (0.5 - jh)) / max(jh, 1e-4), 0.0, 1.0);
  jm = max(t.x, t.y);
}

// ---- shading ---------------------------------------------------------------

void bosShade(vec2 uv, inout BosSurface s) {
  vec2 local; float jm; vec4 rnd; float lengthwise;
  if (uMode < 0.5) bosRunningBond(uv, local, jm, rnd, lengthwise);
  else             bosHerringbone(uv, local, jm, rnd, lengthwise);

  // The mortar must fill most of the joint, not just its centre line: a
  // hairline joint reads as "brick-coloured tiles", not as brickwork.
  float face = 1.0 - smoothstep(0.0, 0.22, jm);   // 1 on the brick face
  float inJoint = smoothstep(0.04, 0.34, jm);

  // ---- clay body ----------------------------------------------------------
  vec3 clay = bosBrickHue(rnd.x);
  clay *= 0.86 + 0.28 * rnd.y;                    // per-unit value jitter

  // Sand-struck / wire-cut grain, drawn in tile space so it stays seamless.
  float grain = bosFbm01(uv * 240.0, vec2(240.0), 3, 0.55);
  float grit  = bosFbm01(uv * 700.0, vec2(700.0), 2, 0.5);
  clay *= 0.90 + 0.20 * grain;
  clay *= 0.96 + 0.08 * grit;

  // Kiln flashing: a soft darker/lighter wash across each unit, random direction.
  float flashAngle = rnd.z * BOS_TAU;
  float flash = dot(local, vec2(cos(flashAngle), sin(flashAngle))) + 0.5;
  clay *= mix(1.0, 0.80 + 0.42 * flash, 0.45 + 0.35 * rnd.w);

  // Faces cushion slightly and the arris rounds off.
  float cushion = 1.0 - dot(local, local) * 0.55;

  // ---- mortar -------------------------------------------------------------
  float mortarNoise = bosFbm01(uv * 420.0, vec2(420.0), 3, 0.55);
  float mortarBlotch = bosFbm01(uv * 11.0, vec2(11.0), 3, 0.5);
  vec3 mortar = bosSrgb(uMortar) * (0.80 + 0.32 * mortarNoise) * (0.90 + 0.20 * mortarBlotch);

  vec3 albedo = mix(clay, mortar, inJoint);

  // ---- relief -------------------------------------------------------------
  float unitH = (rnd.w - 0.5) * 2.0 * uFaceRelief;
  float faceH = unitH + cushion * uFaceRelief * 0.45
              + (grain - 0.5) * uFaceRelief * 0.5
              + (grit - 0.5) * uFaceRelief * 0.25;
  float mortarH = -uJointDepth * (0.50 + 0.50 * smoothstep(0.0, 1.0, jm))
                + (mortarNoise - 0.5) * uJointDepth * 0.35;
  float h = mix(faceH, mortarH, smoothstep(0.0, 0.28, jm));

  // Chipped corners on a minority of units.
  float chipSel = step(0.90, rnd.z);
  vec2 chipCorner = vec2(rnd.x > 0.5 ? 0.5 : -0.5, rnd.y > 0.5 ? 0.5 : -0.5);
  float chipD = length((local - chipCorner) * vec2(1.0, 2.2));
  float chip = chipSel * smoothstep(0.34, 0.06, chipD) * face;
  h -= chip * uJointDepth * 0.75;
  albedo = mix(albedo, clay * 1.28 + 0.02, chip * 0.7);

  // ---- weathering ---------------------------------------------------------
  // Efflorescence: salt bloom that starts at a sill-like line and runs down.
  // The start line is a sawtooth in V, so it is exactly tile-periodic — keep
  // its amplitude low and fade both ends, or it survives into the far mips as
  // a chevron lattice across the whole facade.
  float startY = 0.12 + 0.76 * bosFbm01(vec2(uv.x * 5.0, 3.1), vec2(5.0, 8.0), 2, 0.5);
  float below = fract(startY - uv.y);
  float run = exp(-below * 4.5) * smoothstep(0.0, 0.06, below) * smoothstep(1.0, 0.80, below);
  float streak = bosFbm01(vec2(uv.x * 60.0, uv.y * 2.0), vec2(60.0, 2.0), 4, 0.6);
  float efflor = smoothstep(0.58, 0.92, streak) * run * uEfflor;
  albedo = mix(albedo, mix(albedo, vec3(0.62, 0.61, 0.58), 0.75), efflor);

  // Soot and rain-wash: grime collects in the joints and in sheltered blotches.
  float grimeBlotch = bosFbm01(uv * vec2(7.0, 4.0), vec2(7.0, 4.0), 4, 0.55);
  float grime = uGrime * (0.35 + 0.65 * grimeBlotch) * (0.35 + 0.65 * inJoint);
  albedo *= mix(1.0, 0.58, grime);

  // Traffic polish for pavers: centres of units buff smooth and lighten.
  float polish = uWear * face * smoothstep(0.45, 0.05, length(local));

  // ---- outputs ------------------------------------------------------------
  s.albedo = albedo * mix(1.0, 1.06, polish);
  s.metal = 0.0;

  float clinker = smoothstep(0.93, 1.0, rnd.x) * (1.0 - uPalette);
  float rough = mix(0.90, 0.955, inJoint);
  rough -= 0.30 * clinker;                    // glazed clinker bricks glint
  rough -= 0.16 * polish;
  rough += 0.035 * efflor;
  rough += (grain - 0.5) * 0.05;
  s.rough = clamp(rough + (rnd.y - 0.5) * 0.05, 0.05, 1.0);

  float ao = 1.0 - 0.46 * smoothstep(0.0, 0.85, jm);
  ao *= 1.0 - 0.30 * chip;
  ao *= 0.90 + 0.10 * grain;
  s.ao = clamp(ao, 0.0, 1.0);

  s.height = h;
}
`;
