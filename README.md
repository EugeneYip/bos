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

- **Performance.** At 1080p on `high` the reference viewpoints run 20–60 fps;
  the high aerial, with the whole city in frame, is the worst at 20. The post
  chain costs roughly half the frame, so `?post=off` or `?q=medium` are both
  worth trying on a laptop. Screen-space reflections and motion blur are
  reserved for `ultra`.
- **A white band sits on the horizon** in distant views — the ocean mirroring
  a bright sky at grazing incidence, not yet fully resolved into haze.
- **Under a dense tree canopy the ground goes very dark.** The metering is
  centre-weighted to compensate but does not fully recover it.
- **The Charles reads lighter than it should** from high altitude.

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
