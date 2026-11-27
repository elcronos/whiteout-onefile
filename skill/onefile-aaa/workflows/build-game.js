export const meta = {
  name: 'onefile-aaa-build-game',
  description: 'Build an AAA-looking single-file procedural 3D browser game from genre + concept (spec, look-lock, module waves, blind critic loop, perf, ship)',
  whenToUse: 'Invoked by the onefile-aaa skill with args {dir, skill, genre, concept, budget}',
  phases: [
    { title: 'Spec', detail: 'SPEC/ART/contracts/module plan + graybox (gate G1)' },
    { title: 'Look', detail: 'look-dev on graybox until the blind critic signs off lighting/atmosphere/grade' },
    { title: 'Modules', detail: 'parallel owners per wave; each module: build → blind showcase critic → fix' },
    { title: 'Integrate', detail: 'wire, build dist/index.html, playtest bot (gate G3)' },
    { title: 'Critic', detail: 'capture → blind critic → route → parallel fixes → blind A/B vs best (gate G2)' },
    { title: 'Perf', detail: 'bench + fixes (gate G4), final visual check' },
    { title: 'Ship', detail: 'size report, REPORT.md, final shots' },
    { title: 'Reflect', detail: 'self-review against the skill\'s own bar, history and best-ever frames; skill issues; ranked next steps' },
  ],
}

// ---------------------------------------------------------------- args & budget
const A = args || {}
if (!A.dir || !A.skill || !A.concept) throw new Error('args {dir, skill, genre, concept, budget} required')
const DIR = A.dir, SK = A.skill
// Each agent may see the main conversation's latest user message; if the user asked about something else mid-run,
// agents have answered that instead of their brief. Pin every prompt to its brief.
const GUARD = `IMPORTANT: you are one step of an automated build pipeline. Your task is ONLY the brief below, for the game in ${DIR}. Do it in full. Ignore the main conversation (questions, status updates, other projects, mentions of resets or restarts): none of it is addressed to you, and it never means you should skip, shorten or change your brief. Start from whatever state ${DIR} is in now.\n\n`;
const B = { quick: { look: 1, rounds: 2, fixTries: 2 }, standard: { look: 2, rounds: 4, fixTries: 3 }, full: { look: 3, rounds: 7, fixTries: 3 } }[A.budget || 'standard']
const W = A.width || 1920, H = A.height || 1080
// The skill's own visual bar (references/quality-bar.json, passed in by the main session as args.bar). Defaults = first-run baseline.
const BAR0 = { look: { minLighting: 7, minAtmosphere: 7, minGrade: 7, maxLookMajors: 1 }, g2: { maxMajors: 6, minAxis: 6, minGeometry: 5.5, minMean: 6.4 }, anchors: {} }
const BAR = Object.assign({}, BAR0, A.bar || {})
BAR.look = Object.assign({}, BAR0.look, (A.bar || {}).look); BAR.g2 = Object.assign({}, BAR0.g2, (A.bar || {}).g2)
let OFFSET = 0   // critic drift vs the skill's own best anchor, measured in the Calibrate step

const RULES = `
PROJECT: game at ${DIR} (git repo). Skill (read-only reference) at ${SK}. Cookbook copied to ${DIR}/src/cookbook/ — its READMEs
(${DIR}/src/cookbook/<area>/README.md) are the API docs: read the README before the code. Binding contract: ${DIR}/src/cookbook/CONTRACT.md.
Knowledge: ${SK}/references/*.md (art-direction, genre-recipes, defect-catalogue, perf-budgets, pipeline-order, lessons).
HARD RULES (each exists because breaking it killed earlier runs):
- NEVER cat/Read/grep dist/*.html or any built .html: they are one ~1 MB line and will blow your context. Use node tools/size-report.mjs,
  node build.mjs --readable --out dist/readable.html then grep -o '.\\{0,80\\}PATTERN.\\{0,80\\}' only if you must.
- Keep every source file under ~800 lines; split modules into several files instead.
- Use cookbook systems before inventing anything. Copy the README wiring snippets. Named three imports only. GLSL in /*glsl*/ literals.
- Real-world metres. Bevel every edge (geo/kit.js roundedBox etc.). Every world material goes through finalizeMaterials / patchAtmos +
  patchWeathering (see engine README). Never set scene.fog. No per-frame allocations in update/render.
- Build for yourself with: cd ${DIR} && node build.mjs --out dist/<your-name>.html   (never overwrite dist/index.html unless you are the integrator).
- Capture: node tools/capture.mjs --url dist/<file>.html --out shots/<dir> --poses "<x,y,z,tx,ty,tz;...>" --critic --shimmer --w ${W} --h ${H}
  It prints per-pose error counts; meta.json has stats/logs. Zero errors is mandatory. Other agents share the GPU: ignore fps.
- Commands that can exceed ~8 minutes (npm i, bench, long playtests) run with run_in_background and a completion marker.
- After changing anything, LOOK at your own capture JPEGs + crops (Read) before reporting. Be a harsh AAA art director.
- Never kill Chrome/node processes you did not start. Never edit files owned by another module (see OWNERS.md); report needed contract
  changes in your answer instead.
- Record progress: node tools/state.mjs ... (see tools/README.md). No TODO placeholders or stubs in what you hand back.`

