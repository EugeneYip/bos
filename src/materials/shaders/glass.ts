/**
 * Curtain wall.
 *
 * A stick-system facade: 1.2 m vision panes stacked on 3.6 m floor modules, a
 * spandrel band hiding the slab edge, extruded aluminium mullions with EPDM
 * gaskets, and — the thing that actually sells a glass tower — a per-pane bow.
 *
 * Every pane of a real curtain wall is slightly dished by the pressure
 * difference across the insulating unit, by a few millimetres to a couple of
 * centimetres over its span. That is why the Hancock Tower's reflection of the
 * sky breaks into a quilt of tilted panels instead of one continuous mirror.
 * The bow lives in the height field, so the Sobel pass turns it into a real,
 * physically scaled normal; the encode is dithered because a 4° deviation
 * quantises to only a dozen 8-bit levels.
 */
export const GLASS_GLSL = /* glsl */ `
uniform vec2  uPanes;         // panes across, floors down
uniform float uSpandrel;      // spandrel height as a fraction of a floor
uniform float uMullionW;      // mullion width as a fraction of a pane
uniform float uMullionH;      // transom height as a fraction of a floor
uniform float uMullionDepth;  // metres the mullion stands proud of the glass
uniform float uBow;           // metres of peak pane deflection
uniform vec3  uGlass;         // vision glass tint, sRGB
uniform vec3  uSpandrelCol;   // spandrel panel colour, sRGB
uniform vec3  uFrame;         // anodised mullion colour, sRGB
uniform float uGlassRough;
uniform float uGlassMetal;
uniform float uGrime;

void bosShade(vec2 uv, inout BosSurface s) {
  vec2 g = uv * uPanes;
  vec2 cell = floor(g);
  vec2 f = fract(g);

  // ---- frame layout -------------------------------------------------------
  float mw = uMullionW * 0.5;
  float mh = uMullionH * 0.5;

  float dv = min(f.x, 1.0 - f.x);                 // to the nearest vertical mullion
  float dhFloor = min(f.y, 1.0 - f.y);            // to the floor-line transom
  float dhSpan = abs(f.y - uSpandrel);            // to the spandrel transom
  float dh = min(dhFloor, dhSpan);

  float vMull = 1.0 - smoothstep(mw - 0.004, mw, dv);
  float hMull = 1.0 - smoothstep(mh - 0.004, mh, dh);
  float frame = max(vMull, hMull);

  // Gasket: a matte black EPDM bead just inboard of the metal.
  float gasketW = mw * 0.42;
  float gv = (1.0 - smoothstep(mw + gasketW, mw + gasketW + 0.003, dv)) * step(mw, dv);
  float gh = (1.0 - smoothstep(mh + gasketW, mh + gasketW + 0.003, dh)) * step(mh, dh);
  float gasket = max(gv, gh) * (1.0 - frame);

  float isSpandrel = step(f.y, uSpandrel);

  // ---- pane-local coordinates --------------------------------------------
  float py = isSpandrel > 0.5
    ? f.y / max(uSpandrel, 1e-3)
    : (f.y - uSpandrel) / max(1.0 - uSpandrel, 1e-3);
  vec2 pl = vec2(f.x, py);
  vec2 q = pl * 2.0 - 1.0;                        // [-1,1] across the pane

  vec2 paneId = bosWrap(cell + vec2(0.0, isSpandrel * 0.5), uPanes);
  vec4 rnd = bosHash42(paneId + 0.37);
  vec4 rnd2 = bosHash42(paneId * 1.7 + 11.3);

  // ---- pane bow -----------------------------------------------------------
  // A dish plus a low-order ripple; sign and amplitude vary pane to pane.
  float dish = (1.0 - q.x * q.x) * (1.0 - q.y * q.y);
  float amp = (rnd.x - 0.40) * 1.7;
  float ripple = sin(q.x * (2.0 + rnd.y * 2.4) + rnd.z * BOS_TAU)
               * sin(q.y * (1.4 + rnd.w * 1.8) + rnd2.x * BOS_TAU);
  float bow = uBow * (amp * dish + 0.30 * (rnd2.y - 0.5) * ripple * (1.0 - q.y * q.y * q.y * q.y));

  // Insulating units sag very slightly toward their lower edge.
  bow += uBow * 0.12 * (1.0 - q.y) * (1.0 - q.x * q.x);

  // ---- frame profile ------------------------------------------------------
  // Mullion caps are pressure plates: a flat face with a shallow centre score.
  float capV = 1.0 - smoothstep(0.0, mw, dv);
  float capH = 1.0 - smoothstep(0.0, mh, dh);
  float cap = max(capV, capH);
  float score = smoothstep(0.35, 0.0, max(dv / max(mw, 1e-4), dh / max(mh, 1e-4)));

  float height = mix(bow, uMullionDepth * (0.55 + 0.45 * cap) - score * uMullionDepth * 0.22, frame);
  height = mix(height, -uMullionDepth * 0.18, gasket);

  // ---- glass appearance ---------------------------------------------------
  vec3 glass = bosSrgb(uGlass);
  glass *= 0.90 + 0.20 * rnd.y;                             // per-pane transmission spread
  glass *= mix(vec3(1.0), vec3(0.96, 1.02, 1.05), rnd.z);   // slight per-pane hue drift

  // Interior read-through: ceiling shadow at the head, a warm floor near the sill,
  // and venetian blinds on a minority of panes.
  float ceiling = smoothstep(0.72, 1.0, pl.y) * 0.45;
  float blindSel = step(0.68, rnd.w);
  float blindDrop = 0.30 + 0.55 * rnd2.z;
  float blinds = blindSel * step(pl.y, blindDrop)
               * (0.55 + 0.45 * sin(pl.y * 190.0 + rnd2.w * 30.0));
  vec3 interior = mix(glass, glass * 0.35, ceiling);
  interior = mix(interior, mix(glass, bosSrgb8(150.0, 146.0, 136.0), 0.55), blinds * 0.6);

  float glassRough = uGlassRough * (0.75 + 0.5 * rnd2.w);
  float glassMetal = uGlassMetal * (0.94 + 0.10 * rnd.x);

  // ---- spandrel -----------------------------------------------------------
  vec3 spandrel = bosSrgb(uSpandrelCol) * (0.86 + 0.28 * rnd2.y);
  float oil = bosFbm(pl * 3.0 + rnd.xy * 9.0, vec2(24.0), 3, 0.5);
  spandrel *= 0.94 + 0.12 * (oil * 0.5 + 0.5);
  // Shadow-box panels catch a little light at the head.
  spandrel *= mix(1.0, 1.14, smoothstep(0.55, 1.0, pl.y));

  // ---- mullion ------------------------------------------------------------
  vec3 metalCol = bosSrgb(uFrame);
  float brush = bosFbm01(vec2(uv.x * 900.0, uv.y * 40.0), vec2(900.0, 40.0), 2, 0.5);
  metalCol *= 0.90 + 0.20 * brush;
  metalCol *= 1.0 - 0.18 * score;

  // ---- composite ----------------------------------------------------------
  vec3 albedo = mix(interior, spandrel, isSpandrel);
  float rough = mix(glassRough, 0.42 + 0.12 * (oil * 0.5 + 0.5), isSpandrel);
  float metal = mix(glassMetal, 0.28, isSpandrel);

  albedo = mix(albedo, metalCol, frame);
  rough = mix(rough, 0.30 + 0.16 * brush, frame);
  metal = mix(metal, 0.95, frame);

  albedo = mix(albedo, vec3(0.014, 0.014, 0.015), gasket);
  rough = mix(rough, 0.78, gasket);
  metal = mix(metal, 0.0, gasket);

  // ---- grime --------------------------------------------------------------
  // Rain runs down the glass and pools dirt on the transom ledges.
  float streak = bosFbm01(vec2(uv.x * 190.0, uv.y * 5.0), vec2(190.0, 5.0), 4, 0.6);
  float dirt = uGrime * smoothstep(0.55, 0.95, streak) * (1.0 - frame);
  float ledge = uGrime * 1.6 * smoothstep(0.06, 0.0, abs(f.y - uSpandrel) - mh)
              * step(f.y, uSpandrel + mh + 0.05);
  dirt = clamp(dirt + ledge * 0.5, 0.0, 1.0);
  albedo = mix(albedo, albedo * 0.72 + 0.035, dirt);
  rough = mix(rough, min(rough + 0.30, 0.9), dirt * 0.8);

  s.albedo = albedo;
  s.rough = clamp(rough, 0.015, 1.0);
  s.metal = clamp(metal, 0.0, 1.0);
  s.ao = clamp(1.0 - 0.35 * gasket - 0.18 * frame * (1.0 - cap), 0.0, 1.0);
  s.height = height;
}
`;
