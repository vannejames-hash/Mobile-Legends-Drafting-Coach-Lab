// PROFESSIONAL DRAFT LOG layer (game-by-game picks/bans/winner).
// Not used by Match Mode yet. Later chapters build draft sequencing, synergy,
// counter-draft patterns and team tendencies on top of these games. With a role
// per pick it also verifies observed lane usage (see tools/build-usage.js).
//
// Game format:
// { id, winner: 'blue'|'red',
//   blue: { team, picks: [{ hero, role }] | [heroId], bans: [heroId] },
//   red:  { ... } }
// picks are in pick order; role (exp/jungle/mid/gold/roam) is optional but needed for lane usage.

export async function loadDraftLog(url) {
  if (!url) return createDraftLog(null);
  try {
    const res = await fetch(url, { cache: 'no-store' });
    if (!res.ok) throw new Error(String(res.status));
    return createDraftLog(await res.json());
  } catch (err) {
    console.warn('[draftLog] not loaded:', err.message);
    return createDraftLog(null);
  }
}

const ROLES = ['exp', 'jungle', 'mid', 'gold', 'roam'];
const pickHero = (p) => (typeof p === 'string' ? p : p.hero);
const pickRole = (p) => (typeof p === 'string' ? null : p.role || null);

/** Returns a list of problems with one game (empty = valid). */
export function validateGame(g, knownIds = null) {
  const errs = [];
  if (!g.id) errs.push('missing id');
  if (g.winner !== 'blue' && g.winner !== 'red') errs.push('winner must be "blue" or "red"');
  const seen = new Set();
  for (const side of ['blue', 'red']) {
    const s = g[side];
    if (!s) { errs.push(`missing ${side}`); continue; }
    if (!Array.isArray(s.picks) || s.picks.length !== 5) errs.push(`${side}.picks must have 5 heroes`);
    const roles = (s.picks || []).map(pickRole).filter(Boolean);
    if (roles.some((r) => !ROLES.includes(r))) errs.push(`${side}: unknown role`);
    if (roles.length && new Set(roles).size !== roles.length) errs.push(`${side}: duplicate role`);
    for (const id of [...(s.picks || []).map(pickHero), ...(s.bans || [])]) {
      if (seen.has(id)) errs.push(`${id} appears twice`);
      seen.add(id);
      if (knownIds && !knownIds.has(id)) errs.push(`unknown hero "${id}"`);
    }
  }
  return errs;
}

export function createDraftLog(raw) {
  const games = raw?.games || [];
  const sides = (g) => ['blue', 'red'].map((side) => ({ side, ...g[side], heroes: g[side].picks.map(pickHero) }));
  return {
    games,
    hasData: games.length > 0,
    /** Per-hero totals from the game log; used to cross-check the hero-stat table. */
    heroTotals() {
      const t = new Map();
      const get = (id) => t.get(id) || t.set(id, { picks: 0, bans: 0, wins: 0 }).get(id);
      for (const g of games) {
        for (const s of sides(g)) {
          for (const id of s.heroes) { const x = get(id); x.picks++; if (g.winner === s.side) x.wins++; }
          for (const id of s.bans || []) get(id).bans++;
        }
      }
      return t;
    },
    /** Observed lanes per hero: Map heroId -> { lane: count }. Only from picks that carry a role. */
    laneUsage() {
      const t = new Map();
      for (const g of games) {
        for (const s of sides(g)) {
          for (const p of s.picks) {
            const role = pickRole(p);
            if (!role) continue;
            const x = t.get(pickHero(p)) || {};
            x[role] = (x[role] || 0) + 1;
            t.set(pickHero(p), x);
          }
        }
      }
      return t;
    },
    /** How often two heroes were picked on the same team, with wins. Key "a|b", sorted ids. */
    pairCounts() {
      const t = new Map();
      for (const g of games) {
        for (const s of sides(g)) {
          const p = [...s.heroes].sort();
          for (let i = 0; i < p.length; i++) for (let j = i + 1; j < p.length; j++) {
            const k = `${p[i]}|${p[j]}`;
            const x = t.get(k) || { games: 0, wins: 0 };
            x.games++; if (g.winner === s.side) x.wins++;
            t.set(k, x);
          }
        }
      }
      return t;
    },
  };
}
