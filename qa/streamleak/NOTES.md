# Retained geometry never falls on a moving camera

Status: **measured, not yet attributed to a module.** Written down because the
attribution run needs the machine to itself and five agents currently have it.

## Why this matters

This, not the boot peak, is the best current explanation for the user's actual
report: on both iPhone and iPad "the entered view only lasted a few seconds,
then returned to the loading screen cycle". A boot-peak kill would never show
the view at all. A footprint that climbs while you look around shows the city,
then dies — which is what they describe.

## Measurement

`qa/_footprint.mjs`, iPhone viewport 393x852, `?safe=1`, mobile code path
asserted via `diag().mobile === true`. Sums the three things iOS counts and
`performance.memory` does not: JS heap, render targets, and GPU-resident
vertex/index data (`count * itemSize * bytesPerElement`, which survives
`releaseStaticAttributes` nulling the CPU copy).

Camera flies a 1200 m circle, 1.3 full turns, so it returns past its own
start and everything loaded on the far side is far out of range by the end.

| | start | after 45 s flight |
|---|---|---|
| JS heap | 835 MB | 936 MB |
| render targets | 15 MB | 15 MB |
| GPU geometry | 149 MB | **250 MB** |
| geometries resident | 369 | **787** |
| triangles | 1.86 M | 2.82 M |
| **total** | 998 MB | **1201 MB** |

Then the camera is held **completely stationary** for 20 s:

| | still+5s | still+10s | still+20s |
|---|---|---|---|
| geometries | 787 | 787 | **787** |
| GPU geometry | 250 MB | 250 MB | **250 MB** |

**Nothing is ever reclaimed.** So this is not eviction lagging the camera,
which was the benign possibility — it is not reclaiming at all. The heap
figure oscillates (863 / 1169 / 831) because that is GC churn; the geometry
figures are flat, and they are the ones that do not depend on when the
collector happens to run.

Second, separate observation: the heap sawtooths
`556, 567, 564, 684, 593, 957, 632, 929, 609, 932` across the flight —
roughly 300 MB of transient allocated and freed per camera move. Even with
eviction fixed, that transient is on the wrong side of a phone's ceiling.

## What is NOT the cause

- `Buildings.unloadShard()` is correct: removes from the root, calls
  `geometry.dispose()`, splices the tile out, drops the shard id.
- `Buildings.reconcile()` looks correct: `keep` is `radius + STREAM_HYSTERESIS`
  and anything outside it is unloaded.
- `Buildings.streaming` is `MOBILE && shardBounds.length === shardUrls.length`,
  and it was active in these runs — the boot log prints
  `[Buildings] streaming: 18 of 61 shards within 1600 m`.

So buildings are probably not the leak, or not all of it.

## Eliminated by inspection (no machine needed)

- **CDLOD terrain.** `Terrain.dispose` frees `this.geometry` — singular. This
  implementation draws ONE grid patch many times with different uniforms,
  which is the standard CDLOD arrangement, so it creates no per-tile
  geometries at all. It was my first suspect and it is wrong.
- **Roads.** `evict(map, budget)` removes the group from its parent AND calls
  `disposeGroup(g)`, and it is budget-bounded per tier (`BASE_BUDGET`,
  `DETAIL_BUDGET`, `MICRO_BUDGET`). Correct.
- **Water.** Chunks are built once in `init` from the OSM rings; there is no
  streaming path, so the set is fixed and cannot grow.

## Where to look next

`geometries` is a renderer-wide count, and at `?safe=1` Vegetation, Props and
Traffic are all still registered (only level 2 drops them). Candidates, in
order:

With terrain, roads and water cleared above, what is left is:

1. **Buildings.** `reconcile` and `unloadShard` both read correctly, but each
   shard assembles into MANY tile meshes (18 shards produced 142 tiles at
   boot), and the tile count is what grows. Worth checking that `unloadShard`
   is reached at all on this camera path: `reconcile` only runs when
   `streamCountdown` has expired AND the camera has moved 150 m, and the
   keep-radius at safe 1 is `0.65 * 1600 + 700 = 1740 m` against a flight that
   puts the far side of the circle 2400 m away. It should evict. Verify rather
   than assume — that pair of conditions is the only place a correct-looking
   `unloadShard` never gets called.
