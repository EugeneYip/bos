# The resolution path: shade at the tier's rate, present at the panel's

Working notes. Written as the work happened, including the measurements that
did not say what I expected.

## The defect

On a Retina display the *browser* did the final upscale, with plain bilinear
and no sharpening, and the FSR upscaler the repo already owns never ran.

- `src/core/config.ts` caps pixels per CSS pixel per tier: low 1, medium 1.25,
  high 1.25, ultra 1.5.
- `App.pixelRatioFor()` returned `min(dpr, cap)` and handed it to
  `renderer.setPixelRatio()`. On a dpr-2 MacBook at `high` the canvas backing
  store was CSS x 1.25.
- The canvas is CSS-sized, so the compositor stretched that by 2/1.25 = 1.6x,
  bilinear.
- `Post.applyTier()` set `renderScale = 1` on high/ultra, and `Post.resize()`
  only runs EASU+RCAS when `rw !== width`. So on exactly the configuration
  that needed it, the upscaler was switched off and the browser's bilinear
  stretch was the last thing to touch the image.

`src/post/passes/upscale.ts` (FSR 1.0 EASU + RCAS) was already there. It was
simply never reached.

## The shape of the fix

Separate *how many pixels we shade* from *how many pixels we present*.

- `sceneRatio` — pixels shaded per CSS pixel. **Must not change.**
- `presentRatio` — pixels presented per CSS pixel; the renderer's pixel ratio.
- `renderScale = clamp(sceneRatio / presentRatio, 0.5, 1)` — what EASU
  upscales from.

`min(dpr, PRESENT_CAP=2)` bounds presentation, and `sceneRatio / 0.5` bounds
the upscale factor at 2x linear, which is FSR's quality limit.

**Mobile is gated out.** `presentRatio` keeps exactly today's `min(dpr, cap)`
when `MOBILE`. The post chain holds ~24 render targets whose byte size scales
with *presentation*, not render, resolution, and the live iOS bug is the OS
killing the tab on steady-state GPU footprint a few seconds after a good boot.
Presenting a phone at 1.44 instead of 1.0 would have grown every
full-resolution target ~2x in area, i.e. made that bug worse to fix a
sharpness complaint that came from a desktop. Desktop only.

A pin (the HUD Resolution control) is a request for that many *shaded* pixels,
so the tier's render scale does not then undercut it — that is today's
behaviour (`resolutionPinned` forced `renderScale = 1`) and the invariant
requires keeping it.

## Verification harness

- `qa/respath/_ratios.mjs` — the invariance table. Reads the dimensions of the
  real `post.scene` render target by walking the module tree (the way
  `qa/_gpumem.mjs` does) rather than trusting any number the code reports
  about itself, so before/after runs are comparable even though the code
  changed underneath. Also totals render-target MB.
- `qa/respath/_shoot.mjs` — captures at a real device pixel ratio.
  `qa/shoot.mjs` pins `deviceScaleFactor: 1`, which is the one case where the
  defect cannot appear. Screenshots the composited page, browser blit
  included, so the metric sees what the eye sees.
- `qa/respath/_hf.mjs` — mean |laplacian| of luma, whole frame and per band.
  Same metric as `qa/crit2/_sparkband.mjs`.

Both probes verify a build nonce over the preview port before trusting it.
That guard fired on the first run — port 4471 was already serving another
agent's bundle, which is exactly the "the fix had no effect" trap the harness
comment in `qa/shoot.mjs` warns about.

Baseline build frozen at `dist-respath-before` before any source edit, so the
before-numbers cannot drift as other agents commit.

## Results

(filled in below as each run lands)

### A second defect, found while building the invariance table

`_ratios.mjs` switches tier in-page. `_fresh.mjs` reloads per config. They do
not agree, and the reason is a bug:

    dist-respath-before, css 1600x900, dpr 2, tier high, Auto
    fresh boot                        present 1.25  scene 2000x1125   89.5 MB
    after a no-op setQuality('high')  present 1.25  scene 2500x1406  131.3 MB
                                                          x1.25 = the pixel ratio

`Post.width/height` are stored in *device* pixels (`resize()` does
`width * dpr`), and the `quality-changed` / `resolution-changed` handlers
re-entered `this.resize(this.width, this.height, ctx)` -- so the pixel ratio
was applied a second time. `App.setQuality` calls `onResize()` (which passes
CSS pixels, correctly) *before* emitting, so the doubled value is what
survives.

It does not compound, because the next real resize passes CSS again. But it
means: every touch of the settings panel inflates the scene target by the
pixel ratio, and the whole 16-row table in `ratios-dist-respath-before-dpr2.json`
was measured in that inflated state. At dpr 2 `ultra`/Auto that is 3600x2025
shaded instead of 2400x1350 -- 2.25x the pixels, 403 MB of render targets
instead of ~180 -- for anyone who has ever changed a setting. Which, on the
resolution complaint this task came from, is everyone who tried to fix it by
hand.