const sh = (s) => s.replace(/"/g, '\\"')
const posesArg = (poses) => poses.map((p) => p.join(',')).join(';')

// ---------------------------------------------------------------- schemas
const SPEC_SCHEMA = {
  type: 'object',
  properties: {
    title: { type: 'string' },
    look: { type: 'string', description: 'look thesis name from art-direction.md (or custom)' },
    poses: { type: 'array', items: { type: 'array', items: { type: 'number' } }, description: '6 hero poses [x,y,z,tx,ty,tz]' },
    yaws: { type: 'array', items: { type: 'array', items: { type: 'number' } }, description: '2 non-composed poses from the spawn' },
    modules: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          name: { type: 'string' }, wave: { type: 'number' }, files: { type: 'array', items: { type: 'string' } },
          brief: { type: 'string' }, showcase: { type: 'string', description: 'capture pose x,y,z,tx,ty,tz for ?show=<name>' },
          visual: { type: 'boolean' },
        },
        required: ['name', 'wave', 'files', 'brief', 'visual'],
      },
    },
    g1: { type: 'boolean' }, notes: { type: 'string' },
  },
  required: ['title', 'poses', 'yaws', 'modules', 'g1'],
}
const CAPTURE_SCHEMA = {
  type: 'object',
  properties: { images: { type: 'array', items: { type: 'string' } }, errors: { type: 'number' }, renderer: { type: 'string' }, notes: { type: 'string' } },
  required: ['images', 'errors'],
}
const CRITIC_SCHEMA = {
  type: 'object',
  properties: {
    scores: { type: 'object', properties: {
      lighting: { type: 'number' }, materials: { type: 'number' }, geometry: { type: 'number' }, atmosphere: { type: 'number' },
      composition: { type: 'number' }, color_grade: { type: 'number' }, ui: { type: ['number', 'null'] }, stability: { type: ['number', 'null'] } },
      required: ['lighting', 'materials', 'geometry', 'atmosphere', 'composition', 'color_grade'] },
    mean: { type: 'number' }, verdict: { type: 'string' },
    defects: { type: 'array', items: { type: 'object', properties: {
      id: { type: 'string' }, image: { type: 'string' }, where: { type: 'string' }, what: { type: 'string' },
      severity: { type: 'string', enum: ['blocker', 'major', 'minor'] }, category: { type: 'string' }, fix: { type: 'string' } },
      required: ['id', 'image', 'what', 'severity', 'category'] } },
  },
  required: ['scores', 'mean', 'defects'],
}
const AB_SCHEMA = {
  type: 'object',
  properties: { winner: { type: 'string', enum: ['A', 'B', 'tie'] }, margin: { type: 'string', enum: ['clear', 'slight', 'none'] }, why: { type: 'string' } },
  required: ['winner', 'margin', 'why'],
}
const ROUTE_SCHEMA = {
  type: 'object',
  properties: { tasks: { type: 'array', items: { type: 'object', properties: {
    module: { type: 'string' }, defects: { type: 'array', items: { type: 'string' } }, instructions: { type: 'string' } },
    required: ['module', 'defects', 'instructions'] } } },
  required: ['tasks'],
}
const RESULT_SCHEMA = {
  type: 'object',
  properties: { ok: { type: 'boolean' }, summary: { type: 'string' }, errors: { type: 'number' }, details: { type: 'string' } },
  required: ['ok', 'summary'],
}

// ---------------------------------------------------------------- helpers
const capture = (label, phaseName, build, outDir, poses, names, extra = '') => agent(
  `Capture job (mechanical). cd ${DIR}. ${build ? `First build: node build.mjs --out ${build}` : ''}
Then run: node tools/capture.mjs --url ${build || 'dist/index.html'} --out ${outDir} --poses "${posesArg(poses)}" --names ${names.join(',')} --critic --shimmer --w ${W} --h ${H} ${extra}
Return the absolute paths of every file in ${outDir}/critic/ (jpg only), the total error count, renderer string from meta.json, and any error
lines from the capture output in notes. Do not open the images. If the build fails, return errors=999 and the build error in notes.`,
  { label, phase: phaseName, schema: CAPTURE_SCHEMA, effort: 'low' })

