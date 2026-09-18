# Road-pipeline boot heap

Goal: the +218 MB transient that `src/world/Roads.ts` + `src/world/roads/*`
adds to the JS heap during module init (348 -> 566 MB), down to under 80 MB,
with the rendered output unchanged.

## How it is measured

`qa/_peakwho.mjs` samples `usedJSHeapSize` every 150 ms. The whole topology
pass is 362 ms, so a sampled curve can name the module but never the step. It
also could not be trusted today: several agents were shooting at once and the
machine sat at a load average of 263, which timed the probe out at 300 s
twice.

So the attribution is done in Node instead -- `qa/_roadnet.mjs`, which runs
the real `buildNetwork` and the real chunk loop on the real shards under the
same V8, with `--expose-gc` so retained and transient can be told apart. It
needs `qa/roadmem/entry.ts` bundled first (esbuild, three external) because
the source uses extensionless imports that Node's ESM resolver will not take.

Counts come out identical to the browser -- 32,849 ways, 11,630 junctions,
36,755 chunks -- and so does the heap: **195.8 MB raw growth across
`buildNetwork` plus ~30 MB across the chunk loop = ~226 MB**, against the
+218 MB measured in the browser. Close enough that the Node harness is a
faithful stand-in, and it has zero run-to-run spread on the total.

## Baseline (before any change)

```
records        56655            raw 33.5 MB   retained 22.6 MB
[RoadMem]  30.3 MB   +0.0   net.enter      56655 records
[RoadMem]  85.2 MB  +54.8   net.prepare    56655 prepared
[RoadMem] 104.0 MB  +18.8   net.degree     146120 verts
[RoadMem] 106.3 MB   +2.4   net.split      66147 parts
[RoadMem] 133.2 MB  +26.9   net.weld       54099 welded
[RoadMem] 143.9 MB  +10.7   net.dupes      21250 dropped
[RoadMem] 155.6 MB  +11.7   net.nodes      36938 nodes
[RoadMem] 217.5 MB  +61.9   net.junctions  11630 junctions
[RoadMem] 223.1 MB   +5.6   net.trims
[RoadMem] 226.0 MB   +2.9   net.portals    447 portals
buildNetwork  raw after 195.8 MB      bucket raw after ~30 MB
converged retained, everything alive:  50.0 MB
```

The *total* (195.8) is reproducible to the decimal across runs. The *per-step*
split is not: a second run charged weld 21.1 and nodes 27.9 and junctions
53.7, because a scavenge landing inside one step charges its garbage to the
next. Treat any single step as +/- 10 MB and the ordering as the finding.

## What the numbers already rule out

- **Holding the parsed `RoadRecord`s.** They are 22.6 MB retained, 33.5 MB
  raw. Dropping them early is worth at most 23 MB, not 218. (Worth doing, but
  it is not the answer, and the hint that it might be is wrong.)
- **The chunk objects being the bulk.** 36,755 `Item`+`Chunk` pairs cost
  ~30 MB of the 226, not the majority. A struct-of-arrays rewrite of them is
  capped at that, so it is the *last* thing to try, not the first.
- **Transient garbage dying young.** It does not: the pass keeps ~27 MB and
  grows the heap 196 MB, so ~170 MB is being *promoted* into old space and
  then sits there dead until a major GC. That is exactly why the peak is what
  kills the tab while the settled figure looks fine.

## Where it actually goes

Two steps dominate, and they dominate for the same reason:

1. `prepare` ~55 MB -- four generations of `{x,z}` arrays per record
   (`decode` -> `dedupe` -> `simplify` -> `smoothProfile`), run over all
   56,655 records including the 21,250 sidewalk duplicates that are thrown
   away two steps later.
2. `junctions` ~55-62 MB -- 11,630 junctions each retaining a ring, two
   parallel elevation arrays and one `Corner` per approach pair with its own
   `pts`/`ys`/`normals`, plus a `cumulative()` array allocated per approach.

Then a band of string-keyed maps: `degree` (~19 MB, 146,120 keys),
`weldChains`' `ends` (~25 MB, 132k keys plus a `slice()` of every road's
points whether or not anything welds) and `nodes` (~12-28 MB). All three key
on `` `${Math.round(p.x*2)}|${Math.round(p.z*2)}|${layer}` `` -- a fresh
string per vertex, built again on every lookup.

## RE-MEASUREMENT of the packed-integer node key (the predecessor's change)

Their estimate was ~55 MB. **It is worth ~10 MB.** Four runs of
`node --expose-gc qa/_roadnet.mjs`, `buildNetwork` raw growth:

```
HEAD (packed int key)   184.0   189.0   mean 186.5
BASE (template string)  199.7   194.0   mean 196.9
```

Spread is +/-3 MB per side, so the delta is 10 MB +/- 6. Retained is 87.8 MB
in both, identically -- the maps are released either way, so the change only
ever moved transient.

