# tools/ — capture, bench, playtest, size, contact sheets, state

All Playwright tools launch real-GPU headful Chrome (headless = SwiftShader = meaningless) and serve local files over
http on an OS-assigned port, so parallel agents never collide. Never kill other agents' Chrome processes.

| Tool | Use |
|---|---|
| `capture.mjs --url F --out D --poses "x,y,z,tx,ty,tz;..." [--critic] [--shimmer] [--w --h --wait --query --names --hash]` | stills per pose; `critic/*.jpg` (≤1568 px) + busiest 768 px crops; `-shimmer.jpg` temporal diff; `meta.json` (stats/errors/logs — never show it to the blind critic) |
| `bench.mjs --url F [--seconds 20] [--q high\|auto] [--dynres 0] [--w 1920 --h 1080] [--warm 5000] [--gate "avg<=12.5,p99<=20,max<=33"] [--out bench.json] [--vsync]` | `--q auto` = defaults (tier detection + dynres on; add `--dynres 0` to freeze the scale). vsync + frame-rate limit OFF; runs `__G.bench()` (engine/bench.js) or flies `__G.PATH`; avg/p50/p95/p99/max, scale, tier start→end, calls, tris, errors; exit 1 on gate fail, errors, software GPU or a tier change |
| `playtest.mjs --url F --script steps.json [--out D]` | drives `window.__input` + `__G`: `wait waitFor hold press move look lookRad key click setCam eval(as) assert shot`; fails on any `__errors`, failed assert, or stub modules |
| `size-report.mjs F [--budget 2] [--json]` | raw/gzip/brotli, js/css/markup, GLSL estimate, binary blobs, base64 runs, external URLs; exit 1 over budget or with blobs |
| `contact-sheet.mjs --out S.jpg [--cols 3 --tile 520 --title T --fit] files… \| --dir D [--match RE]` | labelled tile sheet (PNG/JPEG in, JPEG out, built-in bitmap font) |
| `serve.mjs [dir\|file] [--port 0]` | static server (`startServer()` export used by the other tools) |
| `state.mjs init\|show\|get\|set\|phase\|round next\|score\|gate\|defect add/close\|defects [--file STATE.json]` | resumable run state: phase, round, best score/shots/build, gates G1-G4/size, open defects (atomic writes) |

Frame-time numbers are only meaningful when no other agent is using the GPU.