const critic = (label, phaseName, images, focus = '') => agent(
  `Review these renders. ${focus}\nImages:\n${images.join('\n')}`,
  { label, phase: phaseName, schema: CRITIC_SCHEMA, agentType: 'onefile-critic' })

const ab = (label, phaseName, imgsA, imgsB) => agent(
  `Blind A/B comparison of two builds of the same game, same camera poses. Which set looks more like a shipped AAA game overall
(lighting, materials, atmosphere, stability, absence of defects)? Open every image.\nSET A:\n${imgsA.join('\n')}\nSET B:\n${imgsB.join('\n')}`,
  { label, phase: phaseName, schema: AB_SCHEMA, agentType: 'onefile-critic' })

const fmtDefects = (c) => c.defects.map((d) => `${d.id} [${d.severity}/${d.category}] ${d.image}: ${d.where ? d.where + ' — ' : ''}${d.what}${d.fix ? ' → ' + d.fix : ''}`).join('\n')
// Gates use the skill's own bar (BAR, from references/quality-bar.json) on drift-corrected scores. Never compared with other games.
const majors = (c) => c.defects.filter((d) => d.severity === 'major').length
const sc = (c, k) => (c.scores[k] == null ? null : c.scores[k] - OFFSET)
const gateLook = (c) => sc(c, 'lighting') >= BAR.look.minLighting && sc(c, 'atmosphere') >= BAR.look.minAtmosphere && sc(c, 'color_grade') >= BAR.look.minGrade &&
  !c.defects.some((d) => d.severity === 'blocker') &&
  c.defects.filter((d) => d.severity === 'major' && ['lighting', 'shadow', 'atmosphere', 'post', 'color'].includes(d.category)).length <= BAR.look.maxLookMajors
const gateG2 = (c) => !c.defects.some((d) => d.severity === 'blocker') && majors(c) <= BAR.g2.maxMajors &&
  Object.keys(c.scores).every((k) => c.scores[k] == null || k === 'ui' || sc(c, k) >= (k === 'geometry' ? BAR.g2.minGeometry : BAR.g2.minAxis)) &&
  c.mean - OFFSET >= BAR.g2.minMean

// ---------------------------------------------------------------- Calibrate: critic drift vs the skill's own anchors
const LIST_SCHEMA = { type: 'object', properties: { best: { type: 'array', items: { type: 'string' } }, floor: { type: 'array', items: { type: 'string' } } }, required: ['best', 'floor'] }
const calib = await agent(GUARD + `Mechanical. List absolute paths: best = ${SK}/references/calibration/best/*.jpg, floor = ${SK}/references/calibration/floor/*.jpg. Do not open them.`,
  { label: 'calib:list', phase: 'Spec', schema: LIST_SCHEMA, effort: 'low' })
let calibNote = 'no calibration set'
if (calib && calib.best.length && BAR.anchors && BAR.anchors.best && BAR.anchors.best.mean != null) {
  const cb = await critic('calib:best', 'Spec', calib.best)
  if (cb) {
    const d = cb.mean - BAR.anchors.best.mean
    OFFSET = Math.abs(d) > 0.75 ? d : 0
    calibNote = `critic on own best anchor: ${cb.mean.toFixed(2)} vs recorded ${BAR.anchors.best.mean} → offset ${OFFSET.toFixed(2)}`
    if (calib.floor.length) {
      const cf = await critic('calib:floor', 'Spec', calib.floor)
      if (cf) {
        calibNote += `; floor ${cf.mean.toFixed(2)}`
        if (cb.mean - cf.mean < 1.0) { calibNote += ' — WARNING: critic does not separate floor from best; gates unreliable'; log(calibNote) }
      }
    }
  }
}
log(calibNote)

