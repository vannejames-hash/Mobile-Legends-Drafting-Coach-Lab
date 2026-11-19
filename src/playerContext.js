// PLAYER CONTEXT: "What am I playing?" — my role and my hero for the current draft.
//
// role:       'exp' | 'jungle' | 'mid' | 'gold' | 'roam' | null
// hero:       hero id | null (null = undecided)
// heroSource: 'manual' (chosen by me — always wins) | 'auto' (detected from my team's pick in my role) | null
//
// Persisted per browser (localStorage). Auto-detected heroes are recomputed from the draft.

const KEY = 'mldl.me.v1';
const ROLES = ['exp', 'jungle', 'mid', 'gold', 'roam'];

export function createPlayerContext({ lanesOf, storage = globalThis.localStorage } = {}) {
  let s = { role: null, hero: null, heroSource: null };
  try { const raw = storage?.getItem(KEY); if (raw) s = { ...s, ...JSON.parse(raw) }; } catch { /* storage unavailable */ }
  const listeners = new Set();
  const persist = () => { try { storage?.setItem(KEY, JSON.stringify(s)); } catch { /* ignore */ } };
  const save = () => { persist(); listeners.forEach((fn) => fn()); };

  return {
    get role() { return s.role; },
    get hero() { return s.hero; },
    get heroSource() { return s.heroSource; },
    snapshot() { return { ...s }; },
    /** Replace the whole context (spectators follow the host's role / hero). */
    replace(next) {
      const r = ROLES.includes(next?.role) ? next.role : null;
      s = { role: r, hero: next?.hero || null, heroSource: next?.hero ? (next.heroSource === 'manual' ? 'manual' : 'auto') : null };
      save();
    },
    subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },

    /** Set my role. A manually chosen hero is kept only if it can play the new role. */
    setRole(role) {
      const r = ROLES.includes(role) ? role : null;
      if (r === s.role) return;
      s.role = r;
      if (s.heroSource !== 'manual' || (s.hero && r && !(lanesOf(s.hero) || []).includes(r))) { s.hero = null; s.heroSource = null; }
      save();
    },
    /** Choose my hero manually (null = undecided, which re-enables auto-detection). */
    setHero(heroId) {
      s.hero = heroId || null;
      s.heroSource = heroId ? 'manual' : null;
      save();
    },
    /**
     * Auto-detect my hero from the draft: the hero my team picked into my role.
     * Never overrides a manual choice. Returns true if something changed.
     */
    sync(draft) {
      if (s.heroSource === 'manual' || !s.role) return false;
      const mine = draft.picks(draft.userSide);
      // Sticky: once detected, my hero stays mine while it is still on my team.
      if (s.heroSource === 'auto' && s.hero && mine.some((x) => x.hero === s.hero)) return false;
      const p = mine.find((x) => x.assignedRole === s.role);
      const hero = p ? p.hero : null;
      if (hero === s.hero && (hero ? s.heroSource === 'auto' : s.heroSource === null)) return false;
      s.hero = hero;
      s.heroSource = hero ? 'auto' : null;
      persist(); // silent: called while rendering, the caller already re-renders
      return true;
    },
  };
}
