# engine/ — core, harness, quality, input, boot, loop, springs, bench, finalize

Infrastructure every game and showcase sits on. Checked during development on an isolated showcase page (not included
in this repo) with a status board printing tier, dynres self-test, warm-up, late compiles, input mode, context-loss test
and the boot timeline.
Wiring order: `references/pipeline-order.md` §2. Template wiring: `templates/three/src/main.js`.

## Files

| File | Exports | Purpose |
|---|---|---|
| `core.js` | `createCore({canvas, ART, fov, near, far})`, `sunDirFromArt`, `mulberry32` | G object (CONTRACT.md), renderer (NoToneMapping, sRGB, shadows on, `shadowMap.autoUpdate=false`), loop (`preupdate` → `update` → `G.render`), event bus `G.on/emit/off` (allocation-free `emit(evt, a, b, c, d)`: max 4 args), emits `contextrestored` on the canvas `webglcontextrestored` |
| `harness.js` | `installHarness(G)`, `rendererString` | `__ready __frames __errors __stats() __setCam __G`, `?cam ?shot`. `G.statsHooks.push(() => ({...}))` adds fields to `__stats()` |
| `patch.js` | `patch, hasPatch, patchKeys, sharedUniform, patchUniforms, after, before` | chainable `onBeforeCompile` (see CONTRACT.md); `patchKeys(mat)` lists a material's patch keys |
| `finalize.js` | `finalizeMaterials(G, root, {atmos, weathering})` → `{materials, atmos, weathering, skipped}` | one pass over the finished scene: `patchAtmos` + `patchWeathering` on every built-in world material that lacks them (rules below) |
| `quality.js` | `createQuality(G, opts)`, `detectTier`, `warmup(G, o)`, `installContextGuard`, `TIERS`, `TIER_ORDER` | tier detection, dynres, shader warm-up, context loss |
| `input.js` | `createInput(G, opts)`, `DEFAULT_BINDINGS`, `DEFAULT_PAD` | keyboard map, pointer lock (retry on click; drag only after 3 refusals), gamepad, touch twin-stick, bot API (`window.__input`) |
| `boot.js` | `createBoot(G, {stubs})` → `{stage, finish, progress, modules}` | staged loader, loading bar, stub fallback, `__stats().modules` |
| `loop.js` | `createFixedStep({hz, maxSteps, step})`, `createModuleRunner(G)`, `rngStreams(G, seed)` | fixed-step sim + interpolation alpha, crash-isolated module updates, per-system RNG |
| `springs.js` | `Spring`, `Spring3`, `damp`, `dampV3`, `dampAngle`, `smoother`, `SUBSTEP` | damped springs in 8 ms sub-steps, frame-rate independent smoothing |
| `bench.js` | `installBench(G, {path, seconds, warm})` → `G.bench(o)` | fly-through along PATH, frame stats → `window.__bench`; `#bench` auto-runs |
| `showcase-boot.js` | `bootShowcase({ART, fov})` | minimal page boot for look-dev pages (fly camera + `G.ready({cam,target})`) |

Per-frame stats: `renderer.info.autoReset = false`; the loop resets it once per frame, so `__stats().calls/tris` are
**whole-frame totals including shadow and post passes** (`G.frameCalls`, `G.frameTris` = last complete frame).

## quality.js

```js
const Q = createQuality(G, { budgetMs: 1000/60, applyPixelRatio: true, allowUltra: false, storageKey: 'mygame.q' });
G.quality.tier / .scale / .settings / .maxTier / .pinned / .detected / .dynres{on,p75,history} / .contextLosses
G.on('quality', (q, what) => { /* what = 'scale' | 'tier': resize targets, swap #defines */ });
await Q.warmup({ extras: [{ material: sparks, kind: 'points' }, { material: debris, kind: 'instanced' }] });
Q.setTier('med', 'settings'); Q.setScale(0.8);
Q.setManualScale(0.7);   // settings menu: pin render scale (dynres off); null = Auto. false if ?dynres/?shot decided
await Q.simulateContextLoss(500);
G.on('contextrestored', () => env.bake());   // anything baked on the GPU must rebake
```

- **Tier**: `?q=` pins it. Else `detectTier`: software/mobile → low; Intel (non-Arc)/Mali/Adreno/PowerVR → med; desktop → high;
  `deviceMemory <= 4` caps at med; `deviceMemory <= 2` or `hardwareConcurrency <= 2` → low. `ultra` only with `?q=ultra` or `allowUltra`.
- **`TIERS[tier]`** (read via `G.quality.settings`): `pixelCap` MP, `minScale` (dynres floor 0.6/0.6/0.7/0.8), `shadow`,
  `pcssTaps`, `volSteps`, `ao`, `bloomMips`, `msaa`, `aniso`, `particles`, `drawDist`, `lights`. Post passes follow
  `POST_TIERS` in `post/pipeline.js`.
- **Pixels**: `G.dpr` becomes `min(device dpr, sqrt(pixelCap/cssArea))`. With a post pipeline (`G.post` set) the post renders at
  `G.width*G.dpr*G.quality.scale` and upscales; without one the canvas pixel ratio becomes `G.dpr*scale`. `applyPixelRatio:false` = hands off.
