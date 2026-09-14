# Boston 3D — Architecture & Contributor Contract

A real-time, physically-based 3D model of Boston, Massachusetts. Runs in the
browser on WebGL2 via three.js. Geometry is derived from OpenStreetMap (ODbL);
terrain from USGS 3DEP / SRTM via AWS Terrain Tiles.

**Every agent working on this repo must read this file before editing.**

---

## Ground rules

1. **Units are metres. The world is Y-up, right-handed.** `+X` = east, `+Z` =
   south (so north is `-Z`). Sea level is `y = 0`.
2. **Never hand-place geometry in lat/lon at runtime.** Use
   `lonLatToWorld()` from `src/core/geo.ts`, or consume pre-projected data
   from `public/data/`.
3. **`npx tsc --noEmit` must pass** and `npx vite build` must succeed before you
   report done. `strict` is on. No `@ts-ignore` without a one-line reason.
4. **Stay in your lane.** Each module owns its files. Do not edit another
   module's files; if you need something from it, request it through `Ctx`.
5. **Everything must be performant.** Target 60 fps at 1080p on the `high`
   tier. Use `InstancedMesh`/`BatchedMesh`, merge geometry, respect
   `ctx.quality`. A beautiful 12 fps scene is a failure.
6. **No placeholder art in the final result.** No flat-shaded grey boxes, no
   default-material look, no `MeshBasicMaterial` where PBR belongs.

## Module system

Every subsystem implements `WorldModule` (`src/core/Context.ts`):

```ts
export interface WorldModule {
  readonly name: string;
  init?(ctx: Ctx): Promise<void> | void;   // setup, may fetch
  update?(dt: number, ctx: Ctx): void;     // once per frame
  resize?(w: number, h: number, ctx: Ctx): void;
  dispose?(ctx: Ctx): void;
}
```

Modules are registered in `src/main.ts` and **initialise in registration
order**. They communicate only through `Ctx` — never by importing each other's
internals.

### Capabilities published onto `Ctx`

| Field | Published by | Consumed by |
|---|---|---|
| `ctx.textures` (`Map<string, Texture>`) | `Materials` | everything that needs a PBR map |
| `ctx.envMap` | `Sky` | all PBR materials, water |
| `ctx.sun` (direction, colour, intensity, elevation) | `Sky` | lighting, water, windows, post |
| `ctx.sampleHeight(x, z)` | `Terrain` | buildings, roads, props, vegetation, physics |
| `ctx.stats` | anyone | `Hud` |
| `ctx.on/emit` | anyone | cross-module signals |

`ctx.quality` holds the active `QualitySettings`; listen for `'quality-changed'`
to rebuild anything size-dependent.

## Module ownership

| Module | Files (owned exclusively) |
|---|---|
| Materials | `src/materials/**` |
| Sky | `src/sky/**` |
| Terrain | `src/world/Terrain.ts`, `src/world/terrain/**` |
| Water | `src/world/Water.ts`, `src/world/water/**` |
| Roads | `src/world/Roads.ts`, `src/world/roads/**` |
| Buildings | `src/world/Buildings.ts`, `src/world/buildings/**` |
| Landmarks | `src/landmarks/**` |
| Vegetation | `src/world/Vegetation.ts`, `src/world/vegetation/**` |
| Props | `src/world/Props.ts`, `src/world/props/**` |
| Physics | `src/physics/**` |
| CameraRig | `src/controls/**` |
| Post | `src/post/**` |
| Hud | `src/ui/**` |
| Data pipeline | `tools/**`, `public/data/**` |

Shared, **edit only with care and never concurrently**: `src/core/**`,
`src/main.ts`.

## Data

`public/data/` is produced offline by `npm run data` (`tools/build-data.mjs`)
and committed. The schema is `src/core/types.ts` — that file is the contract.
Load through the shared helper in `src/core/data.ts` so caching, sharding and
progress reporting behave consistently.

## Rendering conventions

- Colour management is on: `renderer.outputColorSpace = SRGBColorSpace`,
  ACES Filmic tonemapping. **Author colours in sRGB**, set textures that carry
  colour to `SRGBColorSpace` and data textures (normal/roughness/AO) to
  `NoColorSpace`. Getting this wrong is the single most common cause of a scene
  looking washed out or muddy.
- Lighting is physical: `Sky` owns the sun and IBL. Do not add ad-hoc
  `AmbientLight`s to "brighten things up" — fix the exposure or the material.
- `Post` owns final presentation via `app.renderOverride`. If you need a custom
  pass, coordinate through `Post`, don't call `renderer.render` yourself.

## Visual quality bar

The work is reviewed by an adversarial visual critic against reference photos of
Boston. It is not done until the critic is genuinely impressed. Specifically:

- Silhouettes must read as **Boston** — the Hancock/Prudential pair over Back
  Bay, the Zakim's inverted-Y towers, the gold State House dome, the Custom
  House clock tower, Fenway's light rigs.
- Materials must have real surface response: brick has depth and grout, glass
  has proper Fresnel and reflects the sky, water has moving normals and
  correct reflections, asphalt is not a flat grey plane.
- Scenes must have **depth cues**: aerial perspective, contact shadows/AO,
  varied roofline detail, and no infinite hard-edged ground plane.

---

## Visual QA harness

```bash
node qa/shoot.mjs                     # capture every viewpoint in qa/viewpoints.json
node qa/shoot.mjs skyline-charles     # capture one
node qa/shoot.mjs --tag before        # suffix filenames for A/B comparison
node qa/shoot.mjs --no-build          # reuse the last build
```

Shots land in `qa/shots/*.png` with a `report.json` carrying fps / draw calls /
triangle counts and any console errors. **Exit code 2 means the page threw** —
that is a broken build, not a styling problem. Fix it before judging looks.

Because agents run concurrently, **always set your own port and output dir**:

```bash
QA_PORT=4331 QA_OUTDIR=dist-sky node qa/shoot.mjs skyline-charles
```

The harness drives the scene through `window.__debug` (`src/core/debugApi.ts`):
`setView(pos, target)`, `setTime(hour, dayOfYear?)`, `settle(frames)`,
`stats()`, `setQuality(tier)`. Keep that API working — the whole review loop
depends on it.

---

## Landmarks vs Buildings: who draws what

**Landmarks owns placement. Buildings owns suppression.**

`src/landmarks/registry.ts` exports `LANDMARKS`, `findLandmark(slug)` (which
resolves `absorbs` aliases too) and `landmarkSlugs()`. The `Landmarks` module
instantiates and positions every one of them and publishes the suppression set
as `ctx.landmarkSlugs` (a `Set<string>`) plus a `'landmark-slugs'` event.

`Buildings` must **skip its generic extrusion** for any `BuildingRecord` whose
`landmark` slug is in that set — and must **not** instantiate the registry mesh
itself. If both modules place it, the model is drawn twice and z-fights against
itself.
