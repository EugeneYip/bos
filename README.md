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
bodies, 1.1 M terrain posts and 99,079 trees and street fittings, all from
OpenStreetMap and USGS, all rendering together.

Verified against reality — 200 Clarendon 241 m, the Prudential 229 m, One
Dalton 226 m; Beacon Hill 30 m, Bunker Hill's crest 33 m, Dorchester Heights
43 m; the Charles carved to −3.6 m and the harbour to −12 m.

Still rough, and worth knowing before you look:

- **Post-processing is not implemented.** There is no TAA, ambient occlusion,
  screen-space reflection or bloom yet, so edges alias and contact shadows are
  missing. The pass library exists under `src/post/`; only the module that
  chains it is absent.
- **Performance.** 60 fps at street level, but 20–30 fps from high altitude at
  1600×900 on the `ultra` tier, where draw calls run to ~2,900. Use `?q=high`.
- **Boston Common renders as paving rather than grass.** The land-cover splat
  works — 10.5 % of the city is green — but pedestrian-area polygons inside the
  Common are classified as plaza and overpaint the park beneath them.
- **Night facades are bright.** Exposure and emissive scaling are now coupled,
  but lit windows still read hotter than they should.

## Controls

| | |
|---|---|
| Drag | Orbit |
| Scroll / pinch | Zoom |
| `W A S D` `Q E` | Fly (hold `Shift` to boost) |
| `H` | Hide the interface |
| `` ` `` | Performance overlay |

Append `?q=low` / `medium` / `high` / `ultra` to the URL to force a quality tier,
or `?ui=off` for a clean capture.

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