- **Dynres controller** (off in `?shot`, `?dynres=0`): p75 and p90 of rAF frame times over 0.5 s windows (≥ 8 frames, or ≥ 3 after
  1.5 s), ignoring the first 1.5 s after ready and any window with programs still compiling. Over = p75 > 1.25×budget, p90 >
  1.5×budget or > 3 % of frames over 1.7×budget (doubled frames; EMA ~2 s, `G.quality.dynres.miss`). Over by > 1.25×: one window, jump to scale·sqrt(0.75·budget/p75); below the floor and
  p75 > 2×budget for 2 windows in a row → tier down (2 tiers above 4×; one stall only moves the scale). Otherwise 2 windows → −0.05 (one window → −0.1 when > 6 % of frames double). A tier-up with p75 < 0.5×budget restarts at scale 1 (else 0.85). Headroom = p75 < 0.85×budget and p90 <
  1.3×budget, or vsync-locked (p50 within 1 ms of budget, p90 < 1.1×), and < 1 % misses (3 windows → +0.05; 12 if that step failed in the last 30 s).
  Tier down after 3 windows at the floor still over budget (≥ 5 s apart); tier up after 10 windows at scale 1 with p75 < 0.7×budget, never
  above the starting tier, ≥ 10 s between tier-ups, exponential backoff when a tier-up is undone within 60 s.
  Ignores 1-2 s after resize/visibility/tier changes and single frames > max(250 ms, 2.5×p75) (a GPU that slow still produces evidence).
- **Persistence**: 15 s after ready the settled `{tier, scale}` goes to localStorage; a crash canary set at boot and cleared
  then makes a boot that never got there start one tier lower. Disabled in `?shot` and with `?q=`.
- **Tests**: `Q._feed(ms, frames)` drives the real controller on a virtual clock; `Q._endTest()` restores everything.
  The showcase self-test (hitches → nothing; 30 fps → 0.80/med; headroom → back to 1.00/high) runs on every load.
- **Warm-up**: makes hidden objects visible + unculled, adds 1 cm proxies for `extras`, `renderer.compileAsync`, renders
  `frames` real frames through `G.render` (post passes + shadow depth programs), then polls `program.isReady()`
  (KHR_parallel_shader_compile) until all link or `timeout`. Result in `G.warmupStats {ms, programs, proxies, timedOut}`.
  Proof it worked: `__stats().programs` must not grow after ready (showcase row "late compiles 0").
- **Context loss**: banner, `G.quality.contextLost`; on restore three re-creates GL state and re-uploads CPU-side data; the
  guard removes core's `'webglcontextlost'` entry from `G.errors`, re-runs the warm-up compile-only (`frames: 0`, nothing
  hidden is drawn) and forces a shadow update. `contextrestored` itself is emitted by **core.js** (once per restore, whether
  or not `createQuality` exists); the guard is one of its listeners. Test: `?ctxtest=1` on the showcase.

## input.js

```js
const input = createInput(G, { root: uiRoot, sens: 0.0022, invertY: false, dragStyle: 'hover' });  // create BEFORE consumers
G.on('update', () => { yaw -= input.lookX; pitch -= input.lookY; walk(input.move.x, input.move.y); if (input.pressed('jump')) jump(); });
// bots / playtests
__input.hold('forward', 800); __input.press('jump'); __input.look(200, 0); __input.lookRad(0.5, 0); __input.setMove(0, 1, 1000); __input.clear();
```
- Values latch once per frame on `G.on('preupdate')` (before every `update` listener; flagged `selfUpdating`): `lookX/lookY` radians this frame
  (mouse × sens, right stick × `padSens` rad/s, touch × `touchSens`), `move` Vector2 (x strafe, y forward, |v| ≤ 1), `down/pressed/released(action)`.
- `bindings` = `{action: ['KeyW', 'Mouse0', ...]}`; `pad` = `{action: buttonIndex}` (standard mapping). Unknown actions used by
  `hold/press` are created on the fly.
- `mode`: `lock` (click requests pointer lock synchronously from the gesture: `unadjustedMovement` first, plain on
  `NotSupportedError` (Linux / Wayland) and remembered; a refused or 1.5 s silent request is NOT permanent: hint "Click to
  capture the mouse" + `input:lockfail`, the next click retries; while unlocked a free cursor never steers; movementX/Y
  spikes (> `spikePx` 100 px per ms since the last event, floor 400 px) or within 60 ms of a lock change are dropped), `drag` (lock API missing or refused 3 times in a row → banner
  "Mouse capture unavailable"; default `hover` style: mouse motion turns, cursor resting in the outer 5 % keeps turning;
  `button` style: hold a mouse button + drag, that button still fires), `touch` (first touch: left 45 % = floating stick, push past the rim = sprint;
  right side = look; buttons from `touchButtons`), `pad`. Mouse buttons use `mousedown/up` (pointer events fold chorded
  presses into pointermove). The canvas cursor is hidden while `input.enabled` (shown only while waiting for a capture click); `hideCursor: false` keeps it (default when `lockOnClick: false`).