Why the estimate was ten times too high: the keys are short. A key like
`"12345|-6789|0"` is a 13-char SeqOneByteString = 32 bytes with header, so the
146,120 retained `degree` keys are 4.7 MB, not 19. The 19 MB the predecessor
charged to `net.degree` was mostly the `Map` itself -- its OrderedHashMap
backing store plus the garbage from doubling it up to capacity -- and that
cost is unchanged by making the keys SMIs.

**Verdict: keep it.** It is 10 MB, free, and shard digests are identical. But
it is 5% of the job, not 25%, and the remaining ~204 MB is elsewhere.

## Where the 214 MB actually is: small-object and small-array churn

The decisive number is the average way length: 199,413 source vertices across
56,655 records is **3.5 vertices per record**. Nothing here is bulk data. The
pipeline allocates roughly ten arrays and a handful of objects *per record*,
and at 3.5 elements an array costs ~48-64 bytes of header and backing store
regardless of what it holds -- so the per-allocation overhead is the payload.
Push-built arrays make it worse: growing 0 -> 4 -> 8 -> 16 abandons every
earlier backing store.

That is why the settled heap looks fine while the peak kills the tab. It is
not one big retained structure; it is millions of tiny short-lived ones, and
V8 promotes the ones a scavenge happens to catch.

## Change 1: junction ring + kerb returns derived on demand (-55 MB)

`Junction` no longer stores `ring`/`ringDy`/`ringY`/`corners`. `buildJunction`
keeps only the topology -- the angle-sorted approaches with their settled
`trim` and `y`, plus `radius`, `maxWidth` and a new `maxR` -- and
`junctionGeom(j)` derives the ring and the kerb returns from that, purely,
when a tile build asks for them.

Why it is safe: the only two readers were `emitJunctionFill` (ring) and
`emitKerbReturns` (corners), both inside the per-tile emit loop.
`emitCrossings` never read either -- it works off `approaches` and `a.trim`.
So nothing outside a tile build ever wanted this geometry, and at boot six of
ninety-three base tiles are built.

Also dropped `cumulative(a.road.pts)`, which was allocated per approach
(36,938 throwaway arrays) purely to be indexed twice inside `elevationAt`.
The replacement keeps a running sum over the same segments in the same order,
so the partial sums are bit-identical.

The old `if (ring.length < 3) return null` was unreachable: the ring gets two
vertices per approach before any corner is walked, and the call site already
guarantees two approaches. It is now `if (n < 2) return null`, asked up front.

```
                     buildNetwork raw   retained   pipeline raw
before (int key)     186.5              87.8       214.0
after                131.6              34.1       158.1        (3 runs)
digest               e81954be  <- unchanged
counts               32849 / 11630 / 447 / 36755  <- unchanged
```

Note the retained figure: 54 MB of that geometry was not merely transient, it
was held for the whole session.

## The endpoint metric stopped being a peak metric -- use `qa/_roadpeak.mjs`

`qa/_roadnet.mjs` reports `heapUsed` at the end of a phase minus `heapUsed` at
its start. That was faithful while the pass allocated faster than V8 could
collect -- the predecessor's 195.8 MB was reproducible to the decimal. Once
the allocation came down it stopped being faithful, because a major GC can now
land *inside* the pass, reclaim ~50 MB, and leave the endpoint below the real
high-water mark. Five consecutive runs of one identical build:

```
49.6   101.8   101.9   109.7   49.6      <- bimodal, 2x
```

Nothing changed between those runs except which collections fired.

`qa/_roadpeak.mjs` measures the peak instead, from V8's own `--trace-gc`:
every collection prints the heap immediately before it, V8 collects when it
hits its allocation limit, so the largest pre-GC figure in the trace *is* the
high-water mark. Spread drops to under 2%:

```
head  140.4  139.6  141.2      base  224.7  225.9  223.1
```

Baseline with the shards parsed and settled is 23.6 MB, so the road pipeline's
own contribution to the peak is **203 MB -> 117 MB**.

## Change 2: the prepare pass works in scratch rows (-36 MB)

`decode -> dedupe -> simplify -> smoothProfile` handed each other fresh
arrays: four generations of `{x,z}[]` and `number[]` per record, plus a
`Uint8Array` and an array-of-tuples stack inside the RDP. Every stage now
works in place on reusable `Float64Array` rows and only the surviving polyline
is materialised, once, at its exact length.

The reason this is worth so much is the 3.5-vertex average. The coordinates
were never the cost; ten allocation headers per record, half a million of
them, were.

Care taken to keep it bit-identical: `Float64Array` not `Float32Array`; the
RDP interval stack pops in the same order the tuple array did, because RDP's
tie-break is first-maximum-wins; `smoothProfile` stays Jacobi (two rows, not
one) because it reads the previous pass; the bridge lift still compares
against the *unlifted* profile while writing the lifted one.

## Change 3: weldChains stops copying roads that do not weld (-9 MB)

Every road got `pts.slice()` and `ys.slice()` up front and a `{...seed}`
spread on the way out. Only 12,048 of 66,147 actually weld. The opening slice
was pure waste even when they do -- every branch that extends a chain
`concat`s, which copies on its own. A road that welds to nothing is now passed
straight through: `length` is already `polylineLength(pts)` over the same
points, so the spread was rebuilding an identical object.

