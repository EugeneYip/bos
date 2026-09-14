/**
 * Cobbles and setts.
 *
 * Acorn Street is rounded glacial field stone, not cut granite: irregular domed
 * cobbles roughly 120 mm across, laid in loose courses, each one sitting at its
 * own height so the surface is genuinely uneven underfoot. Sett mode gives the
 * cut-granite blocks used around Faneuil Hall and the North End.
 *
 * Cells come from a two-pass Voronoi with anisotropic jitter — jittered hard
 * across the course and only slightly along it, which is what produces rows
 * instead of a random spatter.
 */
export const COBBLE_GLSL = /* glsl */ `
uniform float uMode;        // 0 rounded cobble, 1 cut sett
uniform float uCells;       // cells per tile axis
uniform vec2  uJitter;      // per-axis site jitter
uniform float uDome;        // metres the crown stands above the joint
uniform float uVary;        // metres of per-stone settle
uniform float uJointW;      // joint width in cell units
uniform float uMoss;

// Anisotropic tileable Voronoi: edge distance, cell id, site offset.
vec4 bosCobbleCell(vec2 p, vec2 period, vec2 jitter) {
  vec2 i = floor(p), f = fract(p);
  vec2 mo = vec2(0.0), mi = vec2(0.0);
  float best = 8.0;
  for (int y = -1; y <= 1; y++) {
    for (int x = -1; x <= 1; x++) {
      vec2 o = vec2(float(x), float(y));
      vec2 r = o + 0.5 + (bosCell2(i + o, period) - 0.5) * jitter - f;
      float d = dot(r, r);
      if (d < best) { best = d; mo = r; mi = o; }
    }
  }
  float edge = 8.0;
  for (int y = -2; y <= 2; y++) {
    for (int x = -2; x <= 2; x++) {
      vec2 o = mi + vec2(float(x), float(y));
      vec2 r = o + 0.5 + (bosCell2(i + o, period) - 0.5) * jitter - f;
      vec2 diff = r - mo;
      float len = dot(diff, diff);
      if (len > 1e-5) edge = min(edge, dot(0.5 * (mo + r), normalize(diff)));
    }
  }
  return vec4(edge, bosCell1(i + mi, period), mo);
}

void bosShade(vec2 uv, inout BosSurface s) {
  // A gentle warp so the courses wander the way a hand-laid street does.
  vec2 warp = vec2(bosFbm(uv * 3.0, vec2(3.0), 3, 0.5),
                   bosFbm(uv * 3.0 + 5.1, vec2(3.0), 3, 0.5));
  vec2 p = uv * uCells + warp * vec2(0.30, 0.12);

  float edge, id; vec2 off;
  if (uMode < 0.5) {
    vec4 v = bosCobbleCell(p, vec2(uCells), uJitter);
    edge = v.x; id = v.y; off = v.zw;
  } else {
    // Cut setts: running-bond rectangles with a rounded arris.
    vec2 g = vec2(p.x * 0.5, p.y);
    float row = floor(g.y);
    float gx = g.x + 0.5 * mod(row, 2.0);
    vec2 local = vec2(fract(gx), fract(g.y)) - 0.5;
    float sd = -bosSdRound(local, vec2(0.5 - uJointW * 0.5, 0.5 - uJointW), 0.10);
    edge = sd;
    id = bosCell1(vec2(floor(gx), row), vec2(uCells * 0.5, uCells));
    off = local;
  }

  vec4 rnd = bosHash42(vec2(id * 97.3, id * 31.7) + 0.37);

  // ---- relief -------------------------------------------------------------
  float jointW = uJointW * 0.5;
  float crown = smoothstep(0.0, 0.30, edge);
  crown = pow(crown, 0.48);                        // fat, rounded top
  if (uMode > 0.5) crown = smoothstep(0.0, 0.06, edge);

  float settle = (rnd.x - 0.5) * 2.0 * uVary;
  float tilt = dot(off, (rnd.yz - 0.5)) * uVary * 1.8;

  // Stone surface: pitted glacial granite, worn smooth on the crown.
  float pit = bosFbm01(uv * 520.0, vec2(520.0), 3, 0.55);
  float lumps = bosFbm01(uv * 96.0, vec2(96.0), 3, 0.5);

  float h = crown * (uDome + settle) + tilt * crown
          + (lumps - 0.5) * uDome * 0.18 * crown
          + (pit - 0.5) * 0.0006;

  // Joint fill: sand and mortar washed down between the stones.
  float inJoint = 1.0 - smoothstep(0.0, jointW, edge);
  float jointFill = bosFbm01(uv * 300.0, vec2(300.0), 3, 0.5);
  h = mix(h, -uDome * 0.10 + (jointFill - 0.5) * 0.0015, inJoint);

  // ---- colour -------------------------------------------------------------
  vec3 grey  = bosSrgb8(132.0, 129.0, 122.0);
  vec3 warm  = bosSrgb8(150.0, 132.0, 110.0);
  vec3 pink  = bosSrgb8(148.0, 120.0, 112.0);
  vec3 dark  = bosSrgb8(84.0, 82.0, 80.0);
  vec3 blue  = bosSrgb8(104.0, 108.0, 114.0);

  float t = rnd.y;
  vec3 c = mix(grey, warm, smoothstep(0.0, 0.45, t));
  c = mix(c, pink, smoothstep(0.48, 0.68, t) * 0.8);
  c = mix(c, blue, smoothstep(0.70, 0.86, t));
  c = mix(c, dark, smoothstep(0.88, 1.0, t));
  c *= 0.84 + 0.32 * rnd.z;

  // Mineral speckle inside each stone.
  vec3 spec = bosWorley(uv * 420.0, vec2(420.0), 1.0);
  c *= 0.88 + 0.24 * spec.z;
  c *= 0.92 + 0.16 * lumps;
  c *= 0.95 + 0.10 * pit;

  // Centuries of traffic polish the crowns and darken them with road film.
  float polish = smoothstep(0.16, 0.42, edge);
  c *= mix(1.0, 0.86, polish * 0.8);

  vec3 joint = mix(bosSrgb8(122.0, 116.0, 102.0), bosSrgb8(86.0, 82.0, 74.0), jointFill);
  joint *= 0.88 + 0.24 * jointFill;

  float moss = uMoss * smoothstep(0.45, 0.75, bosFbm01(uv * 22.0, vec2(22.0), 4, 0.55));
  joint = mix(joint, bosSrgb8(74.0, 84.0, 56.0), moss * inJoint * 0.85);

  vec3 albedo = mix(c, joint, inJoint);

  // ---- response -----------------------------------------------------------
  float rough = 0.84 - 0.26 * polish + 0.10 * pit;
  rough = mix(rough, 0.95 + 0.04 * jointFill, inJoint);
  rough += moss * 0.05;

  float ao = 1.0 - 0.70 * (1.0 - smoothstep(0.0, 0.22, edge));
  ao *= 0.92 + 0.08 * lumps;

  s.albedo = albedo;
  s.rough = clamp(rough, 0.05, 1.0);
  s.metal = 0.0;
  s.ao = clamp(ao, 0.0, 1.0);
  s.height = h;
}
`;
