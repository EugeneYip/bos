# The pale, sun-independent surfaces at Logan and in the harbour

Working notes, written as the work happens so it survives an interruption.
Everything here is under `qa/`; source edits are called out explicitly.

## Harness

Build: `VITE_BASE=/ npx vite build --outDir dist-loganfix --emptyOutDir` (exit 0).
Probe: `qa/logan/_ablate.mjs`, `qa/logan/_lights.mjs`. Port 4633+, `QA_OUTDIR=dist-loganfix`,
nonce guard on `qa-build-id.txt` so a stale server cannot be mistaken for a result, and an
explicit post-`__ready` assertion that `window.__debug`/`window.__boston` exist rather than
trusting the timeout.

`[diag] tier=high mobile=false safeLevel=0 pixelRatio=1 envBound=true environmentIntensity=1
gpu=ANGLE (Apple, ANGLE Metal Renderer: Apple M2)`.

**Ablation is by `Object3D.layers`, not `visible`.** `__debug.toggle` writes `visible` and
AirTraffic/CDLOD/the water reflection pass rewrite it every frame; nothing in `src/` ever
writes bit 0 of `layers` (`Post` only touches the SSR layer). `o.traverse(c =>
c.layers.disable(0))` is therefore a hide that cannot be silently undone — three's
`projectObject` skips the object *and* skips lights whose layers do not intersect the camera's.

## Reproduced the critic's numbers exactly

`logan-taxi-wide`, hour 23, tier high, `exposure 2.2316`, `sunIntensity 0.0000`,
`sunElevation -0.7215`:

| box | rgb | luma |
|---|---|---|
| paleA 855,455,45,18 | 91.8 / 76.8 / 64.2 | **79.1** |
| paleB 350,455,25,18 | 58.5 / 48.9 / 40.7 | 50.3 |
| darkA 430,455,45,18 | 4.2 / 2.9 / 1.9 | **3.1** |
| sky 800,20,300,40 | 69.5 / 55.8 / 44.7 | 57.9 |

Same 25x, same sun-independence. Shot: `qa/logan/shots/logan-taxi-wide--h23-scan.png`.

## What the frame actually shows (this reframes the defect)

`qa/logan/shots/crop-paleA.png` (700,380 320x180 @3x). The **black** shapes are the
polygons — runways, taxiways, aprons, hard-edged, correctly shaped. The **pale** surface is
the *field between and underneath them*, dead flat with only dither noise on it.

So "pale strips across the airfield" is backwards: the airfield's *ground* is the pale thing
and the pavement is the near-black thing lying on it.

## Root-child ablation, hour 23 — one candidate survives

`node qa/logan/_ablate.mjs --view logan-taxi-wide --hour 23 --mode roots`.
Scene has 13 root children. Base `paleA 78.7 / paleB 50.0 / darkA 3.10 / sky 57.8`.
Deltas on hiding each sub-tree:

| hidden | d paleA | d paleB | d darkA | d sky |
|---|---|---|---|---|
| **sky** | **-78.0** (78.7 -> **0.67**) | -49.8 | -1.4 | -57.6 |
| terrain | -0.2 | +0.2 | 0.0 | -0.1 |
| far-terrain | -0.2 | 0.0 | 0.0 | -0.4 |
| water | +0.1 | +0.3 | 0.0 | +0.1 |
| parks | -3.8 | -3.3 | -0.2 | -3.6 |
| roads | +0.1 | +0.1 | +0.1 | 0.0 |
| landmarks | +0.5 | +0.6 | 0.0 | +0.3 |
| buildings | +0.4 | +0.6 | 0.0 | +0.4 |
| vegetation | -0.2 | -0.1 | 0.0 | -0.2 |
| props | +0.1 | 0.0 | 0.0 | 0.0 |
| props:flags | +0.3 | +0.3 | +0.1 | +0.1 |
| **traffic** | -8.8 | -7.7 | **+44.2** (3.10 -> **47.3**) | -8.1 |
| transit | +0.2 | +0.2 | 0.0 | 0.0 |

Read-outs:

1. **`darkA` is the airport pavement.** The airport's meshes are not a root group: they are
   added to the *Traffic* module's root by `src/world/traffic/aircraft.ts:buildAirport()`
   (`root.add(m)` for `buildPavement`/`buildMarkings`/`buildLights`/jet bridges). Hiding
   `traffic` lifts darkA from 3.10 to 47.3 — i.e. the surface *behind* the black pavement is
   itself in the pale family (paleB is 50.0).
2. **`paleA` is extinguished only by hiding the `sky` sub-tree**, 78.7 -> 0.67, a 117x
   collapse, while every other sub-tree moves it by <= 0.6 (the -3.8 on parks and -8.8 on
   traffic are auto-exposure feedback: they move `sky` by the same proportion).
3. `parks` and `traffic` moving `paleA` and `sky` together, in proportion, is the signature
   of the exposure loop, not of the surface. Any single-box claim in this defect has to be
   quoted against the `sky` box in the same frame.

Note for the record: this run also logged `[Roads] init failed TypeError: Cannot read
properties of undefined (reading 'length')` — a concurrent agent's in-flight breakage in
`src/world/roads/*`, not mine and not related (the pale field predates it and the `roads`
ablation is null).

## Where that leaves the hypothesis set

Hiding `sky` removes both the sky dome geometry *and* any light parented under it (three skips
lights by layer too), but it does **not** touch `scene.environment`, which stays bound. So a
surface lit purely by the IBL would have survived it. `paleA` did not. Two live candidates:

- **H1 — the pale field *is* the sky dome**, seen where the world has no geometry at all. The
  dome's lower hemisphere carries a synthetic ~0.22-albedo ground term (documented in
  `src/sky/SceneShading.ts`: "its bottom rows are a 0.22-albedo ground term meant for the
  dome"). That is flat, sun-independent, and brighter than the sky above it.
  This also explains `__debug.pick` returning `[]`: `pick` sets `ray.far = 40000`, so a dome
  larger than 40 km is out of range and the raycast reports nothing. No geometry, no hit.
- **H2 — a light under the `sky` sub-tree is the only thing lighting it**, and the 25x against
  the pavement beside it is then an albedo ratio (concrete ~0.4 linear vs asphalt ~0.016 is
  about 25x, which fits uncomfortably well).

`qa/logan/_lights.mjs` separates them: it enumerates every light and every mesh under `sky`,
ablates each individually, nulls `scene.environment`, zeroes `uApLampStrength` and
`uApInscatterGain`, and finally tints every material under `sky` magenta.

## Eliminated so far, with the evidence

- **`scene.environmentIntensity`** is never written in `src/` and reads back as `1`
  (`__debug.diag()`). The global-ambient-gain story is dead.
- **The IBL is bound** (`envBound: true`, `envSize [384,512]`, `envMapping 306` = CubeUV).
- **Terrain, far-terrain, water, parks, roads, landmarks, buildings, vegetation, props, flags
  and transit** are all eliminated for `paleA` by layer-ablation — the strongest form of the
  test available, and immune to the `visible`-rewrite trap that defeated `__debug.toggle`.
- **The airport's own pavement is the *dark* side**, confirmed positively for the first time:
  hiding `traffic` takes darkA 3.1 -> 47.3.

---

# ATTRIBUTED. The pale surface is the sky dome, seen through holes in the ground.

## 1. It is the `sky-dome` mesh, proven five ways (all at hour 23, `sunIntensity = 0.000`)

`node qa/logan/_dome.mjs` — one boot, `logan-taxi-wide`, boxes as above.
Shots in `qa/logan/shots/logan-taxi-wide--h23-dome-*.png`.

| test | paleA | verdict |
|---|---|---|
| BASE | 78.3 [91/76/63] | — |
| hide **`sky-dome`** alone (layers) | **0.6 [1/1/1]** | **it is the dome** |
| hide `sky-dome` + `terrain` | 0.6 [1/1/1] | terrain adds nothing |
| hide `terrain` alone | 78.1 [91/76/63] | terrain is not it |
| `__terrain.setDebug(1)` LOD palette | 77.3 | terrain is not there to recolour |
| `__terrain.setDebug(2)` splat weights | 77.4 | same |
| `__terrain.setWireframe(true)` | 78.4 | same |
| terrain `material.color` -> magenta | 78.9 **[92/77/64]**, not magenta | terrain eliminated by its own colour |
| all three cascade `DirectionalLight`s -> `intensity = 0` | 78.7 | not the sun |
| **`scene.environment = null`** | 78.6 | **not the IBL either** |