So "today" for the invariant is the **fresh-boot** number. Deriving it:
dividing every row of the previous in-page table by that row's `present`
reproduces `CSS x present x (pin ? 1 : tierRenderScale)` for all 16 rows, and
the one cell measured directly by fresh boot (high/Auto -> 2000x1125) agrees.

Boot costs ~215 s, so 16 configs x 3 dpr x 2 builds of fresh boots is ~6 h.
`_table.mjs` gets the same numbers from one boot per dpr: after `setQuality` /
`setResolution` it dispatches a `resize` event, whose handler passes CSS
pixels and so lands on the un-doubled geometry. It reports both reads, which
also turns the doubling into a measured column rather than a claim.

## Result 1: the settings panel was resizing the scene in the wrong unit

Measured with `_table.mjs` on `dist-rp-before` (a pristine worktree build at
99c3d87, so nothing here is another agent's in-flight work), css 1600x900,
dpr 2. `scene` is the real `post.scene` render target, found by walking the
module tree. `fresh` is a clean load; `touched` is the same configuration
after one no-op `setQuality(sameTier)`.

    tier   pin     present  scene fresh     MB   scene touched   MB      growth
    low    Auto    1        1152x648      36.6   1152x648      36.6   x1
    low    50%     0.5       800x450      22.5    400x225      13.6   x0.5
    low    100%    1        1600x900      59.5   1600x900      59.5   x1
    low    Native  2        3200x1800    207.6   6400x3600    778.7   x2
    medium Auto    1.25     1700x956      74.4   2125x1195    104.6   x1.25
    medium 50%     0.5       800x450      30.1    400x225      21.1   x0.5
    medium 100%    1        1600x900      67.2   1600x900      67.2   x1
    medium Native  2        3200x1800    215.8   6400x3600    787.1   x2
    high   Auto    1.25     2000x1125     89.5   2500x1406    131.3   x1.25
    high   50%     0.5       800x450      23.4    400x225      14.5   x0.5
    high   100%    1        1600x900      61.2   1600x900      61.2   x1
    high   Native  2        3200x1800    212.2   6400x3600    783.5   x2
    ultra  Auto    1.5      2400x1350    192.0   3600x2025    403.1   x1.5
    ultra  50%     0.5       800x450      33.9    400x225      19.9   x0.5
    ultra  100%    1        1600x900      93.2   1600x900      93.2   x1
    ultra  Native  2        3200x1800    330.3   6400x3600   1231.2   x2

The growth column is exactly `present`, in every row. That is the whole bug:
`resize()` takes CSS pixels and multiplies by the pixel ratio itself, and the
two handlers fed it `this.width`, which is already device pixels.

Three things worth saying about it:

- It is invisible from a clean profile. `App.setQuality` calls `onResize()`
  *before* it emits, so the correct geometry is computed and then immediately
  replaced; and the next genuine window resize passes CSS again and puts it
  back. Only a measurement taken while the panel's effect is still standing
  sees it.
- **It also goes the wrong way.** Where `present` is below 1 the scene is
  multiplied by *less* than one: at a 50% Resolution pin, one touch of the
  panel takes 800x450 down to 400x225 -- a quarter of the pixels the user
  explicitly asked for. So the control that exists to make the image sharper
  made it blurrier as soon as it was used.
- At a Native pin on a dpr-2 panel the chain's render targets go from 330 MB
  to **1231 MB**. On a machine with a 1 GB-ish practical budget that is not a
  slow frame, that is a dead tab.

This matters for the complaint this whole task came from. The user has been
opening the settings panel repeatedly to look at the water they said looked
wrong -- so they were very likely looking at the x1.25/x1.47 state rather
than at the app as shipped, and if they ever tried the 50% pin to compare,
they got a quarter of the pixels they asked for. Fixed on its own, ahead of
the presentation work, so it cannot get stuck behind it.

### Verified

`dist-rp-fix1` is the same pristine worktree build plus the one-file fix.
`_table.mjs` on it, same css and dpr:

- `switchedGrowth` is **1 in all 16 rows** (before: 0.5, 1, 1.25, 1.5, 2
  depending on the row's pixel ratio).
- Every fresh-boot column -- `present`, `scene`, `sceneRatio`, `renderScale`,
  `rtMB`, target count -- is **identical to the baseline in all 16 rows**,
  checked field by field rather than by eye. So a clean load is untouched;
  only the state after a settings change moves, and it moves onto the clean
  load's numbers.