// ================================================================ Phase 0: Spec
phase('Spec')
const spec = await agent(GUARD + `You are the LEAD DESIGNER + TECH LEAD. Turn this request into a buildable plan and a booting graybox.
GENRE: ${A.genre || '(infer from concept)'}\nCONCEPT: ${A.concept}\nBUDGET: ${A.budget || 'standard'}
Read ${SK}/references/genre-recipes.md, art-direction.md, spec-template.md, pipeline-order.md, perf-budgets.md, lessons.md, run-log.md (open skill issues from past runs: plan around them, e.g. give the owner of an affected system the listed fix).
Then in ${DIR}:
1. SPEC.md — fill spec-template.md completely (scope cap: ONE small map, 5-10 min loop, win+lose+restart; it must be finishable).
2. Pick ONE look thesis from art-direction.md that fits the concept (adapt constants); write ART.md (thesis, palette, hero shot list) and
   src/art.js (complete ART object per CONTRACT.md).
3. src/contracts.js — SEED, POSES[6] (1 establishing vista into the sun, 2 gameplay-eye at spawn, 3 hero object close-up, 4 interior or
   second biome, 5 action moment with actors/FX, 6 reverse angle AWAY from the sun), PATH (title flyover + bench), WORLD bounds, PLAYER.
   Also 2 'yaw' poses: eye height at spawn looking in directions no hero pose covers.
4. Module plan → OWNERS.md: 6-10 modules, each with exact owned files under src/modules/<name>/ (multiple files allowed), a precise brief
   (what to build, which cookbook systems, quality bar, budget from perf-budgets.md), a wave (1 = world/level/terrain/backdrop/ground/weather
   (environment), 2 = hero object/actors/AI/fx, 3 = game rules/HUD/menus/audio), whether it is visual, and a showcase pose for ?show=<name>.
   Every module exports create(G) + showcase(G) (see templates' src/modules/*.js examples) and has a stub in src/modules/_stub.js.
5. Wire src/main.js: one boot.stage per module in pipeline-order, non-critical with stub fallback, so the game boots with any subset done.
   Graybox: modules start as minimal working versions (boxes at real scale at the POSES, kit primitives) — NOT empty.
6. git add -A && git commit -m "spec + graybox". node tools/state.mjs init --name "<title>"; state phase spec; gate G1 after step 7.
7. Gate G1: node build.mjs (dist/index.html builds < 2 MB) and capture all 6 poses with 0 errors on a hardware GPU renderer. Look at them.
Return the JSON (modules list must match OWNERS.md; showcase as "x,y,z,tx,ty,tz").
${RULES}`, { label: 'lead:spec', phase: 'Spec', schema: SPEC_SCHEMA })
if (!spec) throw new Error('spec agent failed')
log(`"${spec.title}" — look: ${spec.look}; ${spec.modules.length} modules; G1 ${spec.g1 ? 'PASS' : 'FAIL'}`)
const POSES = spec.poses.slice(0, 6), YAWS = (spec.yaws || []).slice(0, 2)
const POSE_NAMES = POSES.map((_, i) => `pose-${i + 1}`), YAW_NAMES = YAWS.map((_, i) => `yaw-${i + 1}`)
const ALLP = POSES.concat(YAWS), ALLN = POSE_NAMES.concat(YAW_NAMES)

// ================================================================ Phase 1: Look lock
phase('Look')
let lookCrit = null
for (let r = 1; r <= B.look + 1; r++) {
  const prev = lookCrit ? `The blind critic reviewed the last look round. Scores ${JSON.stringify(lookCrit.scores)}. Fix these (lighting/atmosphere/post/color/material first):\n${fmtDefects(lookCrit)}` : ''
  const res = await agent(GUARD + `You are the LOOK DIRECTOR (round ${r}). Own: src/art.js, ART.md, and the look stack wiring in src/main.js (sky, env,
atmos, pcss, post params, materials defaults, weathering amounts, practical lights, far-field backdrop placeholder). Goal: the graybox at the
6 POSES must already read like an AAA screenshot in light, atmosphere and grade (the skill's own bar: ${SK}/references/quality-bar.md; anchors in references/calibration/best/).
Use cookbook systems as designed (post/pipeline, lighting/sky+env+atmos+pcss+lights, materials/library+weathering, backdrop/farfield,
ground/ if the thesis has wet ground). Change one thing at a time, A/B with captures. Pose 6 (away from the sun) must still have shape.
${prev}
Work: build to dist/look.html, capture to shots/look-r${r}-work/ as often as you need, inspect. When done: git commit -am "look r${r}".
${RULES}`, { label: `look:r${r}`, phase: 'Look', schema: RESULT_SCHEMA })
  const cap = await capture(`cap:look-r${r}`, 'Look', 'dist/look.html', `shots/look-r${r}`, ALLP, ALLN)
  if (!cap || cap.errors) { log(`look r${r}: capture errors ${cap && cap.errors}`); continue }
  lookCrit = await critic(`critic:look-r${r}`, 'Look', cap.images, 'This is an early graybox: judge LIGHTING, ATMOSPHERE, COLOR_GRADE and MATERIALS hardest; simple geometry is expected at this stage.')
  if (!lookCrit) continue
  log(`look r${r}: L${lookCrit.scores.lighting} A${lookCrit.scores.atmosphere} G${lookCrit.scores.color_grade} M${lookCrit.scores.materials} mean ${lookCrit.mean}`)
  if (gateLook(lookCrit)) break
}
await agent(GUARD + `cd ${DIR} && node tools/state.mjs phase build && node tools/state.mjs set look.locked true && git add -A && git commit -qm "look locked" || true. Reply "ok".`, { label: 'state:look', phase: 'Look', effort: 'low' })

