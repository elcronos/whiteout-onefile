---
name: onefile-aaa
description: Build an AAA-looking single-file 3D browser game (one dist/index.html under 2 MB, everything procedural — no texture, model or audio files) from a one-line "genre + concept"; runs on Claude Opus. Runs a multi-agent pipeline — spec, look-lock, parallel module owners, blind screenshot critic loop, playtest bot, perf gate, esbuild single-file bundle — on top of a tested three.js technique cookbook. Use when the user says "create a <genre> game about <concept>", "single-file game", "one HTML file game", or "AAA-looking browser game".
---

# onefile-aaa

Why this works (read `references/lessons.md`): procedural browser games look AAA because of a **render stack** (HDR post chain,
filmic grade, volumetrics, sky-matched IBL, baked procedural PBR + weathering, PCSS, planar puddles) and a **process**
(real-GPU captures at fixed hero poses → a blind critic that only sees images → fixes, repeated for hours), not because of
detailed models or hidden prompts. This skill ships the stack as `cookbook/three/` (each system checked on an isolated showcase page during development)
and the process as `workflows/build-game.js`.

**Judging quality:** the skill has its own visual standard (`references/quality-bar.md`): absolute per-axis anchors, its own
calibration frames, its own history, and a bar that only rises. Never score, gate or review a build by comparing it with other games.
`lessons.md` is background on technique and process only.

## Inputs
`<genre>` + `<concept>`; optional budget `quick | standard (default) | full`, target dir. Ask nothing else — derive and record
every decision in SPEC.md. Tell the user up front: **standard = several hours and millions of tokens; resumable.**

## Steps (main session)
1. **Preflight** — `node -v` (≥18), Google Chrome installed, a local display + hardware GPU (cloud/headless = SwiftShader →
   tell the user visuals/perf can't be verified). Ensure `~/.claude/agents/onefile-critic.md` exists (copy from `agents/`; it
   has `tools: Read` only, so blindness is enforced). If it was just installed, the session may need a restart to see it.
2. **Scaffold** `<dir>` (default `./<slug>`): `node <skill>/tools/scaffold.mjs <dir>` (run in background; does npm i — or pass
   `--node-modules <existing node_modules>` to symlink). It copies the template, flattens `cookbook/three/*` into `src/cookbook/`
   (main.js imports `./cookbook/<area>/...`), copies tools, git-inits and builds. Smoke:
   `node tools/capture.mjs --url dist/index.html --out shots/smoke --critic` → 0 errors.
3. **Run the pipeline**: read `references/quality-bar.json` and pass it as `bar`:
   `Workflow({ scriptPath: "<skill>/workflows/build-game.js", args: { dir, skill: "<skill dir>", genre, concept, budget, bar } })`.
   It starts by checking the critic against the skill's own calibration frames (drift offset; warns if the critic cannot tell floor from best).
   Invoking this skill is the user's opt-in to the multi-agent workflow. Relay progress lines; don't poll.
   Launch it in a turn of its own (answer any other question from the user before or after, not in the same turn): workflow agents can see
   the conversation's latest user message. Every prompt is pinned to its brief, but check that the first look and module results in the
   journal describe real work; if they answer a question instead, stop and relaunch.
4. **Resume** after a limit/crash: `Workflow({ scriptPath, resumeFromRunId })` (cached agents replay), and `node tools/state.mjs show` in `<dir>`.
5. **Report**: the workflow returns the report text (subagents cannot write report files) — save it as `<dir>/REPORT.md` and commit, then report from it: gates, size, perf, critic scores, open defects, best screenshots. Offer to publish `dist/index.html`.
   Never claim a gate passed that REPORT.md marks failed.
6. **Reflect** (the workflow's last phase returns `reflection` and `quality`; if they are missing, do the review yourself the same way).
   The lead judges only by the skill's **own** standard: the bar in `quality-bar.json`, the per-axis anchors in `critic-rubric.md` §2,
   the skill's best-ever frames in `references/calibration/best/` (with a blind A/B against them), its run history, and whether
   the frames deliver the SPEC/ART intent. It never compares with other games. Then, in the main session:
   - Append `## Self-review` to `<dir>/REPORT.md`: verdict, vs bar, vs own best, intent, weaknesses, and ranked next steps with cost. Commit.
   - **Ratchet** per `references/quality-bar.md`:
     - append the history row;
     - if `quality.beatBest` is `win-clear`, replace `calibration/best/` with the new frames and update `anchors.best`;
     - raise the `g2` numbers when the rules say so. Never lower them automatically.
   - Append each `skill_issues` item to `references/run-log.md`. Apply the small, clearly right fixes to the skill now and say so;
     list the rest as open.
   - Tell the user plainly where the game landed on the skill's own bar and history, show 2-3 final shots, and offer the ranked
     next steps (AskUserQuestion when available).

No Workflow tool? Run the same phases by hand with the Agent tool in the order of `workflows/build-game.js` (the prompts there are the
role briefs), always using `subagent_type: "onefile-critic"` for critic and A/B calls, and the main session as lead.

## Gates (see references/critic-rubric.md, perf-budgets.md)
G1 boot (graybox builds, 6 poses capture with 0 errors) · Look-lock (lighting/atmosphere/grade ≥ 7) · G3 gameplay (playtest bot
reaches win + lose, 0 errors, no stub modules) · G2 visual (the skill's own bar in `references/quality-bar.json`, currently no blocker, ≤ 6 majors, axes ≥ 6, mean ≥ 6.4; it only ratchets up, see quality-bar.md) · G4 perf
(vsync-off bench) · size < 2 MB, no binary blobs.

## Map
- `cookbook/CONTRACT.md` — G object, ART schema, module shape, patching, harness hooks. `cookbook/three/<area>/README.md` — APIs.
- Engine: three.js r180 (WebGL2) only, bundled at build time (MIT; see `THIRD_PARTY_NOTICES.md`).
- `references/` — art-direction (10 look theses with full ART), genre-recipes, spec-template, defect-catalogue, critic-rubric,
  perf-budgets, pipeline-order, lessons. `tools/README.md` — capture/bench/playtest/size/state CLIs.
- `references/quality-bar.md` + `quality-bar.json` — the skill's own visual bar, calibration anchors, history and ratchet rules.
- `references/calibration/` — `floor/` (graybox) and `best/` (best shipped frames so far): the critic's drift check and the Reflect A/B.
- `references/run-log.md` — skill issues found by past runs and whether they were fixed. Read before a run.
- `THIRD_PARTY_NOTICES.md` — licences for three.js and the MIT-licensed code adapted in `cookbook/three/geo/` and `water/caustics.js`.

## Status / honesty
Cookbook systems were checked individually on isolated showcase pages during development (real GPU, 0 errors, minified;
those pages are not included here). The end-to-end pipeline (`workflows/build-game.js`) has been validated end to end once
(WHITEOUT, 2026-11-18, quick budget): playable, passed G1/G3/size, failed G2/G4. See references/run-log.md.
Expect to fix integration issues and feed them back into the cookbook.
