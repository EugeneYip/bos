/**
 * Metals: anodised/brushed architectural panel, weathered copper, painted
 * steel, and gilded gold leaf for the State House dome.
 *
 * Metal base colour *is* F0, so the palettes here are the measured normal-
 * incidence reflectances: gold (1.000, 0.766, 0.336) linear, copper
 * (0.955, 0.638, 0.538), aluminium (0.913, 0.922, 0.924).
 *
 * Gold leaf gets its warmth from two things a flat yellow never has: a per-leaf
 * micro-wrinkle direction (23 kt leaf is 0.1 µm thick and takes the shape of
 * every tool mark in the bole underneath), and overlap seams every 85 mm where
 * the leaves lap. Those wrinkles are what make the specular streak.
 */
export const METAL_GLSL = /* glsl */ `
uniform float uMode;       // 0 anodised panel, 1 copper, 2 painted steel, 3 gold leaf
uniform vec3  uBase;       // sRGB base colour / paint colour
uniform float uPanels;     // panels or leaves per tile axis
uniform float uSeamDepth;  // metres
uniform float uWear;       // 0..1 corrosion / chipping
uniform float uRough;      // nominal roughness

void bosShade(vec2 uv, inout BosSurface s) {
  vec3 albedo = bosSrgb(uBase);
  float rough = uRough;
  float metal = 1.0;
  float h = 0.0;
  float ao = 1.0;

  if (uMode < 0.5) {
    // ---- anodised / brushed aluminium panel ------------------------------
    // Reveal joints between panels, oil-canning inside them, fine brush lines.
    vec2 g = uv * uPanels;
    vec2 f = fract(g);
    vec2 d = min(f, 1.0 - f);
    float dj = min(d.x, d.y);
    float reveal = 1.0 - smoothstep(0.006, 0.014, dj);

    vec4 rnd = bosHash42(bosWrap(floor(g), vec2(uPanels)) + 0.37);
    vec2 pl = f - 0.5;
    float oil = (1.0 - dot(pl, pl) * 3.6) * (rnd.x - 0.35) * 0.004
              + bosFbm(pl * 4.0 + rnd.yz * 8.0, vec2(32.0), 3, 0.5) * 0.0012;

    float brush = bosFbm01(vec2(uv.x * 2200.0, uv.y * 26.0), vec2(2200.0, 26.0), 3, 0.55);
    float brushMid = bosFbm01(vec2(uv.x * 420.0, uv.y * 9.0), vec2(420.0, 9.0), 2, 0.5);

    albedo *= 0.93 + 0.14 * brush;
    albedo *= 0.96 + 0.08 * rnd.y;
    albedo = mix(albedo, albedo * 0.28, reveal);
    rough = uRough * (0.78 + 0.44 * brushMid) + 0.06 * brush;
    rough = mix(rough, 0.85, reveal);
    metal = mix(1.0, 0.2, reveal);
    h = oil - reveal * uSeamDepth;
    h += (brush - 0.5) * 0.00012;
    ao = 1.0 - 0.45 * reveal;

    // Exposed fasteners along the panel edges.
    vec2 fg = fract(uv * uPanels * vec2(6.0, 1.0));
    float fastener = smoothstep(0.045, 0.02, length(vec2(fg.x - 0.5, f.y - 0.04)));
    fastener += smoothstep(0.045, 0.02, length(vec2(fg.x - 0.5, f.y - 0.96)));
    albedo = mix(albedo, albedo * 0.7, fastener * 0.8);
    h -= fastener * 0.0008;
    rough += fastener * 0.12;

  } else if (uMode < 1.5) {
    // ---- weathered copper -------------------------------------------------
    vec3 bare = bosSrgb8(250.0, 209.0, 193.0);        // fresh copper, F0
    vec3 brown = bosSrgb8(86.0, 52.0, 38.0);          // oxidised but not yet green
    vec3 patina = bosSrgb8(96.0, 160.0, 132.0);
    vec3 patinaPale = bosSrgb8(146.0, 190.0, 168.0);
    vec3 patinaDark = bosSrgb8(48.0, 88.0, 74.0);

    // Flat-lock seams.
    vec2 g = uv * uPanels;
    vec2 f = fract(g);
    vec2 d = min(f, 1.0 - f);
    float seam = 1.0 - smoothstep(0.004, 0.012, min(d.x, d.y));
    vec4 rnd = bosHash42(bosWrap(floor(g), vec2(uPanels)) + 0.37);

    float coverage = bosWarpFbm(uv * 5.0, vec2(5.0), 5, 0.55, 1.2) * 0.5 + 0.5;
    coverage = clamp(coverage * (0.7 + 0.6 * uWear) + uWear * 0.35, 0.0, 1.0);
    float crust = bosFbm01(uv * 210.0, vec2(210.0), 4, 0.6);
    float runoff = bosFbm01(vec2(uv.x * 90.0, uv.y * 4.0), vec2(90.0, 4.0), 4, 0.6);

    vec3 green = mix(patinaDark, patina, smoothstep(0.25, 0.62, crust));
    green = mix(green, patinaPale, smoothstep(0.6, 0.95, runoff) * 0.7);
    vec3 metalCol = mix(bare, brown, smoothstep(0.2, 0.8, coverage));

    float isPatina = smoothstep(0.35, 0.62, coverage);
    albedo = mix(metalCol, green, isPatina);
    albedo *= 0.9 + 0.2 * crust;
    metal = mix(1.0, 0.06, isPatina);
    rough = mix(0.36 + 0.18 * crust, 0.80 + 0.14 * crust, isPatina);
    h = (crust - 0.5) * 0.0009 * isPatina
      + bosFbm(uv * 26.0, vec2(26.0), 3, 0.5) * 0.0016
      - seam * uSeamDepth;
    h += smoothstep(0.006, 0.0, min(d.x, d.y)) * uSeamDepth * 1.6;   // raised lock
    ao = 1.0 - 0.35 * seam - 0.12 * (1.0 - crust) * isPatina;
    albedo *= 0.95 + 0.10 * rnd.x;

  } else if (uMode < 2.5) {
    // ---- painted steel ----------------------------------------------------
    metal = 0.0;
    float orange = bosFbm01(uv * 380.0, vec2(380.0), 3, 0.5);
    float sag = bosFbm01(uv * 22.0, vec2(22.0), 3, 0.5);
    albedo *= 0.94 + 0.12 * sag;
    h = (orange - 0.5) * 0.00035 + (sag - 0.5) * 0.0006;
    rough = uRough * (0.88 + 0.24 * orange);

    // Chips and rust bleed.
    float chipField = bosWarpFbm(uv * 30.0, vec2(30.0), 4, 0.55, 0.9) * 0.5 + 0.5;
    float chip = smoothstep(0.80, 0.90, chipField) * uWear;
    float rustField = bosFbm01(uv * 12.0, vec2(12.0), 4, 0.55);
    float bleed = smoothstep(0.55, 0.9, rustField) * uWear;
    vec3 primer = bosSrgb8(122.0, 58.0, 38.0);
    vec3 rust = bosSrgb8(126.0, 72.0, 40.0);
    albedo = mix(albedo, primer, chip * 0.85);
    albedo = mix(albedo, rust, bleed * 0.55);
    rough = mix(rough, 0.92, max(chip, bleed * 0.7));
    h -= chip * 0.0004;
    metal = mix(0.0, 0.35, chip * 0.4);
    ao = 1.0 - 0.2 * chip;

    // Vertical grime wash.
    float wash = bosFbm01(vec2(uv.x * 60.0, uv.y * 3.0), vec2(60.0, 3.0), 4, 0.6);
    albedo *= mix(1.0, 0.82, smoothstep(0.55, 0.9, wash) * 0.6);

  } else {
    // ---- gilded gold leaf -------------------------------------------------
    vec2 g = uv * uPanels;                       // leaves per tile
    vec2 f = fract(g);
    vec2 leafId = bosWrap(floor(g), vec2(uPanels));
    vec4 rnd = bosHash42(leafId + 0.37);

    // Per-leaf wrinkle direction: this is what makes the specular streak read
    // as brushed gilding instead of yellow enamel.
    // Leaf-local so the direction change lands exactly on the lap seam and the
    // whole field still tiles.
    float ang = rnd.x * BOS_TAU;
    vec2 lp = bosRot(ang) * (f - 0.5);
    float wrinkle = bosFbm01(vec2(lp.x * 11.0, lp.y * 62.0) + rnd.zw * 23.0,
                             vec2(64.0, 256.0), 3, 0.6);
    float wrinkleFine = bosFbm01(vec2(lp.x * 34.0, lp.y * 190.0) + rnd.yx * 41.0,
                                 vec2(128.0, 512.0), 2, 0.5);

    // The bole/gesso underneath is hand-worked, so the whole field undulates.
    float bole = bosFbm(uv * 9.0, vec2(9.0), 4, 0.55);

    // Leaf overlap: a hairline seam and a hair more thickness at the lap.
    vec2 d = min(f, 1.0 - f);
    float lap = 1.0 - smoothstep(0.0, 0.055, min(d.x, d.y));
    float seamLine = 1.0 - smoothstep(0.0, 0.012, min(d.x, d.y));

    h = (wrinkle - 0.5) * 0.00022
      + (wrinkleFine - 0.5) * 0.00008
      + bole * 0.0020
      + lap * 0.00012
      - seamLine * 0.00020;

    // Gold F0 with a little per-leaf variation; the lap reads very slightly
    // warmer because you are looking through two thicknesses.
    albedo = bosSrgb(uBase);
    albedo *= 0.96 + 0.07 * rnd.y;
    albedo = mix(albedo, albedo * vec3(1.0, 0.96, 0.88), lap * 0.5);

    // Weather: the dome dulls and picks up a faint grey bloom in the hollows.
    float dull = uWear * smoothstep(0.35, 0.75, bosFbm01(uv * 7.0, vec2(7.0), 4, 0.5));
    albedo = mix(albedo, albedo * 0.78 + 0.02, dull);

    metal = 1.0;
    rough = uRough * (0.70 + 0.60 * wrinkle) + 0.10 * wrinkleFine;
    rough += 0.16 * lap + 0.22 * dull;
    rough *= 0.92 + 0.16 * rnd.z;
    ao = 1.0 - 0.10 * seamLine;
  }

  s.albedo = albedo;
  s.rough = clamp(rough, 0.02, 1.0);
  s.metal = clamp(metal, 0.0, 1.0);
  s.ao = clamp(ao, 0.0, 1.0);
  s.height = h;
}
`;