Also: the endpoint index held a `{r, end}` object and an `Array` per node for
132,294 ends; it now packs `roadIndex * 2 + end` into two flat maps, because
the algorithm only ever acts on a node with exactly two ends. Both
`for (const end of [0, 1] as const)` loops were allocating their literal once
per road, and the candidate search a closure per probe.

## Change 4: chunkPolyline fast path (-10 MB on that phase, -6.5 MB retained,
## but only ~2 MB on the peak)

Nearly every way is shorter than one 165 m chunk, and the general path was
rebuilding both arrays a vertex at a time through `push`. The fast path
returns the input arrays as the chunk's arrays. It also appends into a
caller-owned array instead of returning a fresh `Chunk[]` per road (32,849
arrays averaging 1.12 entries).

Recorded honestly: this barely moves the *peak*, because the peak is set
inside `buildNetwork` and the chunk loop runs after it. It is kept for the
6.5 MB it takes off the settled footprint, which is the figure that matters
for a device dying during flight rather than at boot.

Two things disqualify the fast path, because the general path would not
reproduce the input: a zero-length segment, which it drops, and a short `ys`,
whose missing entries it reads as 0. Note the digest cannot catch the second
of those -- it folds `undefined` to 0 -- so it is an explicit guard.

## NEGATIVE RESULT: scalarising cornerHit bought nothing. Reverted.

`cornerHit` calls `perp`, `scale`, `add`, `sub` and `rayIntersect`, each
returning a fresh `{x,z}` -- eight objects per corner, ~35,000 corners, walked
again on every tile that draws them. Predicted ~11 MB. Hand-scalarised into
pure arithmetic with out-parameters, digest still `e81954be`, peak moved
**139.4 -> 140.6 MB**, i.e. not at all.

The reason is worth keeping: none of those temporaries escape the call, so
TurboFan had already elided them. **The allocations that cost on this path are
the ones that escape** -- what `junctionGeom` pushes into its ring and
normals, what the topology maps retain. Reverted, and the finding is recorded
in a comment at the function so the next person does not spend the afternoon
on it. Do not bother scalarising any other non-escaping vector temporary here.

## Where the remaining 117 MB is

Per-phase peak, from an instrumented build whose markers share fd 1 with
`--trace-gc` (they must be written with `fs.writeSync`, or the two streams
arrive in separate blocks and every collection is charged to the last phase):

```
phase                peak    climb
load                 35.1
1  prepare           71.0    +35.9
2/3 degree + split   93.1    +22.1
4  weld             101.8     +8.7
4b dupes            114.7    +12.9
5  nodes            126.1    +11.4
6  junctions        139.0    +12.9
8  portals          139.8     +0.8   <- overall peak
   (chunk loop)      85.7
```

The profile is now flat, which is the point: there is no single remaining
target worth 40 MB. Of the 117 MB, ~34 MB is genuinely retained (the prepared
ways and the junction topology), leaving ~83 MB of transient spread across six
phases at 9-36 MB each.

The honest next steps, in order of size:
- **prepare, +36 MB.** What is left is the materialised output itself: 199,413
  `{x,z}` objects plus their arrays. Only a flat `Float64Array` + offset
  representation for `PreparedRoad.pts` removes it, and that changes the type
  every consumer in `roads/*` reads. Biggest remaining win, biggest blast
  radius.
- **degree + split, +22 MB.** The `degree` map is 146,120 entries; a V8 `Map`
  costs three slots an entry plus the garbage from doubling its way up. An
  open-addressed table over `Int32Array` would be ~5 MB cheaper and produce no
  rehash garbage.
- **dupes, +13 MB.** `markSidewalkDuplicates` push-grows a `number[]` of five
  numbers per segment and keeps a `Map<number, number[]>` with one array per
  48 m cell. A two-pass CSR over typed arrays removes both.
- **junctions, +13 MB** and **nodes, +11 MB** are ~60,000 `Approach` objects
  with their `dir`, and 36,938 arrays holding them. These escape, so unlike
  `cornerHit` they are real.

## Aside: the road tiers on mobile (not measured by me, not changed)

The coordinator measured 377 geometries / 71.2 MB resident across t0/t1/t2 on
a phone, growing then plateauing under the per-tier budgets. That is the
budget working, not a leak. `DETAIL_BUDGET = 70` and `MICRO_BUDGET = 26` are
not mobile-scaled the way `BASE_BUDGET = 16` is, and `DETAIL_RANGE` is 720 m
against a 1600 m base range -- so the detail tier can hold 70 live tiles of
kerbs, pavements and markings that are only legible within about 200 m. Worth
trying `DETAIL_BUDGET`/`MICRO_BUDGET` at roughly half on `MOBILE` and shooting
the same pose before/after; the picture at range is carriageway and markings,
both tier 0. I have not touched it -- it is a separate change with a visual
risk, and this commit is a pure-memory one.
