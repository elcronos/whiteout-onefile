// Fixed pool of PointLights for muzzle flashes, impacts and explosions. The pool size is fixed at creation
// and lights are never removed/hidden (intensity 0 instead): changing the light COUNT recompiles every lit
// material in three.js (a 100+ ms hitch). Oldest light is stolen when all are busy.
// Units: candela (physically-correct three, decay 2). Irradiance at d metres = I / d².
import { PointLight } from 'three';

export const LIGHT_POOL_SIZE = { low: 2, med: 3, high: 4, ultra: 6 };

export function createLightPool(G, { count } = {}) {
  const n = count ?? LIGHT_POOL_SIZE[G.quality.tier] ?? 4;
  const slots = [];
  for (let i = 0; i < n; i++) {
    const l = new PointLight(0xffffff, 0, 10, 2);
    l.castShadow = false; l.name = 'fx-light-' + i;
    G.scene.add(l);
    slots.push({ l, age: 1, life: 0, I: 0, flick: 0, born: 0 });
  }
  let clock = 0;
  return {
    slots,
    // shape: intensity * (1-u)^2 with optional flicker (fire). distance = hard cutoff radius (perf + no leaks)
    flash(x, y, z, r, g, b, intensity, life = 0.06, distance = 8, flicker = 0) {
      if (!slots.length) return null; // count: 0 → flashes are visual-only
      let s = slots[0];
      for (const c of slots) { if (c.age >= c.life) { s = c; break; } if (c.born < s.born) s = c; }
      s.l.position.set(x, y, z); s.l.color.setRGB(r, g, b); s.l.distance = distance;
      s.age = 0; s.life = life; s.I = intensity; s.flick = flicker; s.born = clock;
      s.l.intensity = intensity;
      return s;
    },
    update(dt) {
      clock += dt;
      for (const s of slots) {
        if (s.age >= s.life) { s.l.intensity = 0; continue; }
        s.age += dt;
        const u = Math.min(1, s.age / s.life), k = (1 - u) * (1 - u);
        s.l.intensity = s.I * k * (s.flick ? 1 - s.flick + s.flick * (0.5 + 0.5 * Math.sin(clock * 53 + s.born * 7) * Math.sin(clock * 31)) : 1);
      }
    },
    dispose() { for (const s of slots) G.scene.remove(s.l); },
  };
}