2. **Traffic**, present at safe 1, with 28,517 lane edges and vehicles in
   instanced meshes.
3. **Vegetation and Props**, present at safe 1; both build instanced meshes
   once rather than streaming, so they are a weaker fit for growth over time.

Do not guess between these — `_retainwho.mjs` names the module in one run.

`qa/_retainwho.mjs` is written and ready: it groups resident geometry by the
mesh-name prefix before the first `:` (this repo's convention — `buildings:`,
`water:chunk`, `roads:`) at boot, after the flight, and 15 s after returning
to the opening pose. **It has not produced a number yet** — Chrome failed to
launch under contention. Run it when the machine is free:

    QA_PORT=4418 QA_OUTDIR=dist-fp node qa/_retainwho.mjs

## Harness warning

Both probes assert the page actually booted and fail loudly if the build was
made without `VITE_BASE=/`. A build made without it references
`/bos/assets/...`, every asset 404s, and the page sits on the boot overlay
forever — which is indistinguishable from a real boot hang, and burned two
runs today before the guard existed. Build with:

    VITE_BASE=/ npx vite build --outDir dist-fp --emptyOutDir

Also: measurements taken while other agents are building are worthless. A
concurrent ultra run produced a phantom 2.4x fps regression that fell
uniformly across viewpoints with no pedestrians in them, which no pedestrian
shader can do.

## Attributed (qa/_retainwho.mjs, iPhone viewport, safe=1)

Resident geometry grouped by mesh-name prefix. Flight is a 1200 m circle,
1.3 turns, then parked back at the opening pose for 15 s.

| group | boot | after flight | back at start +15s |
|---|---|---|---|
| **buildings** | 37 / 29.5 MB | 89 / 56.5 MB | **93 / 70.7 MB** |
| **road-t1** | 48 / 7.1 MB | 222 / 38.4 MB | 222 / 38.4 MB |
| road-t0 | 75 / 13.2 MB | 99 / 18.6 MB | 99 / 18.6 MB |
| road-t2 | 23 / 7.3 MB | 56 / 14.2 MB | 56 / 14.2 MB |
| parks | 2 / 20.2 MB | unchanged | unchanged |
| water | 130 / 9.9 MB | 130 / 10.8 MB | 130 / 10.8 MB |
| **total geometries** | **866** | **1149** | **1153** |

**Buildings is the defect.** It more than doubles, and it is still climbing on
the last sample -- 89 -> 93 meshes and 56.5 -> 70.7 MB while parked back at the
opening pose, where most of what it holds is far outside the keep radius of
`0.65 * 1600 + 700 = 1740 m` against a far side 2400 m away. Nothing is ever
given back.

**Correction to the section above.** I had cleared Roads by reading `evict`,
and that was too strong. The road tiers do grow -- t1 by 4.6x, t0 by 1.3x,
t2 by 2.4x -- and then sit on a plateau. A plateau is what hitting a per-tier
budget looks like, so `evict` is probably working as written and the bound is
simply high: 377 geometries and 71.2 MB across the three tiers. Bounded but
expensive is a different problem from leaking, and worth revisiting on its own
terms once buildings is fixed. Terrain and water are still cleanly cleared:
terrain draws one grid patch many times, and water's 130 chunks do not move.

Next step: `qa/_shardtrace.mjs` reads `Buildings`' own private state
(`streaming`, `radius`, `loadedShards`, `loadingShards`, `streamCountdown`)
plus `stats.buildingShards`/`buildingTiles` at each step of the same flight.
`reconcile` is gated on TWO conditions at the call site -- a 30-frame
countdown AND the camera having moved 150 m from `lastStreamAt` -- and that
pair is the one place correct-looking eviction code silently never fires.
