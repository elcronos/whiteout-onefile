# Cookbook contract (read before writing or using any cookbook file)

Every cookbook file is a plain ES module, copied into a game's `src/` by the skill. They must be
**drop-in**: import paths are relative inside `cookbook/three/`, and the only bare import is `'three'`.

## Stack
- `three@0.180.0`, WebGL2 `WebGLRenderer`. **Named imports only** (`import { Mesh, ... } from 'three'`), never `import * as THREE`.
- No three/examples/jsm imports unless the file is listed in "allowed addons" below (keeps bundle small and control total).
  Allowed addons: none. Write what you need (it is small).
- GLSL lives in template literals tagged with a leading comment: `/*glsl*/\`...\``. The build minifier only touches those.
  GLSL rules for minifier safety: every `#define`/`#if` on its own line; never write `a - -b` (write `a + b` / `a - (-b)`).
- No per-frame allocations in `update()` / `render()` hot paths: preallocate Vector3/Matrix4 scratch at module scope.

## The G object (shared state, created by `engine/core.js`)
```js
G = {
  renderer, scene, camera,            // camera: PerspectiveCamera, layers 0 = world
  canvas, width, height, dpr,         // CSS px size + device pixel ratio actually used
  t, dt, frame,                       // seconds since start, clamped frame dt (<= 1/20), frame counter
  ART,                                // art-direction constants (schema below) — READ ONLY at runtime
  quality: { tier: 'low'|'med'|'high'|'ultra', scale: 1.0 },  // scale = dynres render scale (or the manual one: createQuality().setManualScale)
  sun: { dir: Vector3 (normalized, points TO sun), color: Color (linear), intensity: Number, light: DirectionalLight },
  params: URLSearchParams,           // harness params (?shot ?cam ?q ?dt ?seed ?show ?post=0 ...)
  rng: (seed) => () => float[0,1),   // mulberry32 factory
  on(evt, fn) → fn, off(evt, fn), emit(evt, a, b, c, d),  // event bus (table below); emit passes at most 4 args
  statsHooks: [],                     // fns returning extra __stats() fields (harness.js)
  errors: [],                         // push strings; mirrored to window.__errors
  render: null,                       // set by post/pipeline.js; null → core calls renderer.render(scene, camera)
  post: null,                         // set by post/pipeline.js createPost(G)
  env: null,                          // PMREM texture from lighting/env-from-sky.js
  frameCalls, frameTris,              // whole-frame totals of the last complete frame (all passes)
}
```
Per-frame work goes in `G.on('update', fn)` (or a boot stage module with `update(dt, t)`); there is no `updaters` array.

## Bus events (`G.on` / `G.emit`)
`emit` is allocation-free (fixed arity, shared frozen empty list when nobody listens), so per-frame events are fine.
Listeners run in registration order; a throwing listener inside the frame loop is caught by core and logged to `G.errors`.

