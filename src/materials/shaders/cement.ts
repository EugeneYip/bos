/**
 * Cementitious surfaces: board-formed brutalist concrete (Boston City Hall),
 * acid-etched precast panels, scored sidewalk slabs, and troweled stucco.
 *
 * The board-form variant is the specific one: 9" formwork planks leave
 * horizontal impressions with the grain of the boards transferred into the face,
 * a proud fin of grout at every plank joint, and a grid of snap-tie cones.
 */
export const CEMENT_GLSL = /* glsl */ `
uniform float uMode;        // 0 board-form, 1 precast, 2 sidewalk, 3 stucco
uniform vec3  uBase;        // sRGB base colour
uniform float uPlanks;      // board-form: planks per tile
uniform float uTies;        // board-form: snap-tie cones per tile axis
uniform float uPanels;      // precast/sidewalk: panels per tile axis
uniform float uJointDepth;  // metres
uniform float uStain;       // rain staining amount
uniform float uAggregate;   // exposed aggregate amount

// Shared cement body: blotchy paste with fine sand and a scatter of aggregate.
vec3 bosCementBody(vec2 uv, out float relief, out float rough) {
  vec3 base = bosSrgb(uBase);

  float blotch = bosFbm01(uv * 6.0, vec2(6.0), 4, 0.55);
  float mottle = bosFbm01(uv * 34.0, vec2(34.0), 4, 0.55);
  float sand = bosFbm01(uv * 520.0, vec2(520.0), 3, 0.5);
  base *= 0.88 + 0.24 * blotch;
  base *= 0.93 + 0.14 * mottle;
  base *= 0.95 + 0.10 * sand;

  // Fine and coarse aggregate showing through an etched or worn surface.
  vec3 agFine = bosWorley(uv * 300.0, vec2(300.0), 1.0);
  vec3 agCoarse = bosWorley(uv * 96.0, vec2(96.0), 1.0);
  float pebbleFine = smoothstep(0.18, 0.05, agFine.x) * step(0.45, agFine.z);
  float pebbleBig = smoothstep(0.17, 0.06, agCoarse.x) * step(0.74, agCoarse.z);
  vec3 stone = mix(bosSrgb8(126.0, 122.0, 112.0), bosSrgb8(92.0, 86.0, 78.0), agCoarse.z);
  base = mix(base, stone, (pebbleFine * 0.35 + pebbleBig * 0.75) * uAggregate);

  // Air voids (bug holes) — small dark pits, a signature of formed concrete.
  vec3 voids = bosWorley(uv * 150.0, vec2(150.0), 1.0);
  float bug = smoothstep(0.10, 0.02, voids.x) * step(0.88, voids.z);
  base *= 1.0 - 0.55 * bug;

  relief = (mottle - 0.5) * 0.0018 + (sand - 0.5) * 0.0006
         + pebbleBig * 0.0010 * uAggregate - bug * 0.0035;
  rough = 0.86 + 0.10 * sand - 0.06 * pebbleBig * uAggregate + 0.06 * bug;
  return base;
}

// ---- variants --------------------------------------------------------------

void bosBoardForm(vec2 uv, inout vec3 albedo, inout float relief, inout float rough, out float ao) {
  float gy = uv.y * uPlanks;
  float plank = floor(gy);
  float py = fract(gy);
  vec4 rnd = bosHash42(vec2(0.0, mod(plank, uPlanks)) + 0.37);

  // Formwork grain: fibre streaks along the board plus growth-ring bands.
  float warp = bosFbm(vec2(uv.x * 5.0, plank * 3.7), vec2(20.0, 64.0), 3, 0.5);
  float ringPhase = py * (5.0 + 7.0 * rnd.x) + warp * 1.1 + rnd.y * 6.0;
  float rings = abs(fract(ringPhase) - 0.5) * 2.0;
  rings = pow(rings, 1.6);
  float fibre = bosFbm01(vec2(uv.x * 260.0, gy * 26.0), vec2(260.0, 256.0), 3, 0.55);

  float grain = rings * 0.6 + fibre * 0.4;
  albedo *= 0.90 + 0.18 * grain;
  relief += (grain - 0.5) * 0.0016;
  rough += (fibre - 0.5) * 0.05;

  // Each board sits a millimetre or two off its neighbour, and grout leaks at
  // the joint to leave a proud fin.
  float step_ = (rnd.z - 0.5) * 0.0035;
  float d = min(py, 1.0 - py);
  float fin = smoothstep(0.035, 0.0, d);
  relief += step_ + fin * 0.0035;
  albedo *= 1.0 - 0.10 * fin;
  ao = 1.0 - 0.20 * smoothstep(0.06, 0.0, d);

  // Snap-tie cones on a regular grid, most of them plugged with grey mortar.
  vec2 tg = uv * uTies;
  vec2 tid = floor(tg);
  vec2 tf = fract(tg) - 0.5;
  vec4 trnd = bosHash42(bosWrap(tid, vec2(uTies)) + 5.1);
  float cone = smoothstep(0.085, 0.055, length(tf));
  float plug = step(0.35, trnd.x);
  relief -= cone * (plug > 0.5 ? 0.0025 : 0.011);
  albedo = mix(albedo, albedo * (plug > 0.5 ? 1.10 : 0.62), cone);
  rough += cone * 0.05;
  ao *= 1.0 - 0.55 * cone * (1.0 - plug * 0.6);
}

void bosPanelJoints(vec2 uv, float panels, float grooveW, float bead,
                    inout vec3 albedo, inout float relief, inout float rough, inout float ao) {
  vec2 g = uv * panels;
  vec2 f = fract(g);
  vec2 d = min(f, 1.0 - f);
  float dj = min(d.x, d.y);

  float groove = 1.0 - smoothstep(grooveW * 0.5, grooveW, dj);
  float lip = smoothstep(grooveW * 2.6, grooveW * 1.1, dj) * (1.0 - groove);

  relief -= groove * uJointDepth;
  relief += lip * bead;
  albedo *= 1.0 - 0.28 * groove;
  rough += 0.05 * groove - 0.06 * lip;
  ao *= 1.0 - 0.55 * groove - 0.10 * lip;
}

void bosShade(vec2 uv, inout BosSurface s) {
  float relief, rough;
  vec3 albedo = bosCementBody(uv, relief, rough);
  float ao = 1.0;
  float metal = 0.0;

  if (uMode < 0.5) {
    // ---- board-formed ----------------------------------------------------
    bosBoardForm(uv, albedo, relief, rough, ao);

  } else if (uMode < 1.5) {
    // ---- precast panel ---------------------------------------------------
    bosPanelJoints(uv, uPanels, 0.010, 0.0, albedo, relief, rough, ao);
    vec2 pl = fract(uv * uPanels) - 0.5;
    relief += (1.0 - dot(pl, pl) * 3.4) * 0.0018;           // gentle panel bow

  } else if (uMode < 2.5) {
    // ---- sidewalk --------------------------------------------------------
    // Tooled control joints with the rounded edge the trowel leaves.
    bosPanelJoints(uv, uPanels, 0.006, 0.0012, albedo, relief, rough, ao);

    vec2 pid = floor(uv * uPanels);
    vec4 prnd = bosHash42(bosWrap(pid, vec2(uPanels)) + 2.3);
    albedo *= 0.93 + 0.14 * prnd.x;

    // Broom finish: coarse parallel striations, slightly wandering.
    float wobble = bosFbm(uv * vec2(3.0, 12.0), vec2(3.0, 12.0), 3, 0.5) * 0.35;
    float broom = sin(uv.y * 252.0 * BOS_TAU + wobble * 14.0);
    broom = broom * 0.5 + 0.5;
    float broomAmp = 0.55 + 0.45 * bosFbm01(uv * vec2(18.0, 3.0), vec2(18.0, 3.0), 3, 0.5);
    relief += (broom - 0.5) * 0.0009 * broomAmp;
    albedo *= 0.97 + 0.06 * broom * broomAmp;
    rough += (broom - 0.5) * 0.04;

    // Hairline cracks on a minority of panels.
    float crackField = bosRidge(uv * 9.0 + prnd.yz * 17.0, vec2(9.0), 4, 0.55);
    float crack = smoothstep(0.88, 0.975, crackField) * step(0.62, prnd.w);
    relief -= crack * 0.004;
    albedo *= 1.0 - 0.45 * crack;
    ao *= 1.0 - 0.55 * crack;

    // Gum, oil spots and general foot-traffic grime.
    vec3 gumC = bosWorley(uv * 14.0, vec2(14.0), 1.0);
    float gum = smoothstep(0.055, 0.018, gumC.x) * step(0.90, gumC.z);
    albedo = mix(albedo, bosSrgb8(52.0, 50.0, 48.0), gum * 0.85);
    rough -= gum * 0.22;
    float traffic = bosFbm01(uv * 4.0, vec2(4.0), 4, 0.5);
    albedo *= 0.88 + 0.16 * traffic;

  } else {
    // ---- stucco ----------------------------------------------------------
    // Skip-trowel: broad flat knife passes over a sand float coat.
    float warpx = bosFbm(uv * 7.0, vec2(7.0), 3, 0.5);
    float trowel = bosFbm01(uv * 15.0 + warpx * 1.6, vec2(15.0), 4, 0.6);
    float knife = smoothstep(0.48, 0.72, trowel);
    relief += knife * 0.0016 + (trowel - 0.5) * 0.0009;
    albedo *= 0.92 + 0.16 * trowel;
    rough += 0.04 * (1.0 - knife);

    float hair = bosRidge(uv * 18.0, vec2(18.0), 4, 0.5);
    float crack = smoothstep(0.90, 0.98, hair);
    relief -= crack * 0.0022;
    albedo *= 1.0 - 0.30 * crack;
    ao *= 1.0 - 0.40 * crack;
  }

  // ---- staining -----------------------------------------------------------
  // Rain streaks run vertically; dirt collects where the wash is weak.
  float startY = 0.08 + 0.84 * bosFbm01(vec2(uv.x * 4.0, 5.3), vec2(4.0, 8.0), 2, 0.5);
  float streakN = bosFbm01(vec2(uv.x * 70.0, uv.y * 3.0), vec2(70.0, 3.0), 4, 0.6);
  float streak = smoothstep(0.48, 0.86, streakN) * exp(-fract(startY - uv.y) * 3.2);
  float wash = bosFbm01(uv * 3.0, vec2(3.0), 4, 0.5);
  float stain = uStain * clamp(streak * 0.9 + (1.0 - wash) * 0.45, 0.0, 1.0);
  albedo *= mix(1.0, 0.62, stain);
  rough += 0.05 * stain;

  // Lime bloom: pale efflorescent haze in the sheltered zones.
  float bloom = uStain * smoothstep(0.62, 0.9, wash) * 0.5;
  albedo = mix(albedo, albedo * 0.6 + vec3(0.36, 0.355, 0.34), bloom);

  s.albedo = albedo;
  s.rough = clamp(rough, 0.05, 1.0);
  s.metal = metal;
  s.ao = clamp(ao, 0.0, 1.0);
  s.height = relief;
}
`;
