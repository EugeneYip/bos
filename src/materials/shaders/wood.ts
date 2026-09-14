/**
 * Wood.
 *
 * Two variants, both of which Boston is full of:
 *
 *  0 — painted clapboard. The siding on every triple-decker in Dorchester and
 *      every colonial in Charlestown: 4½" exposure lapped boards, the lower
 *      edge standing ~10 mm proud, nail lines at each stud, and paint that has
 *      alligatored and flaked back to primer on the weather side.
 *  1 — bare weathered plank. Decking, hoardings, dock timber: silvered grey
 *      softwood with raised grain, checking along the rays and rusted fixings.
 *
 * The grain is a warped ring function rather than noise: growth rings are
 * concentric about a pith that is off the board, so a flat-sawn board shows
 * long parabolic cathedrals, and a rift-sawn one shows nearly parallel stripes.
 * That difference, randomised per board, is what keeps a wall of clapboard from
 * looking like corduroy.
 */
export const WOOD_GLSL = /* glsl */ `
uniform float uMode;      // 0 painted clapboard, 1 bare weathered plank
uniform vec3  uBase;      // paint colour (mode 0) / heartwood colour (mode 1)
uniform float uCourses;   // boards per tile (down the V axis)
uniform float uLap;       // metres the board's lower edge stands proud
uniform float uWear;      // flaking / silvering
uniform float uGrain;     // ring contrast

vec3 bosWoodGrain(vec2 uv, vec2 local, vec4 rnd, out float ringRelief, out float roughMod) {
  // Distance to an off-board pith, warped so the rings wander.
  float sawn = rnd.x;                       // 0 rift-sawn .. 1 flat-sawn
  float pithY = mix(2.6, 0.18, sawn) * (rnd.y > 0.5 ? 1.0 : -1.0);
  vec2 d = vec2(local.x * mix(0.05, 0.012, sawn), local.y - pithY);
  float rad = length(d) * mix(26.0, 52.0, rnd.z);

  float wobble = bosFbm(vec2(local.x * 3.0, local.y * 9.0) + rnd.zw * 17.0, vec2(16.0, 32.0), 4, 0.55);
  rad += wobble * mix(0.9, 2.4, sawn);

  float ring = fract(rad + rnd.w * 7.0);
  // Latewood is a narrow dark band at the end of each ring.
  float late = smoothstep(0.62, 0.86, ring) * (1.0 - smoothstep(0.88, 0.99, ring));

  // Vessel/fibre streaks running the length of the board. Frequencies are set
  // so one lattice cell lands on several texels even at the 2048 hero size.
  float fibre = bosFbm01(vec2(local.x * 25.0, local.y * 6.0) + rnd.yx * 11.0, vec2(256.0, 16.0), 3, 0.55);
  float ray   = bosFbm01(vec2(local.x * 60.0, local.y * 3.0) + rnd.wz * 5.0, vec2(512.0, 8.0), 2, 0.5);

  vec3 early = bosSrgb8(186.0, 154.0, 114.0);
  vec3 lateC = bosSrgb8(124.0, 88.0, 56.0);
  vec3 c = mix(early, lateC, late * uGrain);
  c *= 0.90 + 0.18 * fibre;
  c *= 0.96 + 0.08 * ray;

  // Knots: a tight whorl of rings, dark and resinous.
  vec3 kn = bosWorley(uv * 7.0, vec2(7.0), 1.0);
  float knot = smoothstep(0.085, 0.020, kn.x) * step(0.80, kn.z);
  float knotRing = sin(kn.x * 240.0) * 0.5 + 0.5;
  c = mix(c, bosSrgb8(74.0, 48.0, 30.0) * (0.8 + 0.4 * knotRing), knot * 0.9);

  ringRelief = (late * uGrain - 0.35) * 0.0013 + (fibre - 0.5) * 0.0006 - knot * 0.0012;
  roughMod = 0.08 * late * uGrain + 0.10 * knot;
  return c;
}

void bosShade(vec2 uv, inout BosSurface s) {
  float gy = uv.y * uCourses;
  float course = floor(gy);
  float fy = fract(gy);
  vec4 rnd = bosHash42(vec2(mod(course * 3.0, uCourses), mod(course, uCourses)) + 0.37);

  // Butt joints: boards do not run the full length of a wall.
  float seg = floor(uv.x * 2.0 + rnd.z * 2.0);
  vec4 srnd = bosHash42(bosWrap(vec2(seg, course), vec2(2.0, uCourses)) + 5.19);
  float buttD = abs(fract(uv.x * 2.0 + rnd.z * 2.0) - 0.0);
  float butt = 1.0 - smoothstep(0.0, 0.006, min(buttD, 1.0 - buttD));

  // Board-local coordinates. X is segment-local so every noise argument derives
  // from a quantity that already wraps with the tile — no seam bookkeeping.
  vec2 local = vec2((fract(uv.x * 2.0 + rnd.z * 2.0) - 0.5) * 6.0, fy - 0.5);
  float ringRelief, roughMod;
  vec3 grain = bosWoodGrain(uv, local, srnd, ringRelief, roughMod);

  float relief, rough, ao = 1.0, metal = 0.0;
  vec3 albedo;

  if (uMode < 0.5) {
    // ---- painted clapboard -------------------------------------------------
    vec3 paint = bosSrgb(uBase) * (0.94 + 0.12 * srnd.y);

    // The board tapers: thin at the top under the lap, thick at the butt.
    float taper = fy;
    float butEdge = 1.0 - smoothstep(0.0, 0.10, fy);      // shadow line under the lap
    relief = uLap * (0.10 + 0.90 * taper) - butEdge * uLap * 0.55;

    // Paint holds the board's profile but softens the grain to a ghost.
    float ghost = 0.22 + 0.35 * uWear;
    albedo = mix(paint, paint * (0.80 + 0.40 * bosLum(grain) * 2.2), ghost * 0.5);
    relief += ringRelief * (0.35 + 0.9 * uWear);

    // Brush lay-off along the board.
    float brush = bosFbm01(vec2(uv.x * 320.0, uv.y * 22.0), vec2(320.0, 22.0), 3, 0.55);
    albedo *= 0.96 + 0.08 * brush;
    relief += (brush - 0.5) * 0.00025;

    // Alligatoring and flaking back to primer, worst near the butt edge.
    float alliF = bosRidge(uv * 26.0, vec2(26.0), 4, 0.55);
    float alli = smoothstep(0.80, 0.94, alliF) * uWear;
    float flakeF = bosWarpFbm(uv * 19.0, vec2(19.0), 4, 0.55, 1.0) * 0.5 + 0.5;
    float flake = smoothstep(0.66, 0.78, flakeF) * uWear * (0.45 + 0.9 * butEdge);

    vec3 primer = bosSrgb8(178.0, 168.0, 150.0);
    albedo = mix(albedo, primer, flake * 0.75);
    albedo = mix(albedo, grain * 0.75, flake * flake * 0.45);
    albedo *= 1.0 - 0.22 * alli;
    relief -= flake * 0.0006 + alli * 0.0003;
    rough = 0.42 + 0.30 * uWear + 0.34 * flake + 0.14 * alli + roughMod * 0.4;
    ao = 1.0 - 0.55 * butEdge - 0.25 * flake;

    // Nail line a third of the way up each board, one per stud (~460 mm).
    // Y is rescaled into the X cell's world units so the head stays circular.
    vec2 ng = vec2(fract(uv.x * 4.0) - 0.5, (fy - 0.34) * (4.0 / uCourses));
    float nail = smoothstep(0.012, 0.005, length(ng));
    albedo = mix(albedo, albedo * 0.72, nail * 0.7);
    relief -= nail * 0.0009;
    rough += nail * 0.10;

    // Rain-wash grime: dirt collects along the shadow line.
    float wash = bosFbm01(vec2(uv.x * 70.0, uv.y * 4.0), vec2(70.0, 4.0), 4, 0.6);
    float grime = smoothstep(0.50, 0.88, wash) * (0.25 + 0.75 * butEdge) * (0.3 + 0.7 * uWear);
    albedo *= mix(1.0, 0.70, grime);

  } else {
    // ---- bare weathered plank ----------------------------------------------
    vec3 silver = bosSrgb8(148.0, 145.0, 138.0);
    float weather = clamp(uWear * (0.55 + 0.7 * bosFbm01(uv * 6.0, vec2(6.0), 3, 0.5)), 0.0, 1.0);

    albedo = mix(grain * bosSrgb(uBase) * 1.6, silver, weather * 0.78);
    albedo *= 0.92 + 0.16 * bosFbm01(uv * 90.0, vec2(90.0), 3, 0.5);

    // Raised grain: weathering erodes the soft earlywood, leaving latewood proud.
    relief = -ringRelief * (1.2 + 2.6 * weather);

    // Checking: splits that open along the grain.
    float checkF = bosRidge(vec2(uv.x * 40.0, uv.y * 3.0), vec2(40.0, 3.0), 4, 0.5);
    float check = smoothstep(0.88, 0.98, checkF) * (0.3 + 0.9 * weather);
    albedo *= 1.0 - 0.45 * check;
    relief -= check * 0.0035;
    ao = 1.0 - 0.6 * check;

    // Board gap and the plank edge chamfer.
    float edge = 1.0 - smoothstep(0.0, 0.05, min(fy, 1.0 - fy));
    relief -= edge * uLap;
    ao *= 1.0 - 0.55 * edge;
    albedo *= 1.0 - 0.30 * edge;

    rough = 0.80 + 0.14 * weather + 0.10 * check + roughMod;

    // Rusted fixings bleeding down the board.
    vec2 ng = vec2(fract(uv.x * 4.0) - 0.5, (fy - 0.5) * (4.0 / uCourses));
    float screw = smoothstep(0.014, 0.006, length(ng));
    float bleed = smoothstep(0.06, 0.0, length(ng * vec2(1.0, 0.45)) - 0.012) * step(0.0, ng.y);
    albedo = mix(albedo, bosSrgb8(116.0, 72.0, 44.0), bleed * 0.35 * weather);
    albedo = mix(albedo, bosSrgb8(78.0, 62.0, 52.0), screw * 0.85);
    relief -= screw * 0.0012;
    metal = screw * 0.3;
  }

  // Butt joint / board end shadow, common to both modes.
  albedo *= 1.0 - 0.35 * butt;
  relief -= butt * uLap * 0.35;
  ao *= 1.0 - 0.45 * butt;

  s.albedo = albedo;
  s.rough = clamp(rough, 0.06, 1.0);
  s.metal = clamp(metal, 0.0, 1.0);
  s.ao = clamp(ao, 0.0, 1.0);
  s.height = relief;
}
`;
