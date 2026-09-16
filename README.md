# Boston — Real-Time 3D City

A photoreal, physically-based, real-time 3D model of Boston, Massachusetts,
running in the browser on WebGL2.

**▶ [Open the live model](https://eugeneyip.github.io/bos/)**

Every building footprint, road, park, and shoreline is real geographic data —
not a stylised approximation. Terrain comes from USGS elevation, so Beacon Hill,
Bunker Hill, and the Dorchester drumlins are the heights they actually are.

---

## What's in it

| System | What it does |
|---|---|
| **Terrain** | USGS 3DEP / SRTM heightfield over the whole peninsula, with blended land-cover surfacing |
| **Buildings** | The full OSM building stock, extruded with real heights, roof forms, and neighbourhood-correct materials |
| **Landmarks** | Hand-authored hero geometry: the Hancock Tower, the Prudential, the gold State House dome, the Zakim Bridge, Fenway Park, the Custom House clock tower and more |
| **Sky** | Physically-correct solar position for Boston's latitude, analytic atmospheric scattering, volumetric clouds, stars and moon |
| **Water** | The Charles, Boston Harbor, and Fort Point Channel with animated, reflective, depth-aware water |
| **Materials** | A fully procedural PBR library — Boston red brick, Back Bay brownstone, Quincy granite, curtain-wall glass, Beacon Hill cobblestone |
| **Post** | TAA, GTAO, screen-space reflections, bloom, bokeh depth of field, auto-exposure and filmic grading |
| **Physics** | Rapier rigid-body simulation for collision, walking, and driving |

## Where it stands

The city is real and complete: 63,180 buildings, 4,253 km of road, 105 water
bodies, 1.1 M terrain posts, 89,279 trees and 3,754 parks — all from
OpenStreetMap and USGS, all rendering together, and all of it alive: vehicles
on a lane graph recovered from the street network, pedestrians on the
footways, rowing shells and ferries on the water, flags on the flagpoles.
Beyond the modelled box a coarse USGS heightfield carries the Blue Hills, the
Middlesex Fells and the harbour islands out to 23 km.

The frame goes through a full post chain: temporal antialiasing, ground-truth
ambient occlusion, screen-space reflections, bloom, depth of field, motion
blur, metered auto-exposure and a filmic grade. Everything upstream of the
grade stays in linear HDR; the grade is the single place the image is
tonemapped and written to sRGB.

Verified against reality — 200 Clarendon 241 m, the Prudential 229 m, One
Dalton 226 m; Beacon Hill 30 m, Bunker Hill's crest 33 m, Dorchester Heights
43 m; the Charles carved to −3.6 m and the harbour to −12 m.

Still rough, and worth knowing before you look:

- **Performance, and three things this section used to get wrong.** At 1280×720
  on `high` the reference viewpoints run around 30 fps, and there is no single
  bottleneck to fix. Measured by hiding one layer at a time, five interleaved
  repeats each, medians, inside one page session (`qa/_ablayer.mjs`) — because
  rebuilding and comparing two builds on this machine gives 38 fps and 15 fps
  for the *same* commit:

  | | ms of a 32 ms frame |
  |---|---|
  | buildings | 4.2 |
  | roads | 3.9 |
  | trees | 2.8 |
  | traffic | 2.8 |
  | landmarks, parks | 1.0 each |
  | shadows — all three cascades, 655 draw calls | 0.9 |
  | water, props, terrain, far terrain, pedestrians, the T | at or below a ±2 ms noise floor |

  Sixteen of the thirty-two milliseconds are scene geometry, spread thin. The
  rest is the sky, the post chain, the module updates (`cpu.update`) and the
  cost of handing the frame to the driver (`cpu.submit`, about 13 µs per draw
  call at 1500–2500 calls a frame). So the lever that matters is draw-call
  count — roads alone submit 894, eleven materials per tile — not any one
  layer.

  What this section claimed before: that the renderer is fill-bound (it is not
  — quartering the pixel count buys 16%, doubling it costs 17%), that the post
  chain is half the frame (it is not — `?post=off` is worth a few
  milliseconds), and that shadows are expensive (0.9 ms). All three came from
  per-pass GPU timers that were reporting 46 ms inside a 32 ms frame, because
  three modules each run their own `TIME_ELAPSED` query and WebGL2 allows
  exactly one in flight per context. Those timers are still wrong. `cpu.update`
  and `cpu.submit` are wall-clock and are not. Screen-space reflections and
  motion blur are reserved for `ultra`.
- **Four duplicate footprints survive** the extraction pass, down from 111.
  They are pairs mapped twice with genuinely different shapes, where picking a
  winner needs a judgement the pipeline does not have.
- **About sixteen thousand pairs of footprints share a party wall**, and 269 km
  of wall between them. That is not a defect — a terrace is buildings sharing
  party walls — and it costs two coincident quads apiece that nothing will ever
  see.
- **The far-field heightfield is flat.** 407 m posts shaded by elevation and
  slope is enough for a silhouette; at 15 km, where half the hill's own colour
  still reaches the eye, it reads as a smear rather than as land.

Five defects listed here through the last two rounds are fixed, and each
turned out to be a different thing than it looked like:

- *The white band on the horizon* was not the sea mirroring the sky. It was
  the far-field terrain, which mixed a hand-authored near-white haze colour in
  at `dithering_fragment` — a chunk that runs *after* `tonemapping_fragment`,
  so a display-referred constant went straight to the output, on top of the
  physical aerial perspective the sky module had already applied correctly.
  The far terrain and the water now both use that shared atmosphere, published
  on `ctx.aerial`, so the sea, the hills and the dome converge on the same
  radiance by construction rather than by three separately tuned constants.
- *The dark ground under canopy* was not metering and not the canopy. The
  park polygons are drawn `DoubleSide`, three maps `DoubleSide` to
  `DoubleSide` for the shadow pass rather than to `BackSide`, and the surface
  failed the depth comparison against its own front faces — Boston Common was
  shadowing itself while the terrain a centimetre below it was correctly lit
  and correctly dappled. Parks, roads, water and the far field had all set
  `castShadow = false` and had it handed straight back by the sky module's
  per-frame sweep. Foliage separately gained the indirect half of its leaf
  transmission, which under a closed canopy is very nearly the only light
  there is.
- *Lit windows clipping to white* was two problems, neither of them the
  windows. The city had two systems setting exposure and only one was being
  listened to: the sky publishes an artistic value on the renderer, the grade
  blends that with its own metering, and at night the metered half is three
  times higher — the windows compensated for 5.3 while the frame went out at
  14. The presenter now publishes what it applied, on `ctx.exposure`. That
  alone fixes nothing, and it is worth being precise about why: the windows are
  most of the light in a night frame, so dimming them makes the metering raise
  exposure and hands about half of it back. What had to change was the ratio —
  roofs carry the same surface atlas as the walls, so their depth channel reads
  as 'glass' and the emissive mask was lighting every flat roof downtown.
- *The streets were pitch black after dark* — a defect the new eye-level night
  viewpoint exposed rather than one that was listed. The lamps glowed but cast
  no light; the road surface measured 0 to 14 out of 255. Ten thousand lamps
  cannot each be a light in a forward renderer, but street lighting does not
  move, so it is rasterised once into a field indexed by world XZ and read by
  every material with one fetch. It comes from the street network rather than
  from `highway=street_lamp`, which has about five per cent of Boston's lamps
  and none at all within 168 m of the Financial District's central junction.
- *Party walls z-fighting*, which was listed here and was wrong about the
  mechanism. A party wall cannot fight: its two faces point away from each
  other, so whichever one is front-facing from a given eye is the one buried
  inside the neighbour, and the other is back-face culled. What fights is the
  *roof*. Where two traces overlap by a few centimetres and both buildings are
  tagged with the same storey count, the two roof planes are coplanar, both face
  up and neither is occluded — the one arrangement with no geometry to save it.
  Neither footprint is wrong, so neither can be deleted; separating them by
  5 cm is enough, and that is below what the source heights are accurate to. The
  camera's near plane is 0.35 m and the depth buffer 24-bit, which puts depth
  resolution at about 7 mm at 200 m and 17 cm at a kilometre, so 5 cm resolves
  cleanly well past the distance at which these slivers are more than a pixel.
  444 roofs moved; pairs that are coplanar to within 2 cm *and* genuinely
  overlap fall to three, totalling five square metres.
- *Buildings inside other buildings, everywhere.* The Prudential's was the one
  that got noticed, and fixing it properly took three passes. Containment has to
  be tested on the footprint rather than the area, or 111 Huntington's three
  dozen crown pinnacles stay buried in their own tower. It has to tolerate the
  boundary, because a `building:part` usually shares its parent's outer wall —
  often the very same nodes — and point-in-polygon is undefined there; testing
  strictly caught the Prudential, whose part floats a little inside the tower,
  and missed a thousand that touch. And it has to refuse to let a worse-described
  footprint swallow a better one: the Berkeley Building is named, coloured and
  given a material but no height, so it is inferred at 16 m, while the anonymous
  `building:part` describing its glass roof declares eight levels and comes out
  at 26 m. Geometry said the listed building was buried inside a slab. When
  geometry and tagging disagree that plainly, the tagging is what to trust.
  2,395 buried parts, 35 other buried footprints and 47 duplicates leave the
  data. Severe overlaps — both parties over 12 m tall, sharing a real volume —
  fall from 1,000 to 356, and what is left is mostly a tower standing on its own
  podium, which is a building, not a bug.
- *Landmarks drawn twice.* The extractor tagged the Boston Public Library
  `bpl-mckim` and MIT's Building 10 `mit-dome`, while the meshes were registered
  as `boston-public-library` and `mit-great-dome`. A slug that matches nothing
  suppresses nothing, so both footprints were extruded *and* both hand-authored
  meshes were placed on top of them. Fenway Park's building relation is tagged
  `building=stadium` and carries no name at all, so a name-only matcher could
  never find it and the ballpark was being built straight through the extruded
  one; it now has a position-guarded tag rule. Going the other way, the alias
  list let `prudential center` claim the tower's slug — suppressing the whole
  263 x 316 m retail podium in favour of a mesh that models only the tower, and
  leaving the Prudential standing in an empty block.
- *Green cycle tracks the length of the Esplanade.* Boston paints its bike lanes
  green at conflict points — where the lane crosses a junction and a driver
  turning across it has to look for a bike — not end to end. The obvious signal
  is the way's own `trimStart`/`trimEnd`, which record that an end was cut back
  for a junction fill; it does not work, because the network builder leaves
  cycleways out of the junction graph entirely, so their trims are always zero
  and keying the paint off them removes it from the whole city. The junction
  positions are the real signal and have to be handed in from the module that
  owns them.
- *A duplicate footprint inside the Prudential Center.*
  OpenStreetMap carries the tower twice: `w29869880`, tagged and named, and
  `w240259392`, a `building:part` repeating the tower's exact outline and
  stopping 14.6 m below its roof. The extractor's de-duplication asked whether
  a part's height was *similar* to its parent's, which is a different question
  from whether it is *contained*, so it kept it. That was harmless for as long
  as the parent was drawn over it — and then the parent, being a landmark, was
  suppressed in favour of the hand-authored mesh, and the invisible part became
  the only thing there: a bare grey slab standing inside the Prudential Tower.
  The test is containment now, and it runs on the footprint rather than on the
  area, which also clears 111 Huntington's three dozen crown pinnacles out of
  the inside of its own tower. 1,241 enclosed parts and 148 duplicate
  footprints leave the data; 651 records in total, none of them ever visible.
- *The Charles reading light from altitude* was a missing `1/PI`. The water's
  diffuse body was not divided by it the way every other Lambertian surface in
  the city is, so for the same nominal albedo the water came out PI times
  brighter than the land it runs through. At a grazing angle Fresnel hides
  that; from the air, where the body is ninety-seven per cent of the pixel, it
  does not.

## Controls

| | |
|---|---|
| Drag | Orbit |
| Scroll / pinch | Zoom |
| `W A S D` `Q E` | Fly (hold `Shift` to boost) |
| `H` | Hide the interface |
| `` ` `` | Performance overlay |

Append `?q=low` / `medium` / `high` / `ultra` to the URL to force a quality
tier, or `?ui=off` for a clean capture.

`node qa/shoot.mjs` photographs the reference viewpoints; `node qa/ui-check.mjs`
drives the interface, which no screenshot of the city can check.

`?post=off` bypasses post-processing entirely; `?post=taa,ao,bloom` runs only
the stages you name (`taa`, `ao`, `ssr`, `bloom`, `mb`, `dof`, `exposure`,
`grain`, `vignette`, `ca`, `half`), which is the fastest way to find which
stage is responsible for something on screen.

## Running it locally

```bash
npm install
npm run dev
```

The geographic data in `public/data/` is committed, so the app runs immediately.
To regenerate it from source:

```bash
npm run data
```

That re-queries the Overpass API and AWS Terrain Tiles and rebuilds every
dataset. Responses are cached in `.cache/` so repeat runs are cheap.

```bash
npm run build      # typecheck + production bundle
node qa/shoot.mjs  # capture the reference viewpoints to qa/shots/
```

## How it's put together

See **[ARCHITECTURE.md](ARCHITECTURE.md)**. In short: every subsystem is a
`WorldModule` that talks to the rest of the world only through a shared `Ctx`,
so the sky, terrain, buildings and post-processing stay decoupled and can be
worked on independently.

## Data & attribution

- **Geometry** — © [OpenStreetMap](https://www.openstreetmap.org/copyright)
  contributors, licensed under the
  [Open Database License (ODbL)](https://opendatacommons.org/licenses/odbl/).
  Any derived database distributed from this project carries the same licence.
- **Elevation** — USGS 3DEP and NASA SRTM, via
  [AWS Terrain Tiles](https://registry.opendata.aws/terrain-tiles/) (public domain).

Textures are generated procedurally in code; there are no third-party art assets.

## Licence

Source code: MIT. Geographic data: ODbL, as above.