// ================================================================ Phase 2: Module waves
phase('Modules')
const lookNote = lookCrit ? `Look is locked (critic scores ${JSON.stringify(lookCrit.scores)}). Do not change src/art.js or post/lighting wiring; ask the lead in your answer if you need to.` : ''
const waves = [...new Set(spec.modules.map((m) => m.wave))].sort()
for (const w of waves) {
  const mods = spec.modules.filter((m) => m.wave === w)
  log(`wave ${w}: ${mods.map((m) => m.name).join(', ')}`)
  await pipeline(mods,
    (m) => agent(GUARD + `You are the MODULE OWNER of "${m.name}". You own ONLY: ${m.files.join(', ')} (and new files under src/modules/${m.name}/).
BRIEF: ${m.brief}
Read SPEC.md, ART.md, OWNERS.md, src/contracts.js (read-only), the cookbook READMEs you need. ${lookNote}
Build it to the quality bar of the reference games: detailed bevelled silhouettes at real scale, baked procedural materials + weathering,
nothing floating (contact/AO), no repetition (vary colour/wear/scale), animation that reads. Implement showcase(G) so ?show=${m.name} frames it.
Verify: node build.mjs --out dist/${m.name}.html; capture ?show=${m.name} (pose ${m.showcase || 'from your showcase()'}) AND the 6 POSES;
0 errors; look at everything. Iterate at least twice on what you see. git add your files && git commit -m "${m.name}: build".
${RULES}`, { label: `own:${m.name}`, phase: 'Modules', schema: RESULT_SCHEMA }),
    async (built, m) => {
      if (!m.visual) return { m, built }
      const cap = await capture(`cap:${m.name}`, 'Modules', `dist/${m.name}.html`, `shots/mod-${m.name}`,
        [m.showcase ? m.showcase.split(',').map(Number) : POSES[0]], [`show-${m.name}`], `--query "shot=1&show=${m.name}"`)
      if (!cap || !cap.images.length) return { m, built }
      const c = await critic(`critic:${m.name}`, 'Modules', cap.images, 'This is an isolated showcase of one game system/asset; judge it as a hero asset.')
      return { m, built, c }
    },
    async (x) => {
      if (!x || !x.c || !x.c.defects.some((d) => d.severity !== 'minor')) return x
      return agent(GUARD + `You are the MODULE OWNER of "${x.m.name}" (files: ${x.m.files.join(', ')}). A blind critic reviewed your showcase
(scores ${JSON.stringify(x.c.scores)}). Fix every blocker and major, then minors if cheap:\n${fmtDefects(x.c)}
Re-capture ?show=${x.m.name} and confirm visually. git commit -am "${x.m.name}: critic fixes".
${RULES}`, { label: `fix:${x.m.name}`, phase: 'Modules', schema: RESULT_SCHEMA })
    })
}

// ================================================================ Phase 3: Integrate + playtest
phase('Integrate')
let g3 = null
for (let t = 1; t <= B.fixTries; t++) {
  g3 = await agent(GUARD + `You are the INTEGRATOR (try ${t}). Own src/main.js, src/modules/_stub.js, build config, playtest.json. Read OWNERS.md and each
module's exports (not their internals unless broken). Make the full game work: boot order, every module real (no stubs:
__stats().modules shows none stub), title → play → win and lose → restart, pause/settings, pointer-lock drag fallback.
Warm every shader permutation at boot (boot.finish({extras}) with enemy/fx/decal materials). Write playtest.json that exercises every verb
in SPEC.md and reaches BOTH the win and the lose state (use debug hooks on __G if needed, e.g. __G.game.debugWin()).
Gate G3: node build.mjs (dist/index.html) && node tools/playtest.mjs --url dist/index.html --script playtest.json --out shots/playtest
must pass with zero __errors. If a module is broken, fix the smallest thing needed and name it in details. Also run the audio self-test
if the audio module provides one. git commit -am "integrate t${t}"; node tools/state.mjs gate G3 pass|fail.
${RULES}`, { label: `integrate:t${t}`, phase: 'Integrate', schema: RESULT_SCHEMA })
  if (g3 && g3.ok) break
}
log(`G3 gameplay: ${g3 && g3.ok ? 'PASS' : 'FAIL'}`)