| Event | Emitted by | Args | When | Listeners (cookbook) |
|---|---|---|---|---|
| `preupdate` | engine/core.js | `dt, t` | every frame, before any `update` listener | input.js (latch), quality.js (dynres sampling) |
| `update` | engine/core.js | `dt, t` | every frame, before render | every system with per-frame work; boot.js module runner |
| `prerender` | post/pipeline.js | — | every frame, after `update`, right before the main scene pass (camera final) | ground/planar-reflection.js (mirror pass; falls back to end of `update` if no post) |
| `posttransparent` | post/pipeline.js | `renderer, camera, post` | every frame, after the opaque scene pass, HDR target bound and depth-tested | soft/transparent overlays that need the opaque depth (see post/README.md) |
| `resize` | engine/core.js, engine/quality.js | `w, h` (CSS px) | window resize; drawing-buffer pixel ratio change | quality.js, post (targets), anything sized from the buffer |
| `quality` | engine/quality.js | `G.quality, what` (`'scale'` or `'tier'`) | dynres scale step or tier change | post/pipeline.js (targets, passes); systems with tier-dependent `#define`s |
| `contextrestored` | engine/core.js (canvas `webglcontextrestored`) | — | once per recovered WebGL context loss | quality.js (re-warm, clears the loss error), env-from-sky.js, materials (bake/library), probes.js; any GPU baker must rebake here |
| `camset` | engine/harness.js `__setCam` | `pos[3], target[3]` | a harness/test sets the camera (`G.camLocked = true`) | controllers that must snap their own state (player yaw/pitch, follow cams) |
| `ready` | engine/harness.js `G.markReady` | — | once, after boot + warm-up; `window.__ready = true` | harness (`?cam=`), bench (`#bench`), quality (dynres ignore window), showcase cameras |
| `env` | lighting/env-from-sky.js | `texture` | after every env (re)bake | materials/probes that hold an env reference |
| `lightning` / `thunder` | weather/lightning.js | `{dist, azim}` / `{dist}` | strike / sound arrival (dist/343 s later) | lighting/sky.js (cloud flash), audio |
| `fx:shake` | fx/index.js | `amount, pos` | explosion | camera shake in the game's player/camera module |
| `input:unlock` / `input:lockfail` / `input:drag` | engine/input.js | `'exit'` / `why` / `why` | a held pointer lock was lost (Esc, alt-tab) / a lock request was refused or timed out (never captured; the next click retries) / drag fallback after 3 refusals or no API | UI: pause + click to resume on `unlock` only |
| `ui:state` / `restart` | template modules/ui.js | `state, prev` / — | UI state change / restart button | game modules (pause logic, reset) |

## Shared uniforms (`engine/patch.js` `patchUniforms`)
One uniform object per name, shared by every patched material (declared automatically in both stages) and spread into
custom ShaderMaterials (`atmosUniforms()`). Register with `sharedUniform(name, type, default)` — it never overwrites an
existing entry, so the first registration's object is the one everyone holds; WRITE `.value`, never replace the object.

| Uniform | Type | Set by (writer) | Read by |
|---|---|---|---|
| `uTime` | float | engine/core.js, every frame (`G.t`) | any patch (sway, ripples, sky clouds) |
| `uSunDir` | vec3 | lighting/atmos.js `installAtmos` / `syncAtmos(G)` from `G.sun.dir` (call `syncAtmos` after moving the sun) | atmos fog, backdrop, particles |
| `uSunColor` | vec3 | lighting/atmos.js `syncAtmos` = `G.sun.color × G.sun.intensity` | atmos in-scatter, backdrop rims, particles |
| `uFogSigma` `uFogScatter` `uFogFalloff` `uFogBase` `uFogSunInscatter` `uFogStart` | vec3, vec3, float×4 | lighting/atmos.js `installAtmos` from `ART.fog` (sigma, scatter, heightFalloff, baseHeight, sunInscatter, start) | every `patchAtmos` material, sky, backdrop/farfield.js, fx/common.js, weather particles |
| `uWet` `uDust` `uSnow` `uMacro` | float (0..1) | materials/weathering.js `initWeathering(G)` (from `ART.surface.wet/dust/snow/macroVar`, called by `initMaterials`) and `setWeather({...})` at runtime; weather/snow.js ramps `uSnow` toward its `cover` while it snows | every `patchWeathering` material |
| `uWthGround` `uSpecAA` | float | materials/weathering.js `setWeather({ ground, specAA })` | weathering (splash band height, spec AA on/off) |
| `uFlash` | float (0..~1.5) | weather/lightning.js (strike flicker) | lighting/sky.js, rain |
| `uWind` | vec3 | geo/scatter.js `windUniform()` (default `[1.5,0,0.4]`; copy `ART.weather.wind` into it) | foliage sway |

Fallback registrations: backdrop/farfield.js registers the sun/fog names with neutral defaults if `installAtmos` was not
called, and lighting/sky.js registers `uFlash` = 0 if no lightning exists. Call `installAtmos(G)` before building them so
the real values are in the shared objects.