A surface that survives having every light zeroed *and* the IBL unbound is not a lit surface.

Corollaries worth keeping:
- The terrain material is indeed `MeshStandardMaterial name='' envMap=false envMapIntensity=1
  fog=true` — unnamed, as the critic found, and it *does* sit in three's
  `envMapIntensity <- scene.environmentIntensity` trap. But `scene.environmentIntensity` is 1,
  so that trap is a no-op here. Not this bug.
- `__terrain.setDebug(n)` **works** at runtime. The claim that it no-ops is wrong: `Terrain.init`
  assigns `this.uniforms` before it calls `readUrlOverrides()`, so `?tdebug=N` works too.

## 2. Why `__debug.pick` returns `[]` on these pixels — and why that is not terrain

`src/sky/Sky.ts:255-265`: the dome is **a clip-space full-screen triangle**, positions
`(-1,-1,0) (3,-1,0) (-1,3,0)`, with `depthTest: false`, `depthWrite: false`,
`renderOrder: -10000` and a 1e9 bounding sphere. So

- it paints **every pixel no geometry covers**, and
- a `Raycaster` can never hit it: its object-space geometry is a 4-unit triangle at the origin.

`__debug.pick` also clamps `ray.far = 40000`. Re-ran the raycast with `far = Infinity` and it
still returns `[]` at the pale pixel, while the dark pixel returns
`airport:pavement:apron d=666` + `water:skirt d=681`.

**So in this codebase `pick` returning `[]` means "nothing is drawn here, you are looking at
the sky dome". It has been read as "CDLOD terrain" for three sessions. It is the opposite.**

## 3. The "lighting term": `uHorizonHold` in the dome shader, not a light at all

`src/sky/shaders/skyDome.ts:158` in `skyRadiance()`:

    lutUv.y = mix( lutUv.y, max( lutUv.y, 0.5 ), uHorizonHold );

On screen `uHorizonHold = 1`, so **every below-horizon ray is clamped to the tangent row of the
sky-view LUT** (deliberately — the comment explains it stops a dark stripe under a sunset,
since the modelled ground only reaches 23 km). Looking *down* therefore returns horizon
radiance, and the horizon is the brightest row of the sky:

- the airglow band is `exp(-h * 5.5)` and the urban skyglow `exp(-h * 7.0) * 0.82 + exp(-h * 2.2) * 0.18`
  (`src/sky/shaders/skyDome.ts`), both maximal at `h = 0`;
- so a downward ray is always brighter than a ray toward the upper sky in the same frame, and the
  ratio *widens* after dark as skyglow and airglow take over from the sun.

That is the whole measured signature, exactly:

| signature | mechanism |
|---|---|
| sun-independent | the LUT's horizon row at night is airglow + urban skyglow, not sun |
| brighter than the sky in the same frame, 1.06-1.37x (Logan), 1.12-2.82x (harbour) | the held row is the *horizon*; the "sky" box is higher up and darker |
| dead flat, sd 1.4-1.6 | one LUT row, varying only with azimuth |
| immune to every material and uniform override | there is no material there |
| `pick` returns `[]` | there is no geometry there |
| two distinct gains (paleA 78.9 / paleB 50.4) | two different azimuths/depression angles of the same held row |

"Ambient/sky term with gain above 1 and no sun term" is precisely right — and the reason nobody
could find the surface it was lighting is that it is not lighting a surface. It **is** the sky.

## 4. Root cause of the holes: `Quadtree.descend` indexes children that are not there

`src/world/terrain/cdlod.ts`. The tree is built **depth-first**:

    const c0 = build(nx, nz, hs, lvl - 1);   // allocates child 0 AND ITS WHOLE SUBTREE
    build(nx + hs, nz, hs, lvl - 1);         // child 1 lands at c0 + sizeof(subtree 0)
    build(nx, nz + hs, hs, lvl - 1);
    build(nx + hs, nz + hs, hs, lvl - 1);
    this.child[idx] = c0;

