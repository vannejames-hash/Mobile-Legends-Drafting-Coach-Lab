// MATCH STATE: the minimal shared state for live match rooms and share links.
//
// Only what cannot be recomputed is shared: the draft engine's authoritative snapshot (format, side,
// bracket, pick log with role assignments, ban log — hero ids only), the host's role/hero, the role
// the host is inspecting, and the host's pool (so playerFit, the Draft Rating and the personal guide
// come out identical for every viewer). Everything else — analysis, recommendations, the coaching
// lab — is rebuilt locally by each viewer from the same hero database and engines.

export const MATCH_VERSION = 1;
export const ROOM_STATUS = ['WAITING', 'LIVE', 'COMPLETE'];
const ROLES = ['exp', 'jungle', 'mid', 'gold', 'roam'];

/** Host pool as { role: { heroId: stars } } (heroes with a rating only). */
export function poolOf(profile) {
  const out = {};
  for (const r of ROLES) {
    const es = profile.entries(r).filter((e) => e.stars > 0);
    if (es.length) out[r] = Object.fromEntries(es.map((e) => [e.id, e.stars]));
  }
  return out;
}

export function buildMatchState({ draft, me, profile, recRole = null, code = null, hostName = null }) {
  const snap = draft.snapshot();
  const st = draft.status();
  const complete = draft.isComplete();
  return {
    v: MATCH_VERSION,
    matchId: code,
    hostName,
    status: complete ? 'COMPLETE' : snap.pickLog.length || snap.banLog.length ? 'LIVE' : 'WAITING',
    format: snap.formatId,
    bracket: snap.bracket,
    userSide: snap.userSide,
    phase: st.phase,
    phaseLabel: st.phaseLabel,
    picks: snap.pickLog,
    bans: snap.banLog,
    roleAssignments: { blue: { ...draft.state.picks.blue }, red: { ...draft.state.picks.red } },
    myRole: me.role,
    myHero: me.hero,
    myHeroSource: me.heroSource,
    recRole,
    pool: poolOf(profile),
    events: draft.log().filter((a) => ['pick', 'ban', 'remove', 'role', 'role-auto'].includes(a.kind)).map((a) => ({
      sequence: a.id, side: a.side ?? null, actionType: a.kind, heroId: a.heroId ?? null,
      role: a.kind === 'pick' || a.kind === 'role' ? a.key ?? null : null, timestamp: a.at ?? null,
    })),
    updatedAt: Date.now(),
  };
}

/** Load a shared state into a local draft engine (replaces the draft). */
export function applyMatchState(draft, s) {
  if (!s) return false;
  return draft.load({ formatId: s.format, userSide: s.userSide, bracket: s.bracket, pickLog: s.picks, banLog: s.bans });
}

/** Read-only profile built from a shared pool; `set` swaps the pool when the host's state changes. */
export function sharedProfile(pool = {}) {
  let p = pool || {};
  const listeners = new Set();
  return {
    get data() { return { name: 'Host', pool: p }; },
    readonly: true,
    /** Swap in the host's latest pool. */
    replace(next) { p = next || {}; },
    set: () => {}, // the pool editor is never available to viewers
    subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    rolesFor: (id) => ROLES.filter((r) => p[r]?.[id]),
    inPool: (id, role = null) => (role ? !!p[role]?.[id] : ROLES.some((r) => p[r]?.[id])),
    stars: (id, role = null) => (role ? p[role]?.[id] || 0 : Math.max(0, ...ROLES.map((r) => p[r]?.[id] || 0))),
    entries: (role) => Object.entries(p[role] || {}).map(([id, stars]) => ({ id, stars })),
    remove: () => {}, reset: () => {},
  };
}

/** In-memory storage (spectators and share views never touch the viewer's own saved role / hero). */
export function memoryStorage(seed = {}) {
  const m = new Map(Object.entries(seed));
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) };
}

// ------------------------------------------------------------------ share links (read-only final drafts)
// Compact form: picks [side(0/1), hero, role|0, manual(0/1), order], bans [side, wave, slot, hero|0].

const sideBit = (s) => (s === 'red' ? 1 : 0);
const bitSide = (b) => (b ? 'red' : 'blue');

export function encodeShare(s) {
  const c = {
    v: MATCH_VERSION, f: s.format, b: s.bracket || 0, u: sideBit(s.userSide),
    p: s.picks.map((x) => [sideBit(x.side), x.hero, x.assignedRole || 0, x.roleSource === 'manual' ? 1 : 0, x.order]),
    n: s.bans.map((e) => [sideBit(e.side), e.wave, e.slot, e.hero || 0]),
    r: s.myRole || 0, h: s.myHero || 0, hs: s.myHeroSource === 'manual' ? 1 : 0, o: s.pool || {},
  };
  return toBase64Url(JSON.stringify(c));
}

export function decodeShare(str) {
  try {
    const c = JSON.parse(fromBase64Url(str));
    if (!c || c.v !== MATCH_VERSION || !Array.isArray(c.p) || !Array.isArray(c.n)) return null;
    return {
      v: c.v, status: 'COMPLETE', format: c.f, bracket: c.b || null, userSide: bitSide(c.u),
      picks: c.p.map(([sd, hero, role, manual, order], i) => ({ seq: i + 1, order, side: bitSide(sd), hero, assignedRole: role || null, roleSource: manual ? 'manual' : 'auto' })),
      bans: c.n.map(([sd, wave, slot, hero]) => ({ side: bitSide(sd), wave, slot, hero: hero || null })),
      myRole: c.r || null, myHero: c.h || null, myHeroSource: c.h ? (c.hs ? 'manual' : 'auto') : null,
      recRole: null, pool: c.o && typeof c.o === 'object' ? c.o : {},
    };
  } catch {
    return null;
  }
}

function toBase64Url(text) {
  const bytes = new TextEncoder().encode(text);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function fromBase64Url(s) {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4);
  const bin = atob(b64);
  return new TextDecoder().decode(Uint8Array.from(bin, (ch) => ch.charCodeAt(0)));
}

// ------------------------------------------------------------------ room codes

export const CODE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ'; // no 0/O, 1/I/L
export const CODE_RE = /^MLDL-[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{4}$/;
export function newRoomCode(rand = Math.random) {
  let s = '';
  for (let i = 0; i < 4; i++) s += CODE_ALPHABET[Math.floor(rand() * CODE_ALPHABET.length)];
  return `MLDL-${s}`;
}
