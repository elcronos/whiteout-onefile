// Input: keyboard action map, pointer lock with automatic drag fallback, gamepad, touch twin-stick, and a
// programmatic API for bots/playtests. One object, exposed as window.__input and G.input.
//
//   const input = createInput(G, { root: uiRoot });   // create FIRST so its update runs before consumers
//   G.on('update', () => {
//     yaw -= input.lookX; pitch -= input.lookY;         // radians this frame (mouse, stick, touch, bot)
//     move.set(input.move.x, input.move.y);             // x strafe (+right), y forward (+fwd), |v| <= 1
//     if (input.pressed('jump')) ...; if (input.down('fire')) ...;
//   });
//   // bots (tools/playtest.mjs): __input.look(dx,dy)  __input.hold('forward', 800)  __input.press('jump')
//
// Modes (input.mode): 'lock' (pointer lock), 'drag' (lock API missing or refused 3 times in a row: hold a mouse button
// and drag; a banner explains it once), 'touch' (first touch switches; twin-stick + buttons), 'pad' (last input was a gamepad).
// Pointer lock: requested synchronously from the gesture (click / Enter); { unadjustedMovement } first, plain on
// NotSupported (Linux, some Wayland compositors) and remembered; a refused or timed-out request is NOT permanent: a
// "click to capture" hint shows ('input:lockfail') and the next click retries. A lock that was held and is lost
// (Esc, alt-tab) emits 'input:unlock' so the game pauses with "click to resume". While unlocked in lock
// mode raw mouse motion never steers; movementX/Y spikes (lock (re)acquisition, compositor warps) are dropped.
// The canvas hides the cursor while input is enabled (in play; opts.hideCursor, off when lockOnClick is false). Mouse buttons use mousedown/up (pointer events fold
// chorded presses such as LMB-then-RMB into pointermove, which lost turbo / stuck fire).
// All values are latched once per frame on G 'preupdate' (before every 'update' listener), so creation order does not matter.
import { Vector2 } from 'three';

export const DEFAULT_BINDINGS = {
  forward: ['KeyW', 'ArrowUp'], back: ['KeyS', 'ArrowDown'], left: ['KeyA', 'ArrowLeft'], right: ['KeyD', 'ArrowRight'],
  jump: ['Space'], crouch: ['KeyC', 'ControlLeft'], sprint: ['ShiftLeft', 'ShiftRight'], interact: ['KeyE', 'KeyF'],
  reload: ['KeyR'], fire: ['Mouse0'], aim: ['Mouse2'], pause: ['Escape', 'KeyP'], map: ['Tab', 'KeyM'],
};
// Standard-mapping gamepad buttons → actions. Axes: 0/1 left stick (move), 2/3 right stick (look).
export const DEFAULT_PAD = { jump: 0, crouch: 1, reload: 2, interact: 3, aim: 6, fire: 7, sprint: 10, pause: 9, map: 8 };

