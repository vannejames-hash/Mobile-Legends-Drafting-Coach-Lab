// DRAFT STATE layer: a generic draft engine driven by a draft FORMAT (data/draft-formats.json).
//
// Two separate pieces of state:
//   1. PICK ORDER  — a chronological log: { seq, order, side, hero, assignedRole, roleSource }
//   2. ROLE ASSIGNMENT — inferred per side ('auto') or set by the user ('manual'); it can change
//      at any time without touching the pick order.
// state.picks[side][role] is a DERIVED view of the current role assignment (kept for readers).
// No scoring logic here.

export const ROLES = ['exp', 'jungle', 'mid', 'gold', 'roam'];
export const ROLE_LABEL = { exp: 'EXP', jungle: 'JUNGLE', mid: 'MID', gold: 'GOLD', roam: 'ROAM' };
export const ROLE_SHORT = { exp: 'EXP', jungle: 'JG', mid: 'MID', gold: 'GOLD', roam: 'ROAM' };
export const opp = (side) => (side === 'blue' ? 'red' : 'blue');
const ABS = { b: 'blue', r: 'red' };
const REL = { a: 'ally', e: 'enemy' };

/**
 * Compile a format definition into a flat, annotated step list for a given user side.
 * Order tokens: 'b'/'r' = blue/red side, 'a'/'e' = your side/enemy side (resolved from userSide).
 */
export function compileFormat(id, rawDef, userSide = 'blue', bracket = null) {
  // Formats with brackets (Ranked) take their phases and ban count from the chosen bracket.
  const b = rawDef.brackets ? rawDef.brackets[bracket || rawDef.defaultBracket] || Object.values(rawDef.brackets)[0] : null;
  const def = b ? { ...rawDef, bansPerSide: b.bansPerSide, phases: b.phases } : rawDef;
  const steps = [];
  const nth = { ban: { blue: 0, red: 0 }, pick: { blue: 0, red: 0 } };
  const number = { ban: 0, pick: 0 };
  def.phases.forEach((ph, phaseIndex) => {
    ph.order.trim().split(/\s+/).forEach((tok) => {
      const side = ABS[tok] || (REL[tok] === 'ally' ? userSide : REL[tok] === 'enemy' ? opp(userSide) : null);
      if (!side) throw new Error(`format ${id}: bad side "${tok}" in phase ${ph.id}`);
      steps.push({
        index: steps.length, type: ph.type, side, relative: !!REL[tok],
        nth: ++nth[ph.type][side], number: ++number[ph.type],
        phaseId: ph.id, phaseIndex, phaseLabel: ph.label, timer: ph.timer ?? null, wave: ph.wave ?? null,
        label: `${ph.type === 'ban' ? 'Ban' : 'Pick'} ${number[ph.type]}`,
      });
    });
  });
  // Explicit format declarations must agree with the phases (fail loudly on a mismatch).
  const banPhases = def.phases.filter((ph) => ph.type === 'ban');
  const banRounds = new Set(banPhases.map((ph) => ph.wave ?? ph.id)).size;
  if (def.banPhaseCount != null && banRounds !== def.banPhaseCount) throw new Error(`format ${id}: declares ${def.banPhaseCount} ban phase(s), phases define ${banRounds}`);
  if (def.secondBanPhase === false && steps.some((st, i) => st.type === 'ban' && steps.slice(0, i).some((x) => x.type === 'pick'))) throw new Error(`format ${id}: declares no second ban phase but bans follow picks`);
  if (def.pickOrder) {
    const groups = [];
    for (const st of steps.filter((x) => x.type === 'pick')) {
      const tag = st.side === 'blue' ? 'B' : 'R';
      if (groups.length && groups[groups.length - 1][0] === tag) groups[groups.length - 1] = tag + (Number(groups[groups.length - 1].slice(1)) + 1);
      else groups.push(tag + '1');
    }
    if (groups.join(',') !== def.pickOrder.join(',')) throw new Error(`format ${id}: pickOrder ${def.pickOrder} ≠ phases ${groups}`);
  }
  // per-side ban count of each ban ROUND (a round = phases sharing a wave, or a single phase)
  const roundKey = (ph) => ph.wave ?? ph.id;
  const rounds = [...new Set(banPhases.map(roundKey))].map((k) => banPhases.filter((ph) => roundKey(ph) === k).reduce((n, ph) => n + ph.order.trim().split(/\s+/).length, 0) / 2);
  if (def.firstBanPerSide != null && rounds[0] !== def.firstBanPerSide) throw new Error(`format ${id}: firstBanPerSide ${def.firstBanPerSide} ≠ ${rounds[0]}`);
  if (def.secondBanPerSide != null && rounds[1] !== def.secondBanPerSide) throw new Error(`format ${id}: secondBanPerSide ${def.secondBanPerSide} ≠ ${rounds[1]}`);
  for (const side of ['blue', 'red']) {
    if (nth.ban[side] > def.bansPerSide) throw new Error(`format ${id}: ${side} has more bans than bansPerSide`);
    if (nth.pick[side] !== def.picksPerSide) throw new Error(`format ${id}: ${side} has ${nth.pick[side]} picks, expected ${def.picksPerSide}`);
  }
  return Object.freeze({
    id, ...def, def: rawDef, steps, totals: { ...number },
    banMode: def.banMode || 'sequential', allowNoBan: !!def.allowNoBan,
    bracket: b ? (bracket || rawDef.defaultBracket) : null,
  });
}

