# Run log: skill issues found by real runs

Appended by the main session after each run's Reflect phase. Read before starting a run. One row per issue.

| Date | Game | Issue | Evidence | File | Fix | Status |
|---|---|---|---|---|---|---|
| 2026-11-18 | whiteout | Scaffold copied cookbook nested; main.js imports failed | build error on first scaffold | tools/scaffold.mjs | flatten cookbook/three/* into src/cookbook/ | fixed |
| 2026-11-18 | whiteout | The G2 gate the workflow used at run time was already mean ≥ 6.4, ≤ 6 majors, axes ≥ 6 (geometry ≥ 5.5), set before the run by calibrating the critic; only a reference doc still showed the older 8.0 stretch target, so a draft ship report compared 6.4 against 8.0. G2 failed (materials 5.5 < 6, 9 majors > 6); the mean 6.4 equals the starting bar; the stretch target is mean 8.0 | draft REPORT said "6.4 against 8.0" | references/critic-rubric.md §7 | reference doc corrected after the run to match the gate | fixed |
| 2026-11-18 | whiteout | Workflow subagents cannot write .md files; REPORT.md was missing | ship agent: "Subagents should return findings as text" | workflows/build-game.js, SKILL.md | ship returns text; main session saves REPORT.md | fixed |
| 2026-11-18 | whiteout | Flashlight reads as a floating glow, not a lit pool on surfaces | critic D1, pose-2 | cookbook (no spotlight/flashlight recipe) | add flashlight recipe: shadowed SpotLight + gobo, faint volumetric cone | open |
| 2026-11-18 | whiteout | Volumetric/drift noise boils over static surfaces; dither changes per frame | critic D2, D4 | cookbook/three/post (volumetrics), weather | temporal accumulation (TAA-lite) for volumetrics; wind-aligned drift streaks | open |
| 2026-11-18 | whiteout | Weather particles render indoors | critic D5 | cookbook/three/weather | interior volumes that cull particles | open |
| 2026-11-18 | whiteout | G4 missed at 1080p high (16.7 ms vs 12.5): ground snow patches, MSAA×4, shadows | bench-high.json | cookbook ground/, engine/quality.js | MSAA×2 on high; cheaper snow patches | open |
| 2026-11-18 | whiteout | Far field empty past the fog wall | critic D7, D11 | cookbook/three/backdrop | default ridge layers + distant lights in farfield | open |

## Workflow agents follow an unrelated mid-run user message
- **Issue:** a user asked an unrelated question in the same turn the Workflow was launched. Every agent from the first look
  round onward treated that message as its task, answered it and skipped its brief: look rounds and module owners did
  nothing, captures returned `errors: 999`, and the run finished suspiciously fast with only the spec and graybox done.
- **Fix:** every `agent()` prompt in workflows/build-game.js starts with a GUARD line pinning the agent to its brief and the
  game directory. A first, narrower guard ("ignore chat about other projects") was not enough: on the rerun the spec agent read the lead's
  "I reset the repo" status line, decided the reset was deliberate and halted. The guard now says the agent is one step of an
  automated pipeline, must do its brief in full, and must ignore the conversation (questions, status, resets) and start from
  the directory's current state. Lead tip: launch the Workflow in a turn of its own, and check that the first look and module results in the
  journal describe real work.
