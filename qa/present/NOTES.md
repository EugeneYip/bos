# Measuring a scene that is never still

Written after three wrong conclusions in one session, all from one cause:
comparing two single frames of a non-stationary scene. The visual findings
from that session are in the second half; this half is why none of them could
be trusted until the harness changed.

## What moves when nothing has changed

Same build, same viewpoint, same quality tier, camera static.

**Animation never settles, by design.** Capture a frame, settle 400 more
frames, capture again, and count pixels that moved by more than 12/255:

| pose | pixels moved | mean abs delta |
|---|---|---|
| boot-default | 6.84% | 1.75 |
| charles-water | 6.28% | 1.95 |
| common-street | **30.44%** | 8.80 |
| water-detail | **41.92%** | 5.90 |

Water, wind in the canopy, traffic and pedestrians are all running. A
single-frame pixel diff cannot validate anything at street level.

**Rendered triangle counts differ 25% between loads.** `stats.tris` is
`renderer.info.render.triangles` -- per-frame, after culling and LOD. Two
loads of one build at one pose converged to 12,649,972 and 9,443,766 with
*identical* building tile counts (358 both). So `tris` is a metric with a wide
spread, not a scene identity; refusing a comparison on it refuses everything.

**Weather converges on a timer.** `Sky.advanceWeather` eases weather over
about eight simulated seconds and `weather.haze` drives `uApBetaM`. Probes
here settled 160 frames (~2.7 s), so every frame was captured mid-transition.

**Within-load spread badly understates between-load spread.** Five frames from
one page load with a static camera have sd 0.01-0.05 on these metrics. The
offset between two independent loads is larger. Using the within-load sd as
the bar, a self-test against the *same build* "resolved" four differences.

## What the harness does about it

`qa/present/harness.mjs`, driven by `qa/present/_ab.mjs`.

1. **Converge on structure, not on a frame count.** `converge()` settles in
   rounds until the structural fingerprint stops changing: building tiles,
   shards, building count, tree count, tier, safe level, pixel ratio.
2. **Refuse mismatched arms.** `compare()` checks that fingerprint field by
   field and refuses outright when it differs, naming the fields. A delta
   measured across different content is not a measurement. `tris` is reported
   but never enforced; a >5% gap prints a warning about expected spread.
3. **Estimate noise between independent loads.** Each arm is several separate
   page loads (`LOADS`, default 3); each load contributes the mean of a small
   within-load ensemble (`N`); the sd *across loads* is the noise floor. A
   delta must clear `2 * pooled_sd * sqrt(2/LOADS)` to be called RESOLVED,
   otherwise it prints `not resolvable`.
4. **Refuse a single load.** With fewer than two loads per arm there is no
   noise estimate, so no delta can be called real.
5. **Catch the base-path trap.** A build made without `VITE_BASE=/` 404s every
   asset and sits on the boot overlay forever, which looks exactly like a
   hang. `open()` fails with one line naming the cause.

**Self-test:** `SELFTEST=1 A=<build> node qa/present/_ab.mjs` compares a build
against itself. Every metric must print `not resolvable`. If the guard
resolves a difference there, it is broken and nothing it says is worth
reading. Run it after any change to the metrics.

## Visual findings that survive

These were established by attribution rather than by A/B, so the timing bug
does not touch them.

- **The pale sheets across the opening view are `BuildingShell` roofs**, not
  terrain and not pavement. Raycasting the twelve brightest flat pixels in
  the lower half returns `buildings:NNNNNN<BuildingShell>` for eleven of them,
  at 1-3 km. From 560 m up, the flat tops of the low-rise tile together into
  what reads as white ground, which is why the city looks like a cardboard
  model standing on foam board.
- **Flat roofs were half bright gravel ballast** (`hex(168,164,154)`, albedo
  0.66) and carried a white TPO membrane on 42% of large footprints. Rebalanced
  to 18% gravel at `hex(138,134,126)`, membrane 0.20/0.10/0.03 and darker.
- **`far-terrain` has `envMap: false`**, so three.js substitutes
  `scene.environmentIntensity` and its authored `envMapIntensity` is dead.
  This trap has now been found in four modules here.
- **`park:grass` and `park:sand` carry `envMapIntensity: 2`** -- double
  ambient on the surfaces you stand on at street level. Prime suspect for the
  flat, washed-out Common.

## Ruled out, with the measurement

- **Not the sRGB helper.** `Materials.ts` `sRGB()` divides by 255 and does no
  transfer, but the shaders decode it themselves: `uBase` is declared `// sRGB
  base colour` and passed through `bosSrgb()`. "Fixing" the helper would have
  double-decoded every colour in the city.
- **Not the white `uBase: 0xffffff` on five terrain layers.** The ground
  shader generates its own grass/dirt/gravel/sand/mulch palettes; `uBase` is a
  tint and white means none.
- **Not aerial perspective.** `uApStrength` and `uApInscatterGain` reach 128
  live materials -- verified by reading the uniform back, not assumed -- and
  changing them leaves the frame bit-identical. Buildings take `scene.fog`,
  not `ctx.aerial`; only water consumes the aerial chunk.
- **Not fog.** `FogExp2(0x9fb6cc, 7e-5)` at 2.7 km is `1 - exp(-(7e-5 *
  2700)^2)` = 3.5%, worth about 6 luma against the ~105 observed.
- **Not the glass-mirror roughness path.** Roofs share the facade atlas so
  their depth channel reads as glass, and `mix(gSrf.b, 0.055, gGlass)` can
  hand a roof a mirror finish -- but masking it with `gFacade` is worth 2
  luma, and keying specular occlusion on the roof layers is worth 7.
- **The black-albedo test was flawed and proves less than it appeared to.**
  Driving `paintRoofTar`/`paintRoofGravel` base fills to `hex(8,8,8)` left the
  roofs at luma 100-118, which looked like proof that albedo was irrelevant.
  But both painters overlay hundreds of bright speckles (g = 120-240) on top
  of the base fill, so the roof was never actually black. Albedo is NOT ruled
  out.