export function compileFormats(raw) {
  const formats = {};
  for (const [id, def] of Object.entries(raw.formats)) formats[id] = compileFormat(id, def);
  return { formats, defaultId: raw.default in formats ? raw.default : Object.keys(formats)[0] };
}

const clone = (o) => JSON.parse(JSON.stringify(o));
const no = (reason) => ({ ok: false, reason });
const yes = { ok: true };

/** All injective assignments of `items` into `slots` (≤ 5 × 5 → at most 120). */
function* assignments(items, slots, i = 0, used = new Set(), acc = []) {
  if (i === items.length) { yield acc.slice(); return; }
  for (const s of slots) {
    if (used.has(s)) continue;
    used.add(s); acc.push(s);
    yield* assignments(items, slots, i + 1, used, acc);
    used.delete(s); acc.pop();
  }
}

/**
 * @param {{ lanesOf: (heroId: string) => string[], formats: object, format?: string,
 *           userSide?: 'blue'|'red', heroIds?: string[],
 *           roleScore?: (heroId: string, role: string) => number }} opts
 *   roleScore: likelihood that a hero plays a role (default: primary lane 1, flex lanes ~0.75, other 0.05).
 *   roleLock:  (side, heroId) => role | null. A known fact that pins a hero to a role during inference
 *              (e.g. "I am playing Jungle Suyou"). Manual role choices still take precedence.
 */