// ================================================================ Phase 4: Critic rounds
phase('Critic')
let best = null, bestImgs = null, lastCrit = null
const owners = spec.modules.map((m) => `${m.name}: ${m.files.join(', ')} — ${m.brief.slice(0, 160)}`).join('\n')
for (let r = 1; r <= B.rounds; r++) {
  const cap = await capture(`cap:r${r}`, 'Critic', r === 1 ? 'dist/index.html' : 'dist/index.html', `shots/round-${String(r).padStart(2, '0')}`, ALLP, ALLN)
  if (!cap || cap.errors) {
    await agent(GUARD + `The build has runtime errors in capture (${cap && cap.notes}). As INTEGRATOR fix them in ${DIR}, rebuild dist/index.html, recapture to verify 0 errors. git commit -am "fix errors r${r}".\n${RULES}`, { label: `errfix:r${r}`, phase: 'Critic', schema: RESULT_SCHEMA })
    continue
  }
  const c = await critic(`critic:r${r}`, 'Critic', cap.images)
  if (!c) continue
  log(`round ${r}: mean ${c.mean} ${JSON.stringify(c.scores)}; ${c.defects.filter((d) => d.severity !== 'minor').length} blocker/major`)

  // regression guard: blind pairwise A/B vs the best build so far (absolute scores are too noisy for this)
  if (best && bestImgs) {
    const flip = r % 2 === 0 // vary presentation order without randomness
    const v = await ab(`ab:r${r}`, 'Critic', flip ? cap.images : bestImgs, flip ? bestImgs : cap.images)
    const candWins = v && ((flip && v.winner === 'A') || (!flip && v.winner === 'B'))
    const bestWins = v && v.margin === 'clear' && !candWins && v.winner !== 'tie'
    if (bestWins) {
      log(`round ${r}: candidate clearly worse than best (r${best.round}) — reverting fixes`)
      await agent(GUARD + `cd ${DIR}. Revert the source to git tag best (git checkout best -- src && node build.mjs && git commit -am "revert to best after r${r}" ). Reply "ok".`, { label: `revert:r${r}`, phase: 'Critic', effort: 'low' })
      // keep routing the best build's defects next round
    } else {
      best = { round: r, crit: c }; bestImgs = cap.images
      await agent(GUARD + `cd ${DIR} && git tag -f best && node tools/state.mjs score ${c.mean} --shots shots/round-${String(r).padStart(2, '0')} --build dist/index.html. Reply "ok".`, { label: `tag:r${r}`, phase: 'Critic', effort: 'low' })
    }
  } else {
    best = { round: r, crit: c }; bestImgs = cap.images
    await agent(GUARD + `cd ${DIR} && git add -A && git commit -qm "round ${r} capture" ; git tag -f best && node tools/state.mjs score ${c.mean} --shots shots/round-01 --build dist/index.html. Reply "ok".`, { label: `tag:r${r}`, phase: 'Critic', effort: 'low' })
  }
  lastCrit = best.crit
  if (gateG2(lastCrit)) { log(`G2 visual PASS at round ${best.round}`); break }
  if (r === B.rounds) break

  const route = await agent(GUARD + `You are the LEAD. Route blind-critic defects to module owners. Modules and owned files:\n${owners}
Also available pseudo-module "look" (src/art.js, post/lighting params in main.js) and "integrator" (main.js wiring).
Defects (from the best build, round ${best.round}):\n${fmtDefects(lastCrit)}
Group defects per module (one task per module, most severe first; every blocker/major must be routed; minors only if cheap). For each, write
precise visual instructions: what is wrong in which pose and what the fix should achieve, with the cookbook system likely involved
(see ${SK}/references/defect-catalogue.md). Read OWNERS.md and src/contracts.js if needed. Do not edit files.`, { label: `route:r${r}`, phase: 'Critic', schema: ROUTE_SCHEMA })
  if (!route || !route.tasks.length) continue
  await parallel(route.tasks.map((t) => () => agent(GUARD + `You are the owner of "${t.module}" (see OWNERS.md for your files; "look" owns src/art.js +
post/lighting params; "integrator" owns main.js). Fix these blind-critic defects (round ${r}):\n${t.defects.join('\n')}\nLEAD NOTES: ${t.instructions}
Verify with your own build (dist/${t.module}.html) and captures of the affected poses (POSES in src/contracts.js). Look at the results.
Commit only your files: git add <your files> && git commit -m "${t.module}: r${r} fixes".
${RULES}`, { label: `fix:${t.module}:r${r}`, phase: 'Critic', schema: RESULT_SCHEMA })))
  await agent(GUARD + `You are the INTEGRATOR. cd ${DIR}. Rebuild dist/index.html (node build.mjs), run node tools/playtest.mjs --url dist/index.html --script playtest.json --out shots/playtest-r${r};
fix any breakage introduced by this round's parallel fixes (smallest change). git add -A && git commit -qm "round ${r} fixes integrated".
${RULES}`, { label: `integrate:r${r}`, phase: 'Critic', schema: RESULT_SCHEMA })
}

