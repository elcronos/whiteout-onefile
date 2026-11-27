#!/usr/bin/env node
// Perf gate (G4): real-GPU Chrome with vsync and the frame-rate limit OFF, fly the #bench path, report frame stats.
//   node bench.mjs --url dist/index.html [--seconds 20] [--q high] [--dynres 0] [--w 1920 --h 1080] [--warm 5000]
//                  [--query "seed=4207"] [--out bench.json] [--gate "avg<=12.5,p99<=20,max<=33"] [--vsync]
// Uses __G.bench() (engine/bench.js, flies G.PATH). Without it, falls back to an in-page fly through __G.PATH or
// POSES via __setCam, timing rAF itself. Reports avg/p50/p95/p99/max ms, fps, mean/min dynres scale, tier
// start→end, max draw calls/tris, errors, renderer. Exit 1 if a --gate fails, errors occurred, or the renderer is software.
// Default query: q=high&dynres=0&autostart=1 (gate a). Gate b (defaults: auto tier + dynres): --q auto.
import { writeFileSync } from 'node:fs';
import { parseArgs, openTarget, launchChrome, withQuery, waitReady, isSoftware } from './_browser.mjs';

const A = parseArgs();
if (!A.url) { console.error('usage: bench.mjs --url <file|http> [--seconds 20] [--q high] [--dynres 0] [--gate "p99<=20"]'); process.exit(1); }
const W = +(A.w || 1920), H = +(A.h || 1080), secs = +(A.seconds || 20), warm = +(A.warm || 5000);
const q = new URLSearchParams(A.query || '');
if ((A.q || 'high') !== 'auto') q.set('q', A.q || 'high');
// --q auto = the player's default experience: tier detection AND dynres on (unless --dynres 0 is given explicitly).
// (Before, --q auto silently ran with dynres=0, so the auto controller could never be measured.)
if (A.dynres !== undefined) q.set('dynres', String(A.dynres)); else if ((A.q || 'high') !== 'auto') q.set('dynres', '0');
if (!q.has('autostart') && !q.has('shot')) q.set('autostart', '1');

const target = await openTarget(A.url);
const { browser, page, logs } = await launchChrome({ w: W, h: H, uncapped: !A.vsync });
const t0 = Date.now();
await page.goto(withQuery(target.url, q.toString()));
const ready = await waitReady(page);
const bootMs = Date.now() - t0;
if (!ready.ok) console.error('[bench] ' + ready.why);
await page.waitForTimeout(warm); // let adaptation, lazy bakes and dynres settle (dynres ignores the first 5 s anyway)

const rep = await page.evaluate(async (secs) => {
  if (window.__G && typeof window.__G.bench === 'function') return await window.__G.bench({ seconds: secs });
  // fallback: fly PATH/POSES with __setCam, time rAF
  const P = (window.__G && (window.__G.PATH || window.__G.POSES)) || null;
  if (!P || !window.__setCam) return { error: 'page has neither __G.bench nor __G.PATH/POSES + __setCam' };
  const ms = []; let last = 0; const tEnd = performance.now() + secs * 1000; const T0 = performance.now();
  await new Promise((res) => {
    const f = (now) => {
      const u = Math.min(0.9999, (now - T0) / (secs * 1000)) * (P.length - 1), i = Math.floor(u), k = u - i;
      const a = P[i], b = P[Math.min(P.length - 1, i + 1)], L = (j) => a[j] + (b[j] - a[j]) * k;
      window.__setCam([L(0), L(1), L(2)], [L(3), L(4), L(5)]);
      if (last) ms.push(now - last); last = now;
      if (now < tEnd) requestAnimationFrame(f); else res();
    };
    requestAnimationFrame(f);
  });
  const s = ms.slice().sort((x, y) => x - y), n = s.length, qq = (f) => +s[Math.min(n - 1, Math.floor(f * (n - 1)))].toFixed(2);
  const avg = ms.reduce((x, y) => x + y, 0) / n, st = window.__stats ? window.__stats() : {};
  return { avg: +avg.toFixed(2), p50: qq(0.5), p95: qq(0.95), p99: qq(0.99), max: +s[n - 1].toFixed(2), fps: +(1000 / avg).toFixed(1), frames: n,
    seconds: secs, scale: st.scale, tier: st.tier, tierEnd: st.tier, calls: st.calls, tris: st.tris, errors: (window.__errors || []).slice(0, 10), renderer: st.renderer, fallback: true };
}, secs);
const extra = await page.evaluate(() => ({ stats: window.__stats ? window.__stats() : null, errors: (window.__errors || []).slice(0, 20) }));
await browser.close(); await target.close();

const report = { url: A.url, query: q.toString(), size: [W, H], vsync: !!A.vsync, bootMs, ...rep, allErrors: extra.errors, modules: extra.stats?.modules, logs: logs.slice(-20) };
report.software = isSoftware(report.renderer);
const fails = [];
if (rep.error) fails.push(rep.error);
if (!ready.ok) fails.push(ready.why);
if (report.software) fails.push('software renderer: numbers are meaningless');
if (extra.errors.length) fails.push(`${extra.errors.length} page errors`);
if (rep.tier && rep.tierEnd && rep.tier !== rep.tierEnd) fails.push(`tier changed during bench ${rep.tier}→${rep.tierEnd}`);
for (const g of String(A.gate || '').split(',').filter(Boolean)) {
  const m = g.match(/^\s*(\w+)\s*(<=|>=|<|>)\s*([\d.]+)\s*$/); if (!m) { fails.push('bad gate ' + g); continue; }
  const v = report[m[1]], lim = +m[3];
  const ok = m[2] === '<=' ? v <= lim : m[2] === '>=' ? v >= lim : m[2] === '<' ? v < lim : v > lim;
  if (!ok) fails.push(`gate ${m[1]}=${v} fails ${m[2]}${lim}`);
}
report.pass = fails.length === 0; report.fails = fails;
if (A.out) writeFileSync(A.out, JSON.stringify(report, null, 2));
const f = (v) => (v === undefined ? '—' : v);
console.log(`bench ${W}x${H} ${report.query}  vsync ${report.vsync ? 'on' : 'off'}  boot ${bootMs} ms`);
console.log(`  avg ${f(rep.avg)} ms  p50 ${f(rep.p50)}  p95 ${f(rep.p95)}  p99 ${f(rep.p99)}  max ${f(rep.max)}  (${f(rep.fps)} fps, ${f(rep.frames)} frames)`);
console.log(`  scale ${f(rep.scale)} (min ${f(rep.scaleMin)})  tier ${f(rep.tier)}→${f(rep.tierEnd)}  calls ${f(rep.calls)}  tris ${f(rep.tris)}`);
console.log(`  renderer ${f(report.renderer)}${report.software ? '  (SOFTWARE)' : ''}`);
console.log(report.pass ? 'PASS' : 'FAIL: ' + fails.join('; '));
process.exit(report.pass ? 0 : 1);