## Finalizing world materials
After the world/props/backdrop are built, run `finalizeMaterials(G, root)` (engine/finalize.js) once on the scene: it adds
`patchAtmos` and `patchWeathering` to every built-in lit material that lacks them (skipping ShaderMaterials, sprites/points,
`userData.noAtmos` / `userData.noWeather`, additive → transmittance-only fog). Idempotent; materials made by
`makeMaterial` already carry weathering and are only given fog.

## ART schema (lives in the game's `src/art.js`, chosen from references/art-direction.md)
```js
export const ART = {
  sun:   { elevDeg: 12, azimDeg: 210, color: [1.0, 0.72, 0.45], intensity: 8.0 },
  sky:   { zenith: [0.10,0.16,0.28], horizon: [0.85,0.62,0.45], groundTint: [0.20,0.18,0.16], cloudCover: 0.6, cloudSharp: 0.5, sunGlow: 1.0, burnGap: 0.6 },
  fog:   { sigma: [0.010,0.012,0.016], scatter: [0.75,0.62,0.52], heightFalloff: 0.08, baseHeight: 0.0, sunInscatter: 1.0, start: 2.0 },
  vol:   { density: 0.020, g: 0.60, steps: 20, strength: 1.0 },  // volumetric shafts
  ambient: { skyIntensity: 1.6, envIntensity: 1.8 },
  grade: { exposure: 1.0, agxMix: 0.25, lookPower: 1.15, sat: 1.18, contrast: 0.18,
           splitShadow: [0.92,1.0,1.08], splitHigh: [1.06,1.0,0.92], vignette: 0.30,
           bloom: 0.065, bloomThreshold: 1.2, lensDirt: 0.4, chroma: 0.0015, grain: 0.022, sharpen: 0.25,
           adaptMin: 0.6, adaptMax: 2.0, adaptTau: 1.5 },
  surface: { wet: 0.8, dust: 0.0, snow: 0.0, macroVar: 0.25 },     // global weathering amounts
  weather: { kind: 'rain'|'snow'|'dust'|'none', amount: 0.7, wind: [1.5, 0, 0.4],
             lightning: false, lightningInterval: [18, 45] },          // optional storm (weather/lightning.js)
};
```

## Module shape (game modules AND cookbook "systems")
```js
export function create(G, opts) { /* build */ return { update(dt, t) {}, dispose() {}, /* api */ }; }
export function showcase(G) { /* optional: build an isolated scene to inspect this system */
  return { cam: [x,y,z], target: [x,y,z] }; }
```

## Material patching (engine/patch.js) — ALWAYS use this, never assign onBeforeCompile directly
```js
import { patch } from '../engine/patch.js';
patch(material, 'wet', (shader, renderer) => { shader.fragmentShader = shader.fragmentShader.replace(...); });
```
Patches chain in insertion order; `customProgramCacheKey` = joined keys. A patch must `replace` a three
chunk include (e.g. `#include <roughnessmap_fragment>`) and keep the include text when other patches might need it
(append/prepend, don't delete). Shared uniforms: `patchUniforms` (one object shared by all materials).

## Harness hooks (engine/harness.js) every game/showcase exposes
`window.__ready` (bool), `window.__frames`, `window.__errors` (array), `window.__stats()` → {fps, ms, calls, tris, scale, tier, textures, geometries},
`window.__setCam([x,y,z],[tx,ty,tz])`, `window.__G`. URL: `?shot=1` (hide UI, fixed time), `?cam=x,y,z,tx,ty,tz`,
`?q=low|med|high|ultra`, `?dt=0.016667` (fixed timestep), `?seed=N`, `?post=0`, `?show=<name>`, `?dynres=0`, `#bench`.

## Showcase pages (how each cookbook area proves itself)
`lab/showcases/<name>.js` imports cookbook files + `cookbook/three/engine/showcase-boot.js`; build with
`node lab/build-showcase.mjs <name>` → `lab/out/<name>.html`; capture with
`node onefile-aaa/tools/capture.mjs --url file-or-http --out dir --poses "x,y,z,tx,ty,tz;..."`.