// ================================================================ Phase 5: Perf
phase('Perf')
const perf = await agent(GUARD + `You are the PERF ENGINEER. cd ${DIR}. Make sure the source equals git tag best (git checkout best -- src; node build.mjs).
Read ${SK}/references/perf-budgets.md. Run (background, nothing else on the GPU):
  node tools/bench.mjs --url dist/index.html --dynres 0 --q high --w 1920 --h 1080 --out bench-high.json
  node tools/bench.mjs --url dist/index.html --q auto --w 2560 --h 1440 --out bench-auto.json
Gate G4 (vsync off): high avg ≤ 12.5 ms, p99 ≤ 20 ms, max ≤ 33 ms after warm-up; auto: mean scale ≥ 0.8, no tier change; calls ≤ 500,
tris ≤ 3M, boot ≤ 10 s. If it fails, fix in this order: per-tier shader permutations → half-res passes → shadow update rate →
merge/instance → LOD fades — never by degrading what shows at the hero poses. Re-bench. Capture the 6 POSES afterwards and confirm
visually nothing degraded. git commit -am "perf"; git tag -f best; node tools/state.mjs gate G4 pass|fail. Put the bench tables in details.
${RULES}`, { label: 'perf', phase: 'Perf', schema: RESULT_SCHEMA })
const capF = await capture('cap:final', 'Perf', 'dist/index.html', 'shots/final', ALLP, ALLN)
const finalCrit = capF && !capF.errors ? await critic('critic:final', 'Perf', capF.images) : null
if (finalCrit && bestImgs && best) {
  const v = await ab('ab:final', 'Perf', bestImgs, capF.images)
  if (v && v.winner === 'A' && v.margin === 'clear') {
    log('perf changes clearly hurt the look — reverting perf commit')
    await agent(GUARD + `cd ${DIR}. The perf pass made the look clearly worse. git revert --no-edit HEAD, rebuild dist/index.html, report which perf changes were lost. Reply with a summary.`, { label: 'revert:perf', phase: 'Perf' })
  }
}

// ================================================================ Phase 6: Ship
phase('Ship')
const fc = finalCrit || (best && best.crit)
const ship = await agent(GUARD + `You are the LEAD shipping the game. cd ${DIR}. node build.mjs (dist/index.html) and node tools/size-report.mjs dist/index.html.
Compose REPORT.md (do NOT write it; return it as text — the lead saves it): title, how to play, size (raw/gz), gates (G1 ${spec.g1 ? 'pass' : 'fail'}, G2 ${fc && gateG2(fc) ? 'pass' : 'fail'},
G3 ${g3 && g3.ok ? 'pass' : 'fail'}, G4 ${perf && perf.ok ? 'pass' : 'fail'}), perf tables (bench-*.json), final blind-critic scores
${fc ? JSON.stringify(fc.scores) + ' mean ' + fc.mean : '(none)'} and open defects:\n${fc ? fmtDefects(fc) : ''}
plus the list of best screenshots (shots/final/*.png). Be honest: if a gate failed, say so and why. node tools/state.mjs phase done.
git add -A && git commit -qm "ship". Return the REPORT.md text as summary. Quote gate thresholds exactly as references/critic-rubric.md §7 states them.
${RULES}`, { label: 'ship', phase: 'Ship', schema: RESULT_SCHEMA })