export function createDraftState({ lanesOf, formats, format, userSide = 'blue', heroIds = [], roleScore = null, roleLock = null }) {
  const FORMATS = formats;
  const firstId = format && FORMATS[format] ? format : Object.keys(FORMATS)[0];
  const scoreRole = roleScore || ((id, role) => {
    const lanes = lanesOf(id) || [];
    const i = lanes.indexOf(role);
    return i === 0 ? 1 : i > 0 ? 0.75 - 0.05 * i : 0.05;
  });
  let state = fresh(firstId, userSide);
  let history = [];
  let seq = 0;
  const listeners = new Set();

  function fresh(formatId, side) {
    const def = FORMATS[formatId].def;
    const s = { formatId, userSide: side, bracket: def.brackets ? def.defaultBracket : null, pickLog: [], banLog: [], target: null };
    sync(s);
    return s;
  }
  const emit = () => listeners.forEach((fn) => fn());
  function commit(mutate, action) {
    const before = clone(state);
    if (mutate(state) === false) return false;
    sync(state);
    history.push({ before, action: { id: ++seq, at: Date.now(), ...action } });
    if (history.length > 300) history.shift();
    emit();
    return true;
  }

  // ------------------------------------------------------------ formats (resolved for the user's side)
  const resolved = new Map();
  function fmt() {
    const key = `${state.formatId}|${state.userSide}|${state.bracket}`;
    if (!resolved.has(key)) resolved.set(key, compileFormat(state.formatId, FORMATS[state.formatId].def, state.userSide, state.bracket));
    return resolved.get(key);
  }

  // ------------------------------------------------------------ role assignment
  const sidePicks = (s, side) => s.pickLog.filter((p) => p.side === side).sort((a, b) => a.order - b.order);

  /**
   * Best joint role assignment for a side. Manual roles are fixed; every 'auto' pick (plus an
   * optional hypothetical extra hero) is placed to maximise total role likelihood, with a small
   * bonus for keeping its current role so assignments don't jump around without reason.
   */
  function solveRoles(s, side, extraHero = null) {
    const picks = sidePicks(s, side);
    const lockOf = (p) => (roleLock && p.roleSource !== 'manual' ? roleLock(side, p.hero) : null);
    const manual = picks.filter((p) => p.roleSource === 'manual');
    const locked = picks.filter((p) => { const r = lockOf(p); return r && !manual.some((m) => m.assignedRole === r); });
    const fixed = [...manual, ...locked.map((p) => ({ ...p, assignedRole: lockOf(p) }))];
    const autos = picks.filter((p) => !fixed.some((f) => f.hero === p.hero)).map((p) => ({ hero: p.hero, current: p.assignedRole }));
    if (extraHero) autos.push({ hero: extraHero, current: null });
    const free = ROLES.filter((r) => !fixed.some((p) => p.assignedRole === r));
    const out = new Map(fixed.map((p) => [p.hero, p.assignedRole]));
    if (!autos.length) return out;
    if (autos.length > free.length) { autos.forEach((a, i) => out.set(a.hero, free[i] || null)); return out; }
    let best = null;
    let bestScore = -Infinity;
    for (const combo of assignments(autos, free)) {
      let sc = 0;
      combo.forEach((role, i) => { sc += scoreRole(autos[i].hero, role) + (autos[i].current === role ? 0.15 : 0); });
      if (sc > bestScore + 1e-9) { bestScore = sc; best = combo; }
    }
    best.forEach((role, i) => out.set(autos[i].hero, role));
    return out;
  }

  function reassign(s, side) {
    const sol = solveRoles(s, side);
    for (const p of s.pickLog) if (p.side === side && p.roleSource !== 'manual') p.assignedRole = sol.get(p.hero) ?? null;
  }

  /** Derived role map: state.picks[side][role] = heroId. */
  function sync(s) {
    s.picks = {};
    for (const side of ['blue', 'red']) {
      s.picks[side] = Object.fromEntries(ROLES.map((r) => [r, null]));
      for (const p of s.pickLog) if (p.side === side && p.assignedRole) s.picks[side][p.assignedRole] = p.hero;
    }
    // Ban events → per-side lists (null = "No ban"). Length = ban slots consumed.
    s.banLog ||= [];
    s.bans = {};
    for (const side of ['blue', 'red']) s.bans[side] = s.banLog.filter((e) => e.side === side).sort((a, b) => a.slot - b.slot).map((e) => e.hero);
  }

  // ------------------------------------------------------------ queries
  const pickCount = (side) => state.pickLog.filter((p) => p.side === side).length;
  const counts = () => ({
    pick: { blue: pickCount('blue'), red: pickCount('red') },
    ban: { blue: state.bans.blue.length, red: state.bans.red.length },
  });

  /** Wave of the next ban slot for a side (blind ranked), or null. */
  function waveFor(side, slotIndex = state.bans[side].length) {
    const st = fmt().steps.find((x) => x.type === 'ban' && x.side === side && x.nth === slotIndex + 1);
    return st ? st.wave : null;
  }
  /** A blind wave is revealed once every ban slot in it has been entered (for both sides). */
  function isRevealed(wave) {
    if (wave == null) return true;
    const c = counts();
    return fmt().steps.filter((x) => x.type === 'ban' && x.wave === wave).every((x) => x.nth <= c.ban[x.side]);
  }
  /**
   * Can `side` ban `heroId` in its next ban slot? Format-specific:
   *   blind (Ranked)   — the other side's ban of the same hero in the SAME unrevealed wave is fine
   *                      (a double ban); a ban revealed in an earlier wave is not.
   *   sequential/free  — every ban is visible: a banned hero can't be banned again.
   */
  function banConflict(heroId, side, slotIndex) {
    const f = fmt();
    if (state.pickLog.some((x) => x.hero === heroId)) return 'Already picked.';
    if (state.banLog.some((e) => e.side === side && e.hero === heroId && e.slot !== slotIndex + 1)) return 'Your team already banned this hero.';
    const theirs = state.banLog.find((e) => e.side !== side && e.hero === heroId);
    if (!theirs) return null;
    if (f.banMode === 'blind') {
      const wave = waveFor(side, slotIndex);
      if (theirs.wave === wave && !isRevealed(wave)) return null; // blind double ban
      return 'Already banned (revealed).';
    }
    if (f.banMode === 'free' && f.allowDuplicateBans) return null;
    return 'Already banned.';
  }

  function usedBy(heroId) {
    const p = state.pickLog.find((x) => x.hero === heroId);
    if (p) return { side: p.side, type: 'pick', key: p.assignedRole, index: p.order - 1 };
    for (const side of ['blue', 'red']) {
      const i = state.bans[side].indexOf(heroId);
      if (i >= 0) return { side, type: 'ban', key: i };
    }
    return null;
  }

  /** Legal manual target? Non-enforced formats: any side. Enforced: only the current action's side/type. */
  function checkTarget(t) {
    if (!t) return yes;
    if (!fmt().enforced) {
      if (t.type === 'pick' && pickCount(t.side) >= fmt().picksPerSide) return no('That team already has five picks.');
      if (t.type === 'ban' && !Number.isInteger(t.key) && state.bans[t.side].length >= fmt().bansPerSide) return no('That team has no bans left.');
      return yes;
    }
    const step = api.currentStep();
    if (!step) return no('The draft is complete.');
    if (t.side !== step.side || t.type !== step.type) {
      return no(`It's ${step.side === state.userSide ? 'your' : 'the enemy'} ${step.type} (${step.label}).`);
    }
    if (t.type === 'ban' && Number.isInteger(t.key) && t.key !== state.bans[t.side].length) return no('Bans fill in order.');
    return yes;
  }

  /** Where a hero would go right now. No side effects. */
  function resolveTarget(heroId) {
    const step = api.currentStep();
    const tgt = (state.target && checkTarget(state.target).ok && state.target) || (step && { side: step.side, type: step.type });
    if (!tgt) return null;
    if (tgt.type === 'ban') {
      const len = state.bans[tgt.side].length;
      const key = Number.isInteger(tgt.key) && tgt.key < len ? tgt.key : len;
      if (key >= fmt().bansPerSide) return null;
      return { side: tgt.side, type: 'ban', key, replaces: state.bans[tgt.side][key] || null };
    }
    const index = pickCount(tgt.side);
    if (index >= fmt().picksPerSide) return null;
    const manualRole = tgt.key && ROLES.includes(tgt.key) ? tgt.key : null;
    const role = manualRole || solveRoles(state, tgt.side, heroId).get(heroId) || null;
    return { side: tgt.side, type: 'pick', index, order: index + 1, key: role, manualRole };
  }

  const api = {
    get state() { return state; },
    get format() { return fmt(); },
    get formats() { return FORMATS; },
    get userSide() { return state.userSide; },
    get enemySide() { return opp(state.userSide); },
    subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },

    currentStep() {
      const c = counts();
      return fmt().steps.find((st) => st.nth > c[st.type][st.side]) || null;
    },
    stepStatus() {
      const c = counts();
      const cur = api.currentStep();
      return fmt().steps.map((st) => ({ ...st, done: st.nth <= c[st.type][st.side], current: cur?.index === st.index }));
    },
    isComplete() { return pickCount('blue') === 5 && pickCount('red') === 5; },
    usedBy,
    openRoles(side) { return ROLES.filter((r) => !state.picks[side][r]); },
    /** Current composition by role (order preserved): [{ role, id, order }]. */
    team(side) { return sidePicks(state, side).filter((p) => p.assignedRole).map((p) => ({ role: p.assignedRole, id: p.hero, order: p.order })); },
    /** Chronological picks for a side: [{ seq, order, side, hero, assignedRole, roleSource }]. */
    picks(side) { return sidePicks(state, side).map((p) => ({ ...p })); },
    /** Role a hero would most likely take if picked by `side` now (or its current role if already picked). */
    inferRole(side, heroId) {
      const p = state.pickLog.find((x) => x.hero === heroId);
      if (p) return p.assignedRole;
      if (pickCount(side) >= 5) return null;
      return solveRoles(state, side, heroId).get(heroId) || null;
    },

    /**
     * Snapshot of where the draft is: { format, kind, enforced, phase, phaseId, phaseIndex, phaseLabel,
     * side, actionType, actionNumber, stepIndex, totalSteps, timer, complete,
     * availableHeroes, pickedHeroes, bannedHeroes, picks }
     */
    status() {
      const f = fmt();
      const step = api.currentStep();
      const complete = api.isComplete() || !step;
      const picked = { blue: sidePicks(state, 'blue').map((p) => p.hero), red: sidePicks(state, 'red').map((p) => p.hero) };
      const banned = { blue: state.bans.blue.filter(Boolean), red: state.bans.red.filter(Boolean) };
      const events = api.banEvents();
      const used = new Set([...picked.blue, ...picked.red, ...banned.blue, ...banned.red]);
      return {
        format: f.id, formatLabel: f.label, kind: f.kind, enforced: !!f.enforced,
        phase: complete ? 'complete' : step.type,
        phaseId: step?.phaseId ?? null,
        phaseIndex: step ? step.phaseIndex : f.phases.length,
        phaseLabel: step?.phaseLabel ?? 'Draft complete',
        side: step?.side ?? null,
        actionType: step?.type ?? null,
        actionNumber: step?.number ?? null,
        stepIndex: step ? step.index : f.steps.length,
        totalSteps: f.steps.length,
        timer: step?.timer ?? null,
        complete,
        availableHeroes: heroIds.filter((id) => !used.has(id)),
        pickedHeroes: picked,
        bannedHeroes: banned,
        banEvents: events,
        doubleBans: [...new Set(events.filter((e) => e.result === 'double').map((e) => e.hero))],
        banMode: f.banMode, bracket: f.bracket,
        wave: step && step.type === 'ban' ? step.wave : null,
        picks: { blue: api.picks('blue'), red: api.picks('red') },
      };
    },

    canAct(heroId) {
      if (state.target && !checkTarget(state.target).ok) return checkTarget(state.target);
      const tgt = resolveTarget(heroId);
      if (tgt && tgt.type === 'ban') {
        const c = banConflict(heroId, tgt.side, tgt.key);
        return c ? no(c) : yes;
      }
      const u = usedBy(heroId);
      if (u) return no(`Already ${u.type === 'ban' ? 'banned' : 'picked'}.`);
      if (!tgt) return no(api.currentStep() ? 'No open slot for this action.' : 'The draft is complete.');
      return yes;
    },
    /** Can the current ban slot be recorded as "No ban"? */
    canNoBan() {
      if (!fmt().allowNoBan) return no('This format does not allow skipping a ban.');
      const step = api.currentStep();
      const t = (state.target && state.target.type === 'ban' && checkTarget(state.target).ok) ? state.target : step;
      if (!t || t.type !== 'ban') return no('No ban slot is open right now.');
      if (state.bans[t.side].length >= fmt().bansPerSide) return no('That team has no bans left.');
      return { ok: true, side: t.side };
    },
    /** Record an empty ban for the current ban slot: advances the draft, blocks no hero. */
    noBan() {
      const c = api.canNoBan();
      if (!c.ok) return false;
      const slot = state.bans[c.side].length;
      return commit((s) => {
        s.banLog.push({ side: c.side, wave: waveFor(c.side, slot), slot: slot + 1, hero: null, result: 'no-ban' });
        s.target = null;
      }, { kind: 'ban', side: c.side, key: slot, heroId: null, noBan: true });
    },
    /** Ban events (shared log): [{ side, wave, slot, hero|null, result: 'ban'|'double'|'no-ban' }]. */
    banEvents() {
      return state.banLog.map((e) => ({ ...e, result: e.hero == null ? 'no-ban' : state.banLog.some((o) => o.side !== e.side && o.hero === e.hero) ? 'double' : 'ban' }));
    },
    isWaveRevealed: isRevealed,
    get bracket() { return state.bracket; },
    /** Ranked bracket (Mythic / Legend / Epic): sets ban count and waves. */
    setBracket(id) {
      const def = FORMATS[state.formatId].def;
      if (!def.brackets || !def.brackets[id] || id === state.bracket) return no('No such bracket for this format.');
      const max = def.brackets[id].bansPerSide;
      if (state.bans.blue.length > max || state.bans.red.length > max) return no(`More than ${max} bans are already entered for a side.`);
      commit((s) => { s.bracket = id; s.target = null; }, { kind: 'bracket', key: id });
      return yes;
    },
    checkTarget,
    canRemove() { return fmt().enforced ? no('Picks and bans are final in this format; use Undo or Start over.') : yes; },
    canSwap() { return fmt().flexBeforeRoleAssignment ? yes : no('Role changes are not allowed in this format.'); },
    previewTarget(heroId) { return api.canAct(heroId).ok ? resolveTarget(heroId) : null; },

    /** Log a hero for the current action. Picks get an inferred role (or the targeted role). */
    act(heroId) {
      if (!api.canAct(heroId).ok) return false;
      const tgt = resolveTarget(heroId);
      if (tgt.type === 'ban') {
        return commit((s) => {
          s.banLog = s.banLog.filter((e) => !(e.side === tgt.side && e.slot === tgt.key + 1)); // replacing a slot
          s.banLog.push({ side: tgt.side, wave: waveFor(tgt.side, tgt.key), slot: tgt.key + 1, hero: heroId, result: 'ban' });
          s.target = null;
        }, { kind: 'ban', side: tgt.side, key: tgt.key, heroId, replaced: tgt.replaces });
      }
      let role = null;
      const ok = commit((s) => {
        const entry = { seq: s.pickLog.length + 1, order: tgt.order, side: tgt.side, hero: heroId, assignedRole: null, roleSource: 'auto' };
        if (tgt.manualRole) {
          const holder = s.pickLog.find((p) => p.side === tgt.side && p.assignedRole === tgt.manualRole);
          if (holder) holder.roleSource = 'auto'; // displaced hero is re-inferred
          entry.assignedRole = tgt.manualRole; entry.roleSource = 'manual';
        }
        s.pickLog.push(entry);
        reassign(s, tgt.side);
        role = entry.assignedRole;
        s.target = null;
      }, { kind: 'pick', side: tgt.side, order: tgt.order, key: tgt.manualRole || tgt.key, heroId });
      if (ok) history[history.length - 1].action.key = role;
      return ok;
    },

    /** Change a picked hero's role without touching pick order. A hero already in that role swaps. */
    assignRole(side, heroId, role) {
      if (!ROLES.includes(role) || !api.canSwap().ok) return false;
      const p = state.pickLog.find((x) => x.hero === heroId && x.side === side);
      if (!p) return false;
      const from = p.assignedRole;
      if (from === role && p.roleSource === 'manual') return false;
      return commit((s) => {
        const me = s.pickLog.find((x) => x.hero === heroId && x.side === side);
        const holder = s.pickLog.find((x) => x.side === side && x.hero !== heroId && x.assignedRole === role);
        me.assignedRole = role; me.roleSource = 'manual';
        if (holder) { holder.assignedRole = from; holder.roleSource = holder.roleSource === 'manual' && from ? 'manual' : 'auto'; }
        reassign(s, side);
      }, { kind: 'role', side, heroId, key: role, from });
    },
    /** Return a hero to automatic role inference. */
    autoRole(side, heroId) {
      const p = state.pickLog.find((x) => x.hero === heroId && x.side === side);
      if (!p || p.roleSource === 'auto') return false;
      return commit((s) => { s.pickLog.find((x) => x.hero === heroId).roleSource = 'auto'; reassign(s, side); }, { kind: 'role-auto', side, heroId });
    },

    /** Remove a pick (key = heroId, role or 0-based pick index) or a ban (key = index). */
    remove(side, type, key) {
      if (!api.canRemove().ok) return false;
      if (type === 'ban') {
        const heroId = state.bans[side][key];
        return commit((s) => {
          s.banLog = s.banLog.filter((e) => !(e.side === side && e.slot === key + 1));
          s.banLog.filter((e) => e.side === side).sort((a, b) => a.slot - b.slot).forEach((e, i) => { e.slot = i + 1; });
          s.target = null;
        }, { kind: 'remove', side, key, heroId, removedType: 'ban' });
      }
      const p = sidePicks(state, side).find((x, i) => x.hero === key || x.assignedRole === key || i === key);
      if (!p) return false;
      return commit((s) => {
        s.pickLog = s.pickLog.filter((x) => x.hero !== p.hero);
        sidePicks(s, side).forEach((x, i) => { x.order = i + 1; });
        s.pickLog.forEach((x, i) => { x.seq = i + 1; });
        reassign(s, side);
        s.target = null;
      }, { kind: 'remove', side, key: p.assignedRole, heroId: p.hero, removedType: 'pick' });
    },
    /** Swap the heroes in two roles (manual role assignment). */
    swap(side, roleA, roleB) {
      const hero = state.picks[side][roleA] || state.picks[side][roleB];
      if (!hero) return false;
      return api.assignRole(side, hero, state.picks[side][roleA] === hero ? roleB : roleA);
    },
    setTarget(target) {
      const c = checkTarget(target);
      if (!c.ok) return c;
      state.target = target;
      emit();
      return yes;
    },
    undo() {
      if (!history.length) return false;
      state = history.pop().before;
      state.target = null;
      sync(state);
      emit();
      return true;
    },
    canUndo() { return history.length > 0; },
    /** Re-run role inference (e.g. after "my role / my hero" changed). Not an action; not in history. */
    refreshRoles() {
      const before = JSON.stringify(state.pickLog);
      reassign(state, 'blue'); reassign(state, 'red'); sync(state);
      if (JSON.stringify(state.pickLog) !== before) emit();
    },
    log() { return history.map((h) => h.action); },
    /** Authoritative, shareable draft state (hero ids only): format, side, bracket, pick log, ban log. */
    snapshot() {
      const { formatId, userSide, bracket, pickLog, banLog } = state;
      return clone({ formatId, userSide, bracket, pickLog, banLog });
    },
    /**
     * Replace the draft with a shared snapshot (spectators, share links). Unknown heroes and malformed
     * entries are dropped; history is cleared because the snapshot is the new starting point.
     */
    load(snap) {
      if (!snap || !FORMATS[snap.formatId]) return false;
      const known = new Set(heroIds);
      const side = (x) => (x === 'red' ? 'red' : 'blue');
      const s = fresh(snap.formatId, side(snap.userSide));
      const def = FORMATS[snap.formatId].def;
      s.bracket = def.brackets && def.brackets[snap.bracket] ? snap.bracket : s.bracket;
      s.pickLog = (Array.isArray(snap.pickLog) ? snap.pickLog : []).filter((p) => p && known.has(p.hero)).slice(0, 10).map((p, i) => ({
        seq: i + 1, order: Number(p.order) || 1, side: side(p.side), hero: p.hero,
        assignedRole: ROLES.includes(p.assignedRole) ? p.assignedRole : null, roleSource: p.roleSource === 'manual' ? 'manual' : 'auto',
      }));
      s.banLog = (Array.isArray(snap.banLog) ? snap.banLog : []).filter((e) => e && (e.hero == null || known.has(e.hero))).slice(0, 20).map((e) => ({
        side: side(e.side), wave: e.wave == null ? null : Number(e.wave) || 1, slot: Number(e.slot) || 1, hero: e.hero ?? null, result: e.hero == null ? 'no-ban' : 'ban',
      }));
      s.target = null;
      sync(s);
      state = s;
      history = [];
      emit();
      return true;
    },
    lastAction() { return history.length ? history[history.length - 1].action : null; },
    /** Start over: back to the initial state — picks, bans, roles, phase and history all cleared. */
    reset() {
      state = fresh(state.formatId, state.userSide);
      history = [];
      emit();
    },
    setFormat(id) {
      if (!FORMATS[id] || id === state.formatId) return;
      commit((s) => { s.formatId = id; s.target = null; s.bracket = FORMATS[id].def.brackets ? (s.bracket && FORMATS[id].def.brackets[s.bracket] ? s.bracket : FORMATS[id].def.defaultBracket) : null; }, { kind: 'format', key: id });
    },
    setUserSide(side) {
      if (side === state.userSide) return;
      commit((s) => { s.userSide = side; }, { kind: 'side', side });
    },
  };
  return api;
}
