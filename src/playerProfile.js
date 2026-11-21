// PLAYER DATA layer: personal hero pool by role, with proficiency.
// Persisted in localStorage (per browser). Shape:
// { name, pool: { exp: { heroId: { stars, build, playstyle, likes, avoids } }, jungle: {...}, ... } }

import { ROLES } from './draftState.js';

const KEY = 'mldl.profile.v1';

export const STAR_LABEL = { 5: 'Comfort Pick', 4: 'Strong', 3: 'Usable', 2: 'Learning', 1: 'Avoid' };

export function defaultProfile() {
  return {
    name: 'Player',
    pool: {
      exp: {},
      jungle: { saber: { stars: 5 }, suyou: { stars: 5 }, yisunshin: { stars: 4 } },
      mid: {},
      gold: {},
      roam: { carmilla: { stars: 5 }, tigreal: { stars: 4 }, grock: { stars: 3 } },
    },
  };
}

function load() {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const p = JSON.parse(raw);
      for (const r of ROLES) p.pool[r] ||= {};
      return p;
    }
  } catch { /* storage unavailable or corrupt */ }
  return defaultProfile();
}

export function createPlayerProfile() {
  let profile = load();
  const listeners = new Set();
  const save = () => {
    try { localStorage.setItem(KEY, JSON.stringify(profile)); } catch { /* ignore */ }
    listeners.forEach((fn) => fn());
  };

  return {
    get data() { return profile; },
    subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    /** Roles this hero is in the pool for. */
    rolesFor(heroId) { return ROLES.filter((r) => profile.pool[r][heroId]); },
    inPool(heroId, role = null) {
      return role ? !!profile.pool[role][heroId] : ROLES.some((r) => profile.pool[r][heroId]);
    },
    /** Stars for a hero in a role, or best across roles when role is null. 0 = not in pool. */
    stars(heroId, role = null) {
      if (role) return profile.pool[role][heroId]?.stars || 0;
      return Math.max(0, ...ROLES.map((r) => profile.pool[r][heroId]?.stars || 0));
    },
    entries(role) {
      return Object.entries(profile.pool[role]).map(([id, e]) => ({ id, ...e }));
    },
    set(role, heroId, patch) {
      profile.pool[role][heroId] = { stars: 3, ...profile.pool[role][heroId], ...patch };
      save();
    },
    remove(role, heroId) { delete profile.pool[role][heroId]; save(); },
    reset() { profile = defaultProfile(); save(); },
    /** Signature hero per role (explicitly chosen; falls back to the top-rated pool hero in the engine). */
    signature(role) { return profile.signature?.[role] || null; },
    setSignature(role, heroId) { profile.signature = { ...(profile.signature || {}), [role]: heroId || undefined }; save(); },
  };
}