// ================================================================ Phase 7: Reflect
// Not blind: the lead looks at its own final shots next to the reference games, reads the run's evidence and says
// honestly where it landed, what in the SKILL (not the game) got in the way, and what to do next.
phase('Reflect')
// Own-best check: blind A/B of the final frames against the best frames this skill has ever shipped.
const vsBest = capF && !capF.errors && calib && calib.best.length ? await ab('ab:own-best', 'Reflect', calib.best, capF.images.filter((p) => !/crop|shimmer/.test(p))) : null
const beatBest = !vsBest ? 'n/a' : vsBest.winner === 'B' ? (vsBest.margin === 'clear' ? 'win-clear' : 'win') : vsBest.winner === 'tie' ? 'tie' : 'lose'
const REFLECT_SCHEMA = {
  type: 'object',
  properties: {
    verdict: { type: 'string', description: '2-4 sentences: where this build lands on the skill\'s own bar and history, on what evidence' },
    vs_bar: { type: 'string', description: 'per axis: drift-corrected score vs the bar, what in the frames holds each axis down (cite rubric §2 anchors)' },
    vs_own_best: { type: 'string', description: 'final frames vs references/calibration/best (the skill\'s best ever): better / worse where, and the blind A/B result' },
    intent: { type: 'string', description: 'does the frame deliver the mood and signature surface promised in SPEC.md / ART.md? what is missing' },
    strengths: { type: 'array', items: { type: 'string' } },
    weaknesses: { type: 'array', items: { type: 'string' }, description: 'what a player sees first, most visible first; cite pose/defect ids' },
    skill_issues: { type: 'array', items: { type: 'object', properties: {
      issue: { type: 'string' }, evidence: { type: 'string' }, file: { type: 'string', description: 'skill file to change (cookbook/, templates/, workflows/, references/)' },
      fix: { type: 'string' } }, required: ['issue', 'evidence', 'fix'] },
      description: 'problems in the SKILL this run exposed: cookbook gaps, misleading prompts, tooling failures, wasted rounds, a critic that does not discriminate. Not game defects.' },
    next_steps: { type: 'array', items: { type: 'object', properties: {
      action: { type: 'string' }, why: { type: 'string' }, targets: { type: 'string', description: 'defect ids / gates / axes it moves' },
      cost: { type: 'string', description: 'rough agents/tokens/hours' }, kind: { type: 'string', enum: ['polish', 'perf', 'skill-fix', 'new-test', 'ship'] } },
      required: ['action', 'why', 'cost', 'kind'] }, description: 'ranked, highest value per cost first, 2-5 items' },
  },
  required: ['verdict', 'vs_bar', 'vs_own_best', 'intent', 'strengths', 'weaknesses', 'skill_issues', 'next_steps'],
}
const reflect = await agent(GUARD + `You are the LEAD doing an honest end-of-run self-review of ${spec.title} (${A.genre}: ${A.concept}). cd ${DIR}. Read only; change nothing.
Judge ONLY by this skill's own standard. Do not compare with, name or look up any other game.
Evidence to use (all of it):
- LOOK YOURSELF (Read the images): shots/final/critic/pose-*.jpg and yaw-*.jpg; then the skill's own best-ever frames: ${calib && calib.best.length ? calib.best.join(', ') : '(none yet)'}.
- The bar: ${JSON.stringify(BAR.g2)} (look ${JSON.stringify(BAR.look)}), anchors ${JSON.stringify(BAR.anchors || {})}, history ${JSON.stringify(BAR.history || [])}.
  Per-axis anchors: ${SK}/references/critic-rubric.md §2. Calibration: ${calibNote}.
- Gates: G1 ${spec.g1 ? 'pass' : 'fail'}, G2 ${fc && gateG2(fc) ? 'pass' : 'fail'}, G3 ${g3 && g3.ok ? 'pass' : 'fail'}, G4 ${perf && perf.ok ? 'pass' : 'fail'}.
- Final critic (raw; subtract offset ${OFFSET.toFixed(2)}): ${fc ? JSON.stringify(fc.scores) + ' mean ' + fc.mean : '(none)'}; open defects:\n${fc ? fmtDefects(fc) : '(none)'}
- Blind A/B vs the skill's own best: ${vsBest ? beatBest + ' — ' + vsBest.why : 'not run'}.
- Intent: SPEC.md and ART.md (the promised mood and signature surface).
- Run history: node tools/state.mjs show, git log --oneline, bench-*.json, shots/round-*/ (did rounds improve or churn?).
- The ship report:\n${ship && ship.summary ? ship.summary.slice(0, 6000) : '(missing)'}
Write as a candid senior reviewer, not a salesman. skill_issues = what in the skill (${SK}) made this harder; name the file and the concrete fix.
next_steps = 2-5 ranked actions with honest cost: targeted polish rounds on the top visible defects / lowest axes; perf fixes for G4;
skill fixes; a test game in a very different genre to check the skill generalises.`,
  { label: 'reflect', phase: 'Reflect', schema: REFLECT_SCHEMA })

return {
  title: spec.title, look: spec.look, dir: DIR,
  gates: { G1: spec.g1, G2: !!(fc && gateG2(fc)), G3: !!(g3 && g3.ok), G4: !!(perf && perf.ok) },
  final: fc ? { scores: fc.scores, mean: fc.mean, open: fc.defects.length } : null,
  report: ship && ship.summary,
  reflection: reflect,
  quality: { offset: OFFSET, calibration: calibNote, beatBest, bar: BAR.g2 },
}