but selection walks them as if they were contiguous:

    const c = this.child[idx];
    this.descend(c, k); this.descend(c + 1, k); this.descend(c + 2, k); this.descend(c + 3, k);

`c + 1 … c + 3` are only the siblings when child 0 is a leaf, i.e. one level above the leaves.
At every coarser level `c + 1 … c + 3` are **child 0's own children**, and children 1, 2 and 3 —
three quarters of the quadtree, with their entire subtrees — are never visited.

### The measurement that proves it

`qa/logan/_dome.mjs` reads the live instance buffer (`terrain.geometry.attributes.iChunk`):

- `instanceCount = 59` for a 1600x900 frame at tier high. The selector's budget is 6144.
- Every selected chunk has `originZ >= 0`; extent `x [-16384, 8192]`, `z [0, 12288]` — while the
  heightfield spans `x [-5479, 4902]`, `z [-4510, 4154]` and the camera is at `z = -700`. The
  whole northern half of the world contributed nothing.
- Nearest selected chunk: **730 m** from the camera. The near field is empty.
- Marching the view ray at each measured box against `ctx.sampleHeight`: the ground under
  `paleA` is at `(4211.8, 5.23, -237.7)`, under `paleB` `(4510.8, 5.29, -57.9)`, under `darkA`
  `(4458.5, 5.13, -89.4)` — and **no selected chunk covers any of them** (`cover: []` for all
  three). There is heightfield data at all three points; there is simply no chunk drawing it.
- `__terrain.setDebug(1)` confirms it visually: the LOD palette appears only as a thin band at
  the horizon (`qa/logan/shots/logan-taxi-wide--h23-dome-tdebug1.png`); the entire airfield stays
  black-and-pale, i.e. pavement over bare dome.

Selected-chunk counts and the nearest chunk, over seven poses (`qa/logan/_cover.mjs`):

| pose | chunks | nearest chunk |
|---|---|---|
| logan-taxi-wide | 59 | 0.73 km |
| dusk-harbour | 38 | 2.6 km |
| common-street | 95 | 0.12 km |
| aerial-city | 50 | 2.27 km |
| boot-default | 32 | 2.83 km |

## 5. Yes — this is ONE bug for Logan and the harbour

`dusk-harbour` selects 38 chunks with the nearest at 2.6 km, so everything inside 2.6 km of that
camera is hole. The critic's harbour patches are "hard-edged near-white quadrilaterals with
straight axis-aligned edges lying on the harbour surface" — axis-aligned quads are exactly the
shape of missing CDLOD chunks, and the water only covers the parts of the harbour the water
module actually meshes. Same dome, same held horizon row, same `pick` returning `[]`, same
immunity to `park:grass` / `park:sand` / `wake` / foam-gain / terrain-wireframe overrides.
So one fix should close both, and it is the same fix that closes `boot-default`'s pale ground
patches. To be confirmed by measurement after the fix, not assumed.

Note on scale: this is not a Logan defect. The terrain has been rendering 32-95 chunks
(65k-200k triangles) instead of the hundreds its own budget allows, everywhere, for a long time.
Wherever Parks/Roads/Buildings happen to cover the ground the hole is invisible; wherever they
do not — an airfield, a harbour, an aerial view — the sky dome shows through.

## 6. Also seen while measuring (not mine to fix, recorded for whoever owns it)

- At hour 23 the whole of East Boston and the water beyond reads as a flat tan/khaki sheet at
  ~233 luma in the brightest 16x16 blocks. `uApLampColor` is `(1.0, 0.89, 0.76)` and
  `skyStreetLight` is added straight into `irradiance` for every material in the city
  (`src/sky/SceneShading.ts`). Worth a separate look at `LAMP_IRRADIANCE`.
- `[Roads] init failed TypeError: Cannot read properties of undefined (reading 'length')` in
  every boot of this build — a concurrent agent's in-flight edit under `src/world/roads/`.
