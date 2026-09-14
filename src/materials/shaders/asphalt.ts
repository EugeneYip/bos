/**
 * Bituminous pavement.
 *
 * Dense-graded hot-mix asphalt is a matrix of crushed aggregate (Boston's mixes
 * top out around 12.5 mm) floating in a bitumen mastic. What makes real asphalt
 * read as asphalt rather than as grey noise:
 *
 *  - the aggregate is *partly* exposed, and more so where tyres have polished
 *    the mastic away, so the surface has two distinct micro-scales;
 *  - the binder is not black. Fresh mix is near-black, but a year of UV bleaches
 *    it to a warm grey-brown, and wheel paths stay darker than the crown;
 *  - the defects are geometric, not fractal: rectangular utility-cut patches,
 *    straight cold joints between paving lanes, and crack seal applied as a
 *    glossy, slightly proud bead of rubberised tar.
 *
 * The crack seal in particular is the tell — it is shinier than everything
 * around it, which is why roughness variation matters here more than colour.
 */
export const ASPHALT_GLSL = /* glsl */ `
uniform float uMode;        // 0 highway/street, 1 parking lot / aged
uniform vec3  uBase;        // binder colour, sRGB
uniform float uAggregate;   // 0 sealed and smooth, 1 heavily ravelled
uniform float uCracks;      // crack density
uniform float uSeal;        // fraction of cracks that have been tar-sealed
uniform float uPatch;       // utility-cut patch density
uniform float uWear;        // polish / bleaching

void bosShade(vec2 uv, inout BosSurface s) {
  // ---- mastic -------------------------------------------------------------
  vec3 fresh = bosSrgb(uBase);
  vec3 bleached = bosSrgb8(126.0, 122.0, 118.0);

  float uvAge = bosWarpFbm(uv * 2.5, vec2(2.5), 4, 0.55, 1.3) * 0.5 + 0.5;
  float age = clamp(uWear * (0.45 + 0.75 * uvAge), 0.0, 1.0);
  vec3 mastic = mix(fresh, bleached, age * 0.72);

  float blotch = bosFbm01(uv * 7.0, vec2(7.0), 4, 0.55);
  float mottle = bosFbm01(uv * 44.0, vec2(44.0), 4, 0.55);
  mastic *= 0.86 + 0.28 * blotch;
  mastic *= 0.93 + 0.14 * mottle;

  // ---- aggregate ----------------------------------------------------------
  // Coarse stone (~10 mm) and the fine fraction (~3 mm) under it.
  vec3 coarse = bosWorley(uv * 96.0, vec2(96.0), 1.0);
  vec3 finer  = bosWorley(uv * 300.0, vec2(300.0), 1.0);

  // Exposure: the binder film is thin where the mix has ravelled.
  float ravel = smoothstep(0.35, 0.80, bosFbm01(uv * 13.0, vec2(13.0), 4, 0.55));
  float exposure = clamp(uAggregate * (0.40 + 0.85 * ravel), 0.0, 1.0);

  float bigTop = smoothstep(0.19, 0.05, coarse.x);
  float smallTop = smoothstep(0.20, 0.06, finer.x);

  // New England mixes are mostly grey traprock and granite with a little quartz.
  vec3 trap   = bosSrgb8(104.0, 102.0, 100.0);
  vec3 gran   = bosSrgb8(142.0, 138.0, 130.0);
  vec3 quartz = bosSrgb8(176.0, 172.0, 164.0);
  vec3 stone = mix(trap, gran, smoothstep(0.25, 0.75, coarse.z));
  stone = mix(stone, quartz, smoothstep(0.86, 1.0, coarse.z));
  stone *= 0.86 + 0.28 * bosFbm01(uv * 340.0, vec2(340.0), 2, 0.5);

  vec3 albedo = mix(mastic, mastic * 0.85 + stone * 0.5, smallTop * exposure * 0.55);
  albedo = mix(albedo, stone, bigTop * exposure * 0.80);

  float rough = 0.94 - 0.10 * exposure * bigTop;
  float relief = (bigTop * exposure) * 0.0021
               + (smallTop * exposure) * 0.0007
               + (mottle - 0.5) * 0.0008
               - ravel * exposure * 0.0012;
  float ao = 1.0 - 0.30 * (1.0 - bigTop) * exposure;

  // ---- tyre polish --------------------------------------------------------
  // Wheel paths buff the mastic flat and dark; the crown between them stays
  // open-textured. Axis: the tile's V runs along the road.
  float path = uMode < 0.5
    ? max(exp(-pow((uv.x - 0.26) * 5.2, 2.0)), exp(-pow((uv.x - 0.74) * 5.2, 2.0)))
    : smoothstep(0.45, 0.85, bosFbm01(uv * 3.0, vec2(3.0), 3, 0.5));
  float polish = clamp(path * uWear, 0.0, 1.0);
  albedo *= mix(1.0, 0.82, polish * 0.7);
  rough -= 0.16 * polish;
  relief -= polish * 0.0006;

  // ---- utility-cut patches ------------------------------------------------
  vec2 pg = uv * 3.0;
  vec2 pid = floor(pg);
  vec2 pf = fract(pg) - 0.5;
  vec4 prnd = bosHash42(bosWrap(pid, vec2(3.0)) + 6.31);
  vec2 psz = vec2(0.17 + 0.20 * prnd.x, 0.15 + 0.22 * prnd.y);
  float edgeWob = bosFbm(uv * 90.0, vec2(90.0), 2, 0.5) * 0.010;
  float pd = bosSdBox(pf, psz) + edgeWob;
  float patch = step(1.0 - uPatch, prnd.z) * (1.0 - smoothstep(0.0, 0.008, pd));
  float patchRim = step(1.0 - uPatch, prnd.z)
                 * (1.0 - smoothstep(0.006, 0.020, abs(pd)));

  // A patch is newer mix: darker, finer, and it always sits a little low.
  albedo = mix(albedo, mix(albedo, bosSrgb8(46.0, 45.0, 46.0), 0.62), patch * (0.55 + 0.4 * prnd.w));
  rough = mix(rough, 0.90, patch * 0.6);
  relief -= patch * 0.006 * (0.4 + 0.6 * prnd.w);
  relief += patchRim * 0.0035;                      // squeezed-out tack coat
  ao *= 1.0 - 0.35 * patchRim;

  // ---- cracking -----------------------------------------------------------
  // Fatigue cracking grows out of the wheel paths; block cracking is broader.
  float fatigue = bosRidge(uv * 17.0, vec2(17.0), 5, 0.55);
  float block = bosRidge(uv * 5.0, vec2(5.0), 4, 0.55);
  float crackF = max(smoothstep(0.87, 0.975, fatigue) * (0.35 + 0.9 * path),
                     smoothstep(0.90, 0.985, block) * 0.8);
  float crack = clamp(crackF * uCracks, 0.0, 1.0);

  // Sealed cracks: a proud, glossy, jet-black rubber bead ~40 mm wide.
  float sealSel = step(1.0 - uSeal, bosFbm01(uv * 2.0, vec2(2.0), 2, 0.5));
  float sealed = crack * sealSel;
  float open = crack * (1.0 - sealSel);

  albedo = mix(albedo, vec3(0.010, 0.010, 0.011), open * 0.85);
  relief -= open * 0.0055;
  ao *= 1.0 - 0.70 * open;

  vec3 tar = bosSrgb8(24.0, 23.0, 24.0);
  albedo = mix(albedo, tar, sealed * 0.92);
  rough = mix(rough, 0.22 + 0.10 * mottle, sealed * 0.88);
  relief += sealed * 0.0028;

  // ---- surface film -------------------------------------------------------
  // Oil drips in the parking-lot variant; tyre rubber and road film everywhere.
  if (uMode > 0.5) {
    vec3 dr = bosWorley(uv * 8.0, vec2(8.0), 1.0);
    float drip = smoothstep(0.10, 0.02, dr.x) * step(0.78, dr.z);
    albedo = mix(albedo, albedo * 0.45, drip * 0.8);
    rough -= drip * 0.40;
  }

  float film = bosFbm01(uv * 1.0 + 3.7, vec2(1.0), 3, 0.5);
  albedo *= 0.95 + 0.10 * film;

  s.albedo = albedo;
  s.rough = clamp(rough + (mottle - 0.5) * 0.05, 0.10, 1.0);
  s.metal = 0.0;
  s.ao = clamp(ao, 0.0, 1.0);
  s.height = relief;
}
`;