export function createInput(G, opts = {}) {
  const {
    bindings = DEFAULT_BINDINGS, pad = DEFAULT_PAD,
    sens = 0.0022,            // rad per mouse pixel (≈ CS-style 2.0 at 800 dpi)
    padSens = 3.2,            // rad/s at full right-stick deflection
    touchSens = 0.005,        // rad per touch pixel
    deadzone = 0.15, invertY = false,
    lockOnClick = true,       // click on canvas requests pointer lock
    root = document.body,     // where banner / touch controls go (they carry class 'ui' so html.shot hides them)
    touchButtons = ['jump', 'fire', 'interact'],
    target = G.canvas,
    dragStyle = 'hover',      // drag-mode look: 'hover' = plain mouse motion turns, resting at a screen edge keeps
                              // turning (fire/aim clicks stay free); 'button' = only while a mouse button is held
                              // (that button still fires its action)
    hideCursor = lockOnClick, // hide the canvas cursor in play; false for cursor-driven games (RTS, point-and-click)
    spikePx = 100,            // look-spike filter: px per ms since the last move event (floor 400 px); 0 = off
    edgeRate = 1.6,
    alwaysOn = ['pause'],     // actions that still latch while input.enabled = false (menus must be able to resume)           // rad/s yaw while the cursor rests in the outer 5% (hover style)
  } = opts;
  const actions = Object.keys(bindings);
  const always = new Set(alwaysOn);
  const codeToActions = new Map();
  for (const a of actions) for (const c of bindings[a]) { if (!codeToActions.has(c)) codeToActions.set(c, []); codeToActions.get(c).push(a); }

  // per-action state: raw sources OR'd together, latched each frame
  const pressQ = Object.create(null), raw = Object.create(null), cur = Object.create(null), prev = Object.create(null), holdUntil = Object.create(null);
  for (const a of actions) { raw[a] = 0; cur[a] = false; prev[a] = false; holdUntil[a] = -1; pressQ[a] = false; }
  const ensure = (a) => { if (!(a in raw)) { raw[a] = 0; pressQ[a] = false; cur[a] = false; prev[a] = false; holdUntil[a] = -1; actions.push(a); } };
  const keysDown = new Set();
  let accX = 0, accY = 0;           // pending look in radians
  let botMoveX = 0, botMoveY = 0, botMoveUntil = -1;
  let touchMoveX = 0, touchMoveY = 0, touchLookX = 0, touchLookY = 0;

  const I = {
    mode: 'lock', locked: false, lockFailed: false,
    lookX: 0, lookY: 0, move: new Vector2(), sens, invertY, enabled: true,
    down: (a) => !!cur[a], pressed: (a) => !!cur[a] && !prev[a], released: (a) => !cur[a] && !!prev[a],
  };
  const setRaw = (a, bit, on) => { ensure(a); raw[a] = on ? raw[a] | bit : raw[a] & ~bit; };
  const KEY = 1, MOUSE = 2, PAD = 4, TOUCH = 8;

  // ---- keyboard ----
  const onKey = (down) => (e) => {
    if (e.repeat) return;
    const list = codeToActions.get(e.code);
    if (down) keysDown.add(e.code); else keysDown.delete(e.code);
    if (!list) return;
    if (list.includes('map') || (I.locked && e.code === 'Space')) e.preventDefault();
    if (down && e.code === 'Escape' && performance.now() - unlockAt < 300) return; // the Esc that just ended the lock
    let on = false;
    for (const a of list) { on = false; for (const c of bindings[a]) if (keysDown.has(c)) on = true; setRaw(a, KEY, on); }
  };
  const kd = onKey(true), ku = onKey(false);
  addEventListener('keydown', kd); addEventListener('keyup', ku);
  const blur = () => { keysDown.clear(); for (const a of actions) raw[a] &= ~(KEY | MOUSE); dragging = false; };
  addEventListener('blur', blur);

  // ---- mouse: pointer lock, drag fallback ----
  let dragging = false, lastX = 0, lastY = 0, hasLast = false, curX = -1, curY = -1, inside = false, lockPending = 0;
  let noUnadjusted = false, lockFails = 0, lockAt = 0, unlockAt = 0, lockSeq = 0, cursorHidden = false;
  const SETTLE = 60;   // ms after a lock change: movement in this window is the (re)acquisition jump, not a flick
  let moveAt = 0;      // time of the previous locked move event (the spike limit scales with the gap)
  const onLeave = () => { inside = false; hasLast = false; };
  document.addEventListener('mouseleave', onLeave);
  const mouseAct = (btn, on) => { const l = codeToActions.get('Mouse' + btn); if (l) for (const a of l) setRaw(a, MOUSE, on); };
  // a failed request: retry on the next click; only a missing API or 3 refusals in a row fall back to drag mode
  let gesture = true, legacyReq = false;                                  // was the pending request made inside a user gesture?
  const lockFail = (why, seq) => {
    if (seq !== lockSeq || I.locked) return;          // stale (a newer request is in flight) or it locked after all
    lockPending = 0; I.lockReason = why;
    if (!gesture) return;                              // scripted start (?autostart, bots): stay unlocked, the next click locks
    lockFails++;
    if (lockFails >= 3) { toDrag(why); return; }
    // never captured: no pause (nothing was lost), a hint instead; the free cursor shows and does not steer, and the
    // next click on the canvas retries. Only a lock that was held and then lost emits 'input:unlock' (→ pause screen).
    showBanner('Click to capture the mouse', 'Mouse look needs pointer lock · the cursor will not steer until then', 4000);
    G.emit('input:lockfail', why);
  };
  const requestLock = () => {
    if (I.locked) return;
    if (!target.requestPointerLock) return toDrag('unsupported');
    if (I.lockFailed) return;                          // permanent drag mode: clicks drag, no retry storm
    const seq = ++lockSeq;
    lockPending = performance.now();
    const ua = navigator.userActivation; gesture = ua ? ua.isActive : true;
    legacyReq = false;
    const plain = () => {
      try { const p2 = target.requestPointerLock(); legacyReq = !(p2 && p2.catch); if (p2 && p2.catch) p2.catch((e) => lockFail(e && e.name || 'refused', seq)); }
      catch (e) { lockFail('threw', seq); }
    };
    if (noUnadjusted) plain();
    else {
      try {
        const p = target.requestPointerLock({ unadjustedMovement: true });
        if (p && p.catch) p.catch((e) => {
          // raw input unsupported (Linux / Wayland): plain lock, still inside the click's transient activation
          if (e && e.name === 'NotSupportedError') { noUnadjusted = true; if (seq === lockSeq && !I.locked) plain(); }
          else lockFail(e && e.name || 'refused', seq);
        });
        else if (!p) { noUnadjusted = true; legacyReq = true; } // pre-promise browsers ignore the options object
      } catch (e) { noUnadjusted = true; plain(); }
    }
    // some embedders (iframes without allow-pointer-lock, automation) neither lock nor error: time out
    setTimeout(() => { if (seq === lockSeq && !I.locked && lockPending) lockFail('timeout', seq); }, 1500);
  };
  let touchAt = -1e9;                                  // mouse events synthesised from touch are ignored
  let btns = 0;                                        // mouse buttons held (bitmask, from mousedown/up)
  const onDown = (e) => {
    if (!I.enabled || performance.now() - touchAt < 800) return;
    if (I.mode === 'touch' || I.mode === 'pad') I.mode = I.lockFailed ? 'drag' : 'lock';
    if (I.mode === 'lock' && !I.locked && lockOnClick) { requestLock(); return; } // this click only captures the mouse
    btns |= 1 << e.button;
    if (I.mode === 'drag') { dragging = true; lastX = e.clientX; lastY = e.clientY; hasLast = true; }
    mouseAct(e.button, true);
  };
  const onUp = (e) => { btns &= ~(1 << e.button); if (!btns) dragging = false; mouseAct(e.button, false); };
  const onMove = (e) => {
    if (e.pointerType === 'touch' || !I.enabled) return;
    if (I.locked) {
      const mx = e.movementX || 0, my = e.movementY || 0, now = performance.now();
      // browsers deliver ONE pointermove per frame (movementX = the sum since the last one), so the limit follows the
      // gap: a fixed px cap would eat ordinary turns at low frame rates and fast flicks on high-DPI mice
      const lim = spikePx > 0 ? Math.max(400, spikePx * Math.min(250, now - moveAt)) : Infinity;
      moveAt = now;
      if (now - lockAt > SETTLE && Math.abs(mx) < lim && Math.abs(my) < lim) { accX += mx * I.sens; accY += my * I.sens; }
    } else if (I.mode === 'drag' && (dragging || dragStyle === 'hover')) {
      if (hasLast) { accX += (e.clientX - lastX) * I.sens; accY += (e.clientY - lastY) * I.sens; }
      lastX = e.clientX; lastY = e.clientY; hasLast = true;
    }                                                  // lock mode but not locked: a free cursor never steers
    curX = e.clientX; curY = e.clientY; inside = true;
  };
  target.addEventListener('mousedown', onDown);
  addEventListener('mouseup', onUp);
  addEventListener('pointermove', onMove);
  target.addEventListener('contextmenu', (e) => e.preventDefault());
  const onLockChange = () => {
    const was = I.locked;
    I.locked = document.pointerLockElement === target;
    if (I.locked) { lockPending = 0; lockFails = 0; lockAt = performance.now(); I.mode = 'lock'; I.lockFailed = false; hideBanner(); }
    else if (was) {
      unlockAt = performance.now(); btns = 0; dragging = false;
      for (const a of actions) raw[a] &= ~MOUSE;
      // Esc released the lock: that same Esc must not also toggle the pause the game is about to show
      if (raw.pause) raw.pause &= ~KEY; pressQ.pause = false;
      G.emit('input:unlock', 'exit');                  // games pause here and show "click to resume"
    }
  };
  // the promise rejection carries the reason; this event also fires for legacy (promise-less) implementations
  // (with promises it also fires for the unadjustedMovement refusal we retry from, so it is ignored there)
  const onLockError = () => { if (lockPending && legacyReq) lockFail('pointerlockerror', lockSeq); };
  document.addEventListener('pointerlockchange', onLockChange);
  document.addEventListener('pointerlockerror', onLockError);

  // ---- banner (drag mode explanation, shown once per session) ----
  let banner = null, bannerShown = false;
  function toDrag(why) {
    lockPending = 0;
    if (I.locked) return;
    I.lockFailed = true; I.mode = 'drag'; I.lockReason = why;
    if (bannerShown) return;
    bannerShown = true;
    showBanner('Mouse capture unavailable', dragStyle === 'hover' ? 'Move the mouse to look · rest it at a screen edge to keep turning' : 'Hold a mouse button and drag to look', 6000);
    G.emit('input:drag', why);
  }
  function showBanner(head, body, ms) {
    if (G.params.get('shot')) return;
    if (banner) { banner.remove(); banner = null; }
    banner = document.createElement('div');
    banner.className = 'ui input-banner';
    banner.innerHTML = '<b></b><span></span>'; banner.firstChild.textContent = head; banner.lastChild.textContent = body;
    banner.style.cssText = 'position:fixed;left:50%;bottom:12%;transform:translateX(-50%);display:flex;flex-direction:column;gap:4px;align-items:center;padding:10px 18px;background:rgba(8,10,14,.78);color:#e9e4da;font:500 12px/1.3 system-ui,sans-serif;letter-spacing:.08em;border:1px solid rgba(255,255,255,.14);border-radius:3px;pointer-events:none;z-index:50;transition:opacity .6s';
    banner.firstChild.style.cssText = 'font-weight:700;letter-spacing:.16em;text-transform:uppercase;color:#ffcf8a';
    root.appendChild(banner);
    const b = banner; setTimeout(() => { if (banner === b) hideBanner(); }, ms);
  }
  function hideBanner() { if (!banner) return; const b = banner; banner = null; b.style.opacity = '0'; setTimeout(() => b.remove(), 700); }

  // ---- touch twin-stick: left half = move stick (appears where the thumb lands), right half = look drag ----
  let touchUI = null; const touches = new Map(); // id -> {kind:'move'|'look', x0,y0,x,y}
  const STICK_R = 56;
  function buildTouchUI() {
    if (touchUI) return;
    touchUI = document.createElement('div');
    touchUI.className = 'ui touch-ui';
    touchUI.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:40';
    const base = document.createElement('div'), knob = document.createElement('div');
    base.style.cssText = `position:fixed;width:${STICK_R * 2}px;height:${STICK_R * 2}px;margin:-${STICK_R}px 0 0 -${STICK_R}px;border-radius:50%;border:2px solid rgba(255,255,255,.25);background:rgba(0,0,0,.18);display:none`;
    knob.style.cssText = 'position:fixed;width:48px;height:48px;margin:-24px 0 0 -24px;border-radius:50%;background:rgba(255,255,255,.35);display:none';
    touchUI.append(base, knob); touchUI._base = base; touchUI._knob = knob;
    touchButtons.forEach((a, i) => {
      const b = document.createElement('div');
      b.textContent = a.toUpperCase(); b.dataset.action = a;
      b.style.cssText = `position:fixed;right:${24 + (i % 2) * 84}px;bottom:${28 + Math.floor(i / 2) * 84 + (i % 2) * 40}px;width:68px;height:68px;border-radius:50%;display:flex;align-items:center;justify-content:center;font:700 10px system-ui;letter-spacing:.1em;color:#fff;background:rgba(0,0,0,.28);border:2px solid rgba(255,255,255,.28);pointer-events:auto;touch-action:none;user-select:none`;
      b.addEventListener('pointerdown', (e) => { e.stopPropagation(); setRaw(a, TOUCH, true); b.setPointerCapture(e.pointerId); });
      b.addEventListener('pointerup', () => setRaw(a, TOUCH, false));
      b.addEventListener('pointercancel', () => setRaw(a, TOUCH, false));
      touchUI.appendChild(b);
    });
    root.appendChild(touchUI);
  }
  const onTouchDown = (e) => {
    if (e.pointerType === 'touch') touchAt = performance.now();
    if (e.pointerType !== 'touch' || !I.enabled) return;
    I.mode = 'touch'; buildTouchUI(); e.preventDefault();
    const kind = e.clientX < innerWidth * 0.45 && ![...touches.values()].some((t) => t.kind === 'move') ? 'move' : 'look';
    touches.set(e.pointerId, { kind, x0: e.clientX, y0: e.clientY, x: e.clientX, y: e.clientY });
    if (kind === 'move') { const s = touchUI._base.style, k = touchUI._knob.style; s.display = k.display = 'block'; s.left = k.left = e.clientX + 'px'; s.top = k.top = e.clientY + 'px'; }
  };
  const onTouchMove = (e) => {
    const t = touches.get(e.pointerId); if (!t) return;
    if (t.kind === 'look') { touchLookX += (e.clientX - t.x) * touchSens; touchLookY += (e.clientY - t.y) * touchSens; }
    t.x = e.clientX; t.y = e.clientY;
    if (t.kind === 'move') {
      let dx = (t.x - t.x0) / STICK_R, dy = (t.y - t.y0) / STICK_R; const l = Math.hypot(dx, dy);
      if (l > 1) { dx /= l; dy /= l; }
      touchMoveX = dx; touchMoveY = -dy;
      touchUI._knob.style.left = t.x0 + dx * STICK_R + 'px'; touchUI._knob.style.top = t.y0 + dy * STICK_R + 'px';
      setRaw('sprint', TOUCH, l > 1.35); // push past the rim to sprint
    }
  };
  const onTouchUp = (e) => {
    const t = touches.get(e.pointerId); if (!t) return;
    touches.delete(e.pointerId);
    if (t.kind === 'move') { touchMoveX = touchMoveY = 0; setRaw('sprint', TOUCH, false); touchUI._base.style.display = touchUI._knob.style.display = 'none'; }
  };
  target.style.touchAction = 'none';
  target.addEventListener('pointerdown', onTouchDown);
  addEventListener('pointermove', onTouchMove);
  addEventListener('pointerup', onTouchUp);
  addEventListener('pointercancel', onTouchUp);

  // ---- gamepad (polled) ----
  const padAxes = new Float32Array(4);
  const dz = (x, y, out, o) => { // radial deadzone + quadratic response, writes out[o], out[o+1]
    const l = Math.hypot(x, y);
    if (l < deadzone) { out[o] = 0; out[o + 1] = 0; return; }
    const k = Math.min(1, (l - deadzone) / (1 - deadzone)); const s = (k * k) / l;
    out[o] = x * s; out[o + 1] = y * s;
  };
  // navigator.getGamepads() allocates a fresh array per call (Chrome), so it is only polled while a pad is connected.
  // Browsers expose no pad before 'gamepadconnected' (fired on the pad's first button press), so nothing is missed.
  const padActions = Object.keys(pad);
  let padsConnected = 0, padWasOn = false;
  const onPadOn = () => { padsConnected++; }, onPadOff = () => { padsConnected = Math.max(0, padsConnected - 1); };
  addEventListener('gamepadconnected', onPadOn);
  addEventListener('gamepaddisconnected', onPadOff);
  function pollPad() {
    const pads = padsConnected > 0 && navigator.getGamepads ? navigator.getGamepads() : null;
    let gp = null;
    if (pads) for (let i = 0; i < pads.length; i++) if (pads[i] && pads[i].connected) { gp = pads[i]; break; }
    if (!gp) {
      if (padWasOn) { padAxes.fill(0); for (let i = 0; i < padActions.length; i++) { const a = padActions[i]; if (a in raw) raw[a] &= ~PAD; } padWasOn = false; }
      return;
    }
    padWasOn = true;
    dz(gp.axes[0] || 0, gp.axes[1] || 0, padAxes, 0);
    dz(gp.axes[2] || 0, gp.axes[3] || 0, padAxes, 2);
    let any = padAxes[0] || padAxes[1] || padAxes[2] || padAxes[3];
    for (let i = 0; i < padActions.length; i++) { const a = padActions[i], b = gp.buttons[pad[a]]; const on = !!b && (b.pressed || b.value > 0.5); if (on) any = true; setRaw(a, PAD, on); }
    if (any && I.mode !== 'touch') I.mode = 'pad';
  }

  // ---- bot / programmatic API ----
  I.look = (dx, dy) => { accX += dx * I.sens; accY += dy * I.sens; };          // mouse-pixel units (same as a real mouse)
  I.lookRad = (yaw, pitch) => { accX += yaw; accY += pitch; };                   // radians, sensitivity-free
  I.hold = (a, ms = 100) => { ensure(a); holdUntil[a] = G.t + ms / 1000; };        // game time, so it works with ?dt=
  I.press = (a) => { ensure(a); pressQ[a] = true; };                              // true for exactly one latched frame
  I.release = (a) => { ensure(a); holdUntil[a] = -1; raw[a] = 0; pressQ[a] = false; };
  I.setMove = (x, y, ms = 1e9) => { botMoveX = x; botMoveY = y; botMoveUntil = G.t + ms / 1000; };
  I.clear = () => { for (const a of actions) { raw[a] = 0; holdUntil[a] = -1; pressQ[a] = false; } accX = accY = 0; botMoveUntil = -1; };
  I.requestLock = requestLock;
  I.actions = actions;

  // ---- per-frame latch ----
  I.update = (dt) => {
    pollPad();
    // no cursor over the canvas during play (shown only while waiting for a click to capture the mouse)
    const hide = hideCursor && I.enabled && I.mode !== 'touch' && !(I.mode === 'lock' && !I.locked && !I.lockFailed && lockFails > 0);
    if (hide !== cursorHidden) { cursorHidden = hide; target.style.cursor = hide ? 'none' : ''; }
    for (let i = 0; i < actions.length; i++) {
      const a = actions[i];
      prev[a] = cur[a];
      cur[a] = (I.enabled || always.has(a)) && (raw[a] !== 0 || holdUntil[a] >= G.t || pressQ[a] === true);
      pressQ[a] = false;
    }
    // move vector: keys, then touch, pad, bot override; clamp to unit length
    let mx = (cur.right ? 1 : 0) - (cur.left ? 1 : 0), my = (cur.forward ? 1 : 0) - (cur.back ? 1 : 0);
    mx += touchMoveX + padAxes[0]; my += touchMoveY - padAxes[1];
    if (botMoveUntil >= G.t) { mx = botMoveX; my = botMoveY; }
    const l = Math.hypot(mx, my); if (l > 1) { mx /= l; my /= l; }
    I.move.set(I.enabled ? mx : 0, I.enabled ? my : 0);
    const ys = I.invertY ? -1 : 1;
    if (I.mode === 'drag' && dragStyle === 'hover' && inside && !I.locked) {
      const e = innerWidth * 0.05;
      if (curX < e) accX -= edgeRate * dt * (1 - curX / e); else if (curX > innerWidth - e) accX += edgeRate * dt * (1 - (innerWidth - curX) / e);
    }
    const lx = accX + touchLookX + padAxes[2] * padSens * dt, ly = accY + touchLookY + padAxes[3] * padSens * dt;
    I.lookX = I.enabled ? lx : 0; I.lookY = I.enabled ? ly * ys : 0;
    accX = accY = touchLookX = touchLookY = 0;
  };
  G.on('preupdate', I.update); // latched before every 'update' listener, whatever the creation order

  (G.statsHooks ||= []).push(() => ({ input: { mode: I.mode, locked: I.locked, lockFailed: I.lockFailed } }));
  I.dispose = () => {
    removeEventListener('keydown', kd); removeEventListener('keyup', ku); removeEventListener('blur', blur);
    target.removeEventListener('mousedown', onDown); target.removeEventListener('pointerdown', onTouchDown);
    removeEventListener('mouseup', onUp); removeEventListener('pointermove', onMove);
    removeEventListener('pointermove', onTouchMove); removeEventListener('pointerup', onTouchUp); removeEventListener('pointercancel', onTouchUp);
    document.removeEventListener('mouseleave', onLeave);
    document.removeEventListener('pointerlockchange', onLockChange); document.removeEventListener('pointerlockerror', onLockError);
    G.off && G.off('preupdate', I.update); removeEventListener('gamepadconnected', onPadOn); removeEventListener('gamepaddisconnected', onPadOff); touchUI?.remove(); banner?.remove();
  };
  I.selfUpdating = true; // boot.js must not add it to the module runner (it runs via G.on('preupdate'))
  window.__input = I; G.input = I;
  return I;
}