- `input.enabled = false` (menus) zeroes everything except `alwaysOn` actions (default `['pause']`).
- Events: `input:unlock` (`'exit'`: a lock that was held is lost (Esc, alt-tab) → pause with "click to resume"; the Esc that
  ended the lock does not also toggle `pause`), `input:lockfail` (`why`: never captured, no pause), `input:drag` (`why`). `__stats().input = {mode, locked, lockFailed}`.

## boot.js

```js
const boot = createBoot(G, { stubs: STUBS });                     // finds #boot .boot-bar>i / .boot-msg or makes its own
const sky = await boot.stage('sky', () => createSky(G), { msg: 'Lighting the sky', at: 0.2 });
const world = await boot.stage('world', () => buildWorld(G), { critical: true });
await boot.finish({ extras });     // warm-up (if a quality controller exists) → fade loader → G.markReady()
```
- `stage(name, fn, {critical, msg, at, stub, expectFail})`: times `fn` (sync/async), records `{name, ms, ok, stub, error?}`.
  Throw in a non-critical stage → `stub(G)` / `stubs[name](G)` / `{}` with `isStub = true`, error pushed to `G.errors`
  (`expectFail` → console.warn only). Critical → fatal screen, `window.__fatal`, rethrows.
- Modules returned with `update(dt,t)` run every frame in stage order inside `createModuleRunner` (one try/catch each,
  logged once, dropped after 30 failures). Set `selfUpdating: true` if the module registered its own `G.on('update')`.
- `finish({warmup:false})` skips warm-up; `finish({onReady})` replaces `markReady` (showcase pages: `onReady: () => G.ready(...)`).

## finalize.js

```js
import { finalizeMaterials } from './engine/finalize.js';
finalizeMaterials(G, G.scene);   // after world/ground/water/backdrop/props/lights/decals, before shadows + warm-up
```
- Each material once (shared materials are not patched twice); idempotent, so call it again after adding objects.
- **atmos** on Standard/Physical/Basic/Lambert/Phong/Toon without `atmos`/`atmosAdd`; additive blending → transmittance
  only. Skips ShaderMaterials (sky, backdrop, particles call `atmosApply()` themselves), Points/Sprite/Line, `userData.noAtmos`.
- **weathering** on opaque Standard/Physical without `wth` (makeMaterial materials already have it). Skips materials with
  their own wet model (patch keys `ground*` from ground/ground.js, `sea*` from water/sea.js), transparent/additive ones
  (glass, decals, halos) and `userData.noWeather`. Preset: `userData.weather` (`'prop'|'ground'|'sheltered'` or an opts
  object), else `'ground'` for meshes/materials named ground/floor/road/terrain/asphalt, else `'prop'`.
- Needs `installAtmos(G)` and `initMaterials(G)` (or `initWeathering(G)`) first. Result also in `G.finalizeStats`.

## loop.js · springs.js · bench.js

```js
const sim = createFixedStep({ hz: 120, maxSteps: 5, step: (h, t) => physics(h) });  const alpha = sim.advance(dt);
const kick = new Spring(520, 30); kick.impulse(1.5); kick.update(dt);               // k (1/s²), c (1/s); critical c = 2√k
const sway = Spring3.fromFreq(1.7, 0.5); sway.target.set(x, y, 0); sway.update(dt);
x = damp(x, target, 10, dt);                                                       // λ = 1/τ
installBench(G, { path: PATH }); const r = await G.bench({ seconds: 20 });           // or URL #bench
```
Tested weapon spring values: recoil z (520,30) pitch (380,26) yaw (300,22) roll (300,20), sway (110,15), jump/land (140,13).
Bench report: `{avg, p50, p95, p99, max, fps, frames, scale, scaleMin, tier, tierEnd, calls, tris, errors, renderer, dynres}`.

## Cost per tier
Engine code is CPU-only and allocation-free per frame (input latch, dynres sample, springs, fixed step). Dynres evaluation
sorts 240 floats once a second. Warm-up: ~15-900 ms at boot depending on program count. Tier switching itself is
free; what it triggers (target re-allocation, `#define` recompiles) is paid by the listening systems — warm them.

## Pitfalls
- Create `quality` right after core (others size from it). Input latches on `preupdate`, so its creation order is free.
- Never set `G.quality.scale` directly — `Q.setScale()` applies pixels and emits the event.
- `?shot=1` disables dynres and persistence and forces `G.dpr = 1` (repeatable captures). Bench with `?dynres=0&q=high`.
- Playwright without a user gesture cannot pointer-lock: input falls back to drag; bots use `__input`, never synthetic mousemove.
- `G.on` handlers run in registration order; `G.off(evt, fn)` exists for dispose (safe to call from inside a handler).
- `G.emit` passes at most 4 arguments (fixed arity keeps it allocation-free); pass an object for more.
- Gamepads are polled only after `gamepadconnected` (Chrome's `navigator.getGamepads()` allocates per call).
- A GPU-baked texture (PMREM env, material bakes, caustics) is black after a context restore unless its owner listens to `contextrestored`.
- `G.errors` must stay empty in captures: a stubbed module pushes an error on purpose (stubs are gate failures).
