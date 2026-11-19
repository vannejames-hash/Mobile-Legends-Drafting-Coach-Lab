// RECOMMENDATION ENGINE v1: transparent, rule-based pick/ban scoring.
//
// Every candidate gets eight named sub-scores in [0, 1], kept on the row:
//   metaScore        current competitive strength / priority (meta layer)
//   roleFit          does the hero play the open role (primary lane 1, flex lanes lower)
//   compositionFit   how much of what the team is MISSING this hero supplies
//   synergyScore     pairings with the heroes already picked
//   counterScore     how well the hero answers the enemy picks (0.5 = neutral)
//   draftPriority    should it be taken now: deny value, contested, flex, or hold for later
//   playerFit        is it in my pool for this role and how comfortable am I (0 = not in pool)
//   winConditionFit  does it reinforce how this composition wants to win
// draftFit = Σ weight × sub-score, scaled to 0–10. Weights depend on draft stage and are
// returned with each row, so "why is X #1?" is always answerable from the numbers.

import { analyzeDraft, heroVsTeam, ARCHETYPES, archetypeEdge } from './compositionEngine.js';
import { functionProfile, topFunctions, FUNCTION_LABEL } from './heroFunctions.js';
import { opp, ROLE_LABEL } from './draftState.js';
import { buildPersonalGuide } from './personalGuide.js';

const clamp01 = (v) => Math.max(0, Math.min(1, v));
const round1 = (v) => Math.round(v * 10) / 10;
const round2 = (v) => Math.round(v * 100) / 100;
const pct = (v) => `${Math.round(v * 100)}%`;
const ROLE_NAME = { exp: 'EXP', jungle: 'Jungle', mid: 'Mid', gold: 'Gold', roam: 'Roam' };

export const COMPONENTS = ['metaScore', 'roleFit', 'compositionFit', 'synergyScore', 'counterScore', 'draftPriority', 'playerFit', 'winConditionFit'];
export const COMPONENT_LABEL = {
  metaScore: 'Meta value', roleFit: 'Role fit', compositionFit: 'Composition fit', synergyScore: 'Synergy',
  counterScore: 'Counter value', draftPriority: 'Draft priority', playerFit: 'Player fit', winConditionFit: 'Win-condition fit',
};
const STRENGTH = { fl: 'frontline', en: 'engage', cc: 'crowd control', bu: 'burst', dps: 'sustained damage', po: 'poke', mob: 'mobility', pe: 'peel', su: 'sustain', ob: 'objective pressure', ac: 'backline access' };

/** Stage-dependent weights (normalized). Meta matters most for blind picks; context grows as heroes are revealed. */
export function weightsFor(allyN, enemyN, usePool) {
  const raw = {
    // meta is the prior: strongest on blind picks, shrinks as heroes are revealed
    metaScore: Math.max(0.06, 0.30 - 0.035 * (allyN + enemyN)),
    roleFit: 0.10,
    compositionFit: 0.14 + 0.05 * allyN,
    synergyScore: 0.05 + 0.03 * allyN,
    counterScore: 0.05 + 0.065 * enemyN,
    draftPriority: 0.12,
    playerFit: usePool ? 0.15 : 0,
    winConditionFit: 0.05 + 0.03 * allyN,
  };
  const sum = Object.values(raw).reduce((s, x) => s + x, 0);
  return Object.fromEntries(Object.entries(raw).map(([k, x]) => [k, x / sum]));
}

export function createRecommendationEngine({ db, meta, profile }) {
  const members = (draft, side) => draft.team(side).map(({ role, id }) => ({ role, hero: db.get(id) }));
  const analysisFor = (draft, side) => analyzeDraft(members(draft, side), members(draft, opp(side)), db);

  // ------------------------------------------------------------ sub-scores

  function metaScore(h) {
    let v = meta.presenceNorm(h.id);
    const m = meta.get(h.id);
    if (m && m.picks >= 10 && m.winRate != null) v += Math.max(-0.1, Math.min(0.1, (m.winRate - 0.5) * 0.6));
    return { value: clamp01(v), note: m ? `${pct(m.presence)} presence${m.picks >= 10 && m.winRate != null ? `, ${pct(m.winRate)} win rate` : ''}` : 'no pro data' };
  }

  function needGain(h, needs) {
    let gain = 0;
    const gains = [];
    for (const nd of needs) {
      const g = Math.min(nd.contrib(h), nd.deficit, nd.cap) * nd.pressure;
      gain += g;
      if (g > 0.15) gains.push({ nd, g });
    }
    gains.sort((x, y) => y.g - x.g);
    return { gain, gains };
  }

  /**
   * SYNERGY in three tiers, all from reusable rules (never hand-written hero pairs):
   *   direct      — curated pair data (heroes.json → "synergies"), if any
   *   functional  — complementary jobs: engage + follow-up damage, carry + peel, pickoff + lockdown …
   *   composition — does adding the hero make the five-man plan more coherent?
   * Returns { value 0–1, notes [strings], penalties [strings], tiers { direct, functional, composition } }.
   */
  function synergyScore(h, ally) {
    if (!ally.n) return { value: 0.5, notes: [], penalties: [], tiers: { direct: 0, functional: 0, composition: 0 } };
    const p = functionProfile(h);
    const tiers = { direct: 0, functional: 0, composition: 0 };
    let v = 0.4;
    const notes = [];
    const penalties = [];
    const add = (tier, dv, note) => { v += dv; tiers[tier] += dv; (dv >= 0 ? notes : penalties).push(note); };
    const allies = ally.members.map((m) => ({ m, p: functionProfile(m.hero) }));
    const who = (fn) => allies.filter((x) => fn(x.p, x.m.hero));
    // direct
    for (const x of allies) if ((h.synergies || []).includes(x.m.hero.id) || (x.m.hero.synergies || []).includes(h.id)) add('direct', 0.15, `known pairing with ${x.m.hero.name}`);
    // functional
    const engagers = who((q) => q.engage >= 0.8);
    const damage = who((q) => q.burst + q.sustainedDamage >= 1.0);
    const carries = who((q) => q.sustainedDamage >= 0.8 && q.scaling >= 0.8);
    const protectors = who((q) => q.peel >= 0.6 || q.protection >= 0.6);
    const hunters = who((q) => q.pickoff >= 0.7 || q.dive >= 0.7);
    const pokers = who((q) => q.poke >= 0.6);
    if (engagers.length && (p.burst + p.sustainedDamage >= 1.0 || p.disruption >= 0.7)) add('functional', 0.2, `follow-up for ${engagers[0].m.hero.name}'s engage`);
    if (p.engage >= 0.8 && !engagers.length && damage.length >= 2) add('functional', 0.2, `starts fights for ${damage[0].m.hero.name} and ${damage[1].m.hero.name}`);
    if (carries.length && (p.peel >= 0.6 || p.protection >= 0.6)) add('functional', 0.2, `protects ${carries[0].m.hero.name}`);
    if (protectors.length && p.sustainedDamage >= 0.8 && p.scaling >= 0.8) add('functional', 0.15, `a carry ${protectors[0].m.hero.name} can protect`);
    if (hunters.length && p.disruption >= 0.6 && p.pickoff < 0.7) add('functional', 0.1, `lockdown for ${hunters[0].m.hero.name}`);
    if (hunters.length && p.dive >= 0.7) add('functional', 0.08, `collapses together with ${hunters[0].m.hero.name}`);
    if (pokers.length && (p.zoneControl >= 0.6 || p.peel >= 0.6)) add('functional', 0.1, `holds space for ${pokers[0].m.hero.name}'s poke`);
    if (ally.damage.physicalShare >= 0.75 && ally.damage.dealers.p >= 2 && h.dmg === 'm' && p.burst + p.sustainedDamage >= 0.9) add('functional', 0.15, 'magic damage to balance a physical team');
    if (ally.damage.magicShare >= 0.75 && ally.damage.dealers.m >= 2 && h.dmg === 'p' && p.burst + p.sustainedDamage >= 0.9) add('functional', 0.15, 'physical damage to balance a magic team');
    const immobileSquishy = (x) => x.a.fl === 0 && x.a.mob <= 1;
    if (immobileSquishy(h) && ally.members.filter((m) => immobileSquishy(m.hero)).length >= 2) add('functional', -0.25, 'a third immobile backliner');
    if (p.sustainedDamage >= 0.9 && p.scaling >= 0.9 && carries.length >= 2) add('functional', -0.15, 'too many late-game carries competing for resources');
    const tanks = who((q) => q.frontline >= 0.9).length;
    if (p.frontline >= 0.9 && p.burst + p.sustainedDamage <= 0.7 && tanks >= 2) add('functional', tanks >= 3 ? -0.3 : -0.15, `a ${tanks >= 3 ? 'fourth' : 'third'} tank on an already durable team`);
    // composition: coherence of the five-man plan with vs without this hero
    if (ally.primary) {
      const A = ARCHETYPES[ally.primary.id];
      const before = ally.members.reduce((t, m) => t + A.score(m.hero), 0) / ally.n;
      const after = (before * ally.n + A.score(h)) / (ally.n + 1);
      const d = Math.max(-0.12, Math.min(0.15, (after - before) * 1.5));
      if (Math.abs(d) >= 0.04) add('composition', d, d > 0 ? `strengthens your ${A.label} plan` : `dilutes your ${A.label} plan`);
    }
    return { value: clamp01(v), notes, penalties, tiers: Object.fromEntries(Object.entries(tiers).map(([k, x]) => [k, round2(x)])) };
  }

  /** How much the hero contributes to the team's intended way of winning (primary + secondary archetype). */
  function winConditionFit(h, ally) {
    if (!ally.n || !ally.primary) return { value: 0.5, note: null };
    const P = ARCHETYPES[ally.primary.id];
    let v = 0.15 + 0.6 * clamp01(P.score(h));
    if (ally.secondary) v += 0.15 * clamp01(ARCHETYPES[ally.secondary.id].score(h));
    if (h.tags.includes(ally.primary.id)) v += 0.15;
    return { value: clamp01(v), note: `${ally.compLabel} plan` };
  }

  function draftPriority(h, { enemyFitN, allyN, open }) {
    const deny = enemyFitN ?? 0.5;
    const contested = meta.banNorm(h.id);
    const flex = h.lanes.filter((l) => open.includes(l)).length >= 2 && allyN < 3 ? 1 : 0;
    const hold = h.flags.includes('lastPick') && allyN < 3 ? 1 : 0;
    const v = 0.15 + 0.35 * deny + 0.3 * contested + 0.2 * flex - 0.35 * hold;
    const notes = [];
    if (deny >= 0.75) notes.push('the enemy wants it too');
    if (contested >= 0.6) notes.push('likely to be banned or taken');
    if (flex) notes.push('flexes across open roles');
    if (hold) notes.push('stronger as a late counter-pick');
    return { value: clamp01(v), notes, hold: !!hold };
  }

  function playerFit(h, role) {
    const stars = profile.stars(h.id, role);
    return { value: stars ? stars / 5 : 0, stars };
  }

  // ------------------------------------------------------------ pick scoring

  /**
   * Score every available hero as a pick for `side`.
   * opts.usePool: only heroes in my pool (roles from the pool); playerFit gets weight.
   * opts.lite: skip the enemy-fit pass (used internally to avoid recursion).
   */
  function scorePicks(draft, side, { usePool = false, analysis = null, lite = false, forRole = null } = {}) {
    const A = analysis || analysisFor(draft, side);
    const { ally, enemy } = A;
    const open = draft.openRoles(side);
    if (!open.length && !forRole) return [];
    const w = weightsFor(ally.n, enemy.n, usePool);

    // Deny value: how good each hero is for the OTHER side right now.
    let enemyFit = null;
    if (!lite) {
      const eRows = scorePicks(draft, opp(side), { lite: true });
      const max = Math.max(0.0001, ...eRows.map((r) => r.draftFit));
      enemyFit = new Map(eRows.map((r) => [r.hero.id, r.draftFit / max]));
    }

    const rows = [];
    for (const h of db.all) {
      if (draft.usedBy(h.id)) continue;
      const lanes = usePool ? profile.rolesFor(h.id) : h.lanes;
      let role = forRole ? (lanes.includes(forRole) ? forRole : null) : lanes.find((l) => open.includes(l));
      // Roles are flexible: if this hero's lane is held by an auto-assigned teammate who can
      // flex elsewhere, picking it would re-infer roles. Use the role it would actually take.
      if (!role && !forRole && draft.inferRole) {
        const r = draft.inferRole(side, h.id);
        if (r && h.lanes.includes(r) && lanes.includes(r)) role = r;
      }
      if (!role) continue;
      const pf = playerFit(h, usePool ? role : null);
      if (usePool && pf.stars <= 1) continue; // ★ = "Avoid"
      // Heroes with distinct forms are scored per form; the best form for this draft is kept.
      const variants = h.forms.length ? h.forms.map((f) => ({ ...h, a: f.a, form: f })) : [h];
      let best = null;
      for (const v of variants) {
        const c = { need: needGain(v, ally.needs), syn: synergyScore(v, ally), ctr: heroVsTeam(v, enemy), win: winConditionFit(v, ally), a: v.a };
        const s = c.need.gain + c.syn.value + c.ctr.value * 0.5 + c.win.value * 0.5;
        if (!best || s > best.s) best = { ...c, s, form: v.form || null };
      }
      rows.push({ hero: h, role, form: best.form, a: best.a, need: best.need, syn: best.syn, ctr: best.ctr, win: best.win, pf,
        meta: metaScore(h), prio: draftPriority(h, { enemyFitN: enemyFit?.get(h.id), allyN: ally.n, open }) });
    }

    const maxGain = Math.max(0.0001, ...rows.map((r) => r.need.gain));
    for (const r of rows) {
      const s = {
        metaScore: r.meta.value,
        roleFit: r.hero.laneWeights[r.role] ?? 0.4,
        compositionFit: ally.needs.length ? r.need.gain / maxGain : 0.5,
        synergyScore: r.syn.value,
        counterScore: clamp01(0.5 + r.ctr.value / 2),
        draftPriority: r.prio.value,
        playerFit: r.pf.value,
        winConditionFit: r.win.value,
      };
      r.scores = Object.fromEntries(Object.entries(s).map(([k, v]) => [k, round2(v)]));
      r.weights = w;
      r.draftFit = COMPONENTS.reduce((sum, k) => sum + w[k] * s[k], 0) * 10;
      r.score = round1(r.draftFit);
      r.stars = r.pf.stars;
      r.youScore = r.score; // playerFit is already weighted in pool mode
      r.risks = r.ctr.risks;
      // legacy aliases used by the UI
      r.parts = r.scores;
    }
    rows.sort((x, y) => y.draftFit - x.draftFit);
    if (!lite) {
      // Reasons = components that lift this hero above a baseline. With few candidates (e.g. a small pool)
      // the candidate mean is meaningless, so a neutral baseline is used instead.
      const NEUTRAL = { metaScore: 0.3, roleFit: 0.9, compositionFit: 0.5, synergyScore: 0.5, counterScore: 0.5, draftPriority: 0.5, playerFit: 0.4, winConditionFit: 0.5 };
      const means = rows.length >= 8
        ? Object.fromEntries(COMPONENTS.map((k) => [k, rows.reduce((t, r) => t + r.scores[k], 0) / rows.length]))
        : NEUTRAL;
      for (const r of rows) { r.lift = Object.fromEntries(COMPONENTS.map((k) => [k, round2(w[k] * (r.scores[k] - means[k]) * 10)])); r.reasons = buildReasons(r, ally); }
    }
    return rows;
  }

  /** Short, component-based reasons, strongest above-average contributors first. */
  function buildReasons(r, ally) {
    const out = [];
    const order = COMPONENTS.filter((k) => r.lift[k] > 0.05).sort((x, y) => r.lift[y] - r.lift[x]);
    for (const k of order) {
      const t = componentText(k, r, ally);
      if (t) out.push(t);
      if (out.length >= 3) break;
    }
    if (!out.length) out.push(`Fills ${ROLE_NAME[r.role]}`);
    if (r.form) out[0] = `${r.form.label}: ${out[0].charAt(0).toLowerCase()}${out[0].slice(1)}`;
    if (r.scores.roleFit < 1 && r.hero.laneWeights[r.role]) out.push(`${ROLE_NAME[r.role]} is a flex lane (primary: ${ROLE_NAME[r.hero.primaryLane]})`);
    return out;
  }

  function componentText(k, r, ally) {
    switch (k) {
      case 'compositionFit': {
        const g = r.need.gains.slice(0, 2).map((x) => x.nd.short);
        return g.length ? `Your team needs ${joinList(g)}` : null;
      }
      case 'counterScore': return r.ctr.reasons[0] || null;
      case 'synergyScore': return r.syn.notes[0] ? cap(r.syn.notes[0]) : null;
      case 'winConditionFit': return ally.primary ? `Improves your ${ally.compLabel} win condition` : null;
      case 'metaScore': return r.meta.note !== 'no pro data' ? `${cap(r.meta.note)} in pro play` : null;
      case 'draftPriority': return r.prio.notes[0] ? cap(r.prio.notes[0]) : null;
      case 'playerFit': return r.pf.stars ? `Fits your ${ROLE_NAME[r.role]} pool (${'★'.repeat(r.pf.stars)})` : null;
      case 'roleFit': return null;
      default: return null;
    }
  }

  /** Why is `heroId` not the top pick? Compares its sub-scores with the top row. */
  function explainNotTop(rows, heroId, ally, scoreOf = (x) => x.score) {
    const top = rows[0];
    const r = rows.find((x) => x.hero.id === heroId);
    if (!r) return { hero: heroId, text: 'Not a legal or available candidate for the open roles.' };
    if (r === top) return { hero: heroId, rank: 1, text: `${r.hero.name} is the top pick.` };
    const deltas = COMPONENTS.map((k) => ({ k, d: r.weights[k] * (r.scores[k] - top.scores[k]) * 10 })).sort((x, y) => x.d - y.d);
    const losing = deltas.filter((x) => x.d < -0.05).slice(0, 2);
    const winning = deltas.filter((x) => x.d > 0.05).sort((x, y) => y.d - x.d)[0];
    const why = losing.map(({ k }) => weaknessText(k, r, ally)).filter(Boolean);
    const strengths = Object.entries(r.a).filter(([k, v]) => v >= 3 && STRENGTH[k]).map(([k]) => STRENGTH[k]);
    const metaHigh = r.scores.metaScore >= 0.8;
    const text = `${r.hero.name} ranks #${rows.indexOf(r) + 1} (${scoreOf(r).toFixed(1)}) behind ${top.hero.name} (${scoreOf(top).toFixed(1)}).`
      + (metaHigh ? ` It has high meta value (${r.meta.note}),` : '')
      + (winning && !(metaHigh && winning.k === 'metaScore') ? ` ${metaHigh ? 'and' : 'It'} leads on ${COMPONENT_LABEL[winning.k].toLowerCase()} (${r.scores[winning.k]} vs ${top.scores[winning.k]}),` : '')
      + (metaHigh || (winning && !(metaHigh && winning.k === 'metaScore')) ? ' but' : ' Held back by')
      + ` ${why.length ? why.join(' and ') : 'several dimensions at once'}.`
      + (ally.n && strengths.length && losing.some((x) => x.k === 'compositionFit') ? ` Its strengths (${joinList(strengths.slice(0, 3))}) are already covered.` : '');
    return { hero: heroId, rank: rows.indexOf(r) + 1, text, deltas: Object.fromEntries(deltas.map(({ k, d }) => [k, round2(d)])) };
  }

  function weaknessText(k, r, ally) {
    switch (k) {
      case 'compositionFit': return `low composition fit (${r.scores.compositionFit}): it adds little your team is missing`;
      case 'synergyScore': return r.syn.penalties[0] ? `poor synergy: ${r.syn.penalties[0]}` : `weak synergy with your picks (${r.scores.synergyScore})`;
      case 'counterScore': return r.ctr.risks[0] ? `counter risk: ${r.ctr.risks[0].toLowerCase()}` : `low counter value (${r.scores.counterScore})`;
      case 'winConditionFit': return ally.primary ? `it doesn't reinforce your ${ARCHETYPES[ally.primary.id].label} plan (${r.scores.winConditionFit})` : null;
      case 'roleFit': return `${ROLE_NAME[r.role]} is not its main lane`;
      case 'draftPriority': return r.prio.hold ? 'it is better held as a late counter-pick' : `lower urgency to pick now (${r.scores.draftPriority})`;
      case 'metaScore': return `lower meta value (${r.meta.note})`;
      case 'playerFit': return r.pf.stars ? `lower comfort (${r.pf.stars}★)` : 'not in your pool';
      default: return null;
    }
  }

  function timingTag(r, allyN) {
    if (r.scores.counterScore >= 0.72) return 'COUNTER';
    if (r.prio.notes.includes('the enemy wants it too') && r.scores.metaScore >= 0.45) return 'DENY';
    if (r.prio.hold && r.scores.counterScore < 0.65) return 'HOLD';
    if (r.prio.notes.includes('flexes across open roles') && allyN < 3) return 'FLEX';
    return 'PICK NOW';
  }

  // ------------------------------------------------------------ v1 analysis

  /**
   * Transparent v1 output for one side:
   * { topPick, alternative, counterPick, why, teamNeed, enemyThreat, archetype, rows, explainNotTop }
   */
  function analyze(draft, side, { usePool = false } = {}) {
    const A = analysisFor(draft, side);
    const rows = scorePicks(draft, side, { usePool, analysis: A });
    for (const r of rows) r.tag = timingTag(r, A.ally.n);
    const topPick = rows[0] || null;
    const alternative = rows.find((r) => r !== topPick && r.role !== topPick?.role) || rows[1] || null;
    const counterPick = rows.slice(0, 15).filter((r) => r !== topPick && r.scores.counterScore >= 0.6)
      .sort((x, y) => y.scores.counterScore - x.scores.counterScore || y.draftFit - x.draftFit)[0] || null;
    const needs = A.ally.needs.filter((n) => n.pressure >= 0.3).slice(0, 2).map((n) => n.short);
    return {
      side, rows, topPick, alternative, counterPick,
      why: topPick ? topPick.reasons.slice(0, 3) : [],
      teamNeed: needs.length ? cap(needs.join(' + ')) : null,
      enemyThreat: A.enemy.threat?.label || null,
      archetype: A.ally.compLabel || null,
      analysis: A,
      explainNotTop: (heroId) => explainNotTop(rows, heroId, A.ally),
    };
  }

  // ------------------------------------------------------------ bans

  /** Score bans for `side` (heroes the opponent of `side` would want). Components stay visible. */
  function scoreBans(draft, side) {
    const A = analysisFor(draft, side);
    const eRows = scorePicks(draft, opp(side), { lite: true });
    const max = Math.max(0.0001, ...eRows.map((r) => r.draftFit));
    const enemyFits = new Map(eRows.map((r) => [r.hero.id, r.draftFit / max]));
    const ourOpen = draft.openRoles(side);
    const isUser = side === draft.userSide;
    const rows = [];
    for (const h of db.all) {
      // format-specific legality (blind ranked waves allow the other side's same-wave ban)
      if (draft.canAct ? !draft.canAct(h.id).ok : draft.usedBy(h.id)) continue;
      const t = heroVsTeam(h, A.ally);
      const scores = {
        banRate: round2(meta.banNorm(h.id)),
        enemyFit: round2(enemyFits.get(h.id) || 0),
        threatToUs: round2(Math.max(0, t.value)),
        ownPool: isUser && profile.rolesFor(h.id).some((r) => ourOpen.includes(r) && profile.stars(h.id, r) >= 4) ? 1 : 0,
      };
      const weights = { banRate: 0.45, enemyFit: 0.35, threatToUs: 0.2, ownPool: -0.15 };
      const fit = clamp01(Object.keys(weights).reduce((s, k) => s + weights[k] * scores[k], 0));
      const reasons = [];
      const m = meta.get(h.id);
      if (m && m.banRate >= 0.25) reasons.push(`${pct(m.banRate)} ban rate`);
      if (scores.enemyFit >= 0.75 && A.enemy.n) reasons.push('Fits the enemy draft');
      if (t.reasons.length) reasons.push(t.reasons[0].replace(/^Counters/, 'Threatens your'));
      if (scores.ownPool) reasons.push('In your pool: you may want it');
      if (!reasons.length) reasons.push(m ? `${pct(m.presence)} presence` : 'Flexible threat');
      rows.push({ hero: h, role: h.primaryLane, scores, weights, parts: scores, draftFit: fit * 10, score: round1(fit * 10), reasons, risks: [], tag: 'BAN' });
    }
    rows.sort((a, b) => b.draftFit - a.draftFit);
    return rows;
  }

  // ------------------------------------------------------------ per-step entry point

  /** Recommendations for the current legal action. Returns { kind, side, isAlly, theoretical, forYou, analysis, v1 }. */
  function forStep(draft, step) {
    const side = step.side;
    const isAlly = side === draft.userSide;
    if (step.type === 'ban') {
      return { kind: 'ban', side, isAlly, theoretical: scoreBans(draft, side), forYou: [], analysis: analysisFor(draft, side) };
    }
    const theory = analyze(draft, side);
    const mine = isAlly ? analyze(draft, side, { usePool: true }) : null;
    return { kind: 'pick', side, isAlly, theoretical: theory.rows, forYou: mine ? mine.rows : [], analysis: theory.analysis, v1: { theory, mine } };
  }

  // ------------------------------------------------------------ context scoring + draft rating

  /**
   * The eight sub-scores for one hero in an explicit context (used for rating a finished draft).
   * allyOthers: the hero's team WITHOUT the hero; enemyMembers: the enemy team.
   * compositionFit is absolute here: the hero's need-gain vs. the best possible hero for that role.
   */
  function scoreInContext(hero, role, allyOthers, enemyMembers, { stars = 0 } = {}) {
    const A = analyzeDraft(allyOthers, enemyMembers, db);
    const gain = needGain(hero, A.ally.needs).gain;
    const best = Math.max(0, ...db.all.filter((h) => h.lanes.includes(role)).map((h) => needGain(h, A.ally.needs).gain));
    return {
      metaScore: round2(metaScore(hero).value),
      roleFit: round2(hero.laneWeights[role] ?? 0.4),
      compositionFit: round2(best > 0 ? clamp01(gain / best) : 1),
      synergyScore: round2(synergyScore(hero, A.ally).value),
      counterScore: round2(clamp01(0.5 + heroVsTeam(hero, A.enemy).value / 2)),
      draftPriority: round2(draftPriority(hero, { enemyFitN: null, allyN: 4, open: [role] }).value),
      playerFit: round2(stars ? stars / 5 : 0),
      winConditionFit: round2(winConditionFit(hero, A.ally).value),
    };
  }

  /**
   * DRAFT RATING (0–10): how coherent and favourable a composition is, from the information
   * available. It is a draft quality / fit score, NOT a win probability.
   * Built from the eight sub-scores of each pick (scored in the final context) plus two
   * team-level checks (unmet needs, matchup vs. the enemy draft). Every input is returned.
   */
  function rateDraft(draft, side, { myHero = null } = {}) {
    const ally = members(draft, side);
    const enemy = members(draft, opp(side));
    if (!ally.length) return null;
    const perPick = ally.map((m) => ({
      hero: m.hero.id, role: m.role,
      scores: scoreInContext(m.hero, m.role, ally.filter((x) => x !== m), enemy, { stars: profile.stars(m.hero.id, m.role) }),
    }));
    const mean = (k) => perPick.reduce((s, p) => s + p.scores[k], 0) / perPick.length;
    const A = analyzeDraft(ally, enemy, db);
    const unmet = Math.min(1, A.ally.needs.reduce((s, n) => s + n.pressure, 0) / 2.5);
    // a clear identity only counts if the team can actually execute it (gaps reduce clarity)
    const clarity = (A.ally.primary ? clamp01(A.ally.primary.score / 0.75) : 0.4) * (1 - 0.5 * unmet);
    let matchup = 0.5;
    if (enemy.length) {
      const coh = (t) => t.primary?.score || 0;
      const ctr = (t, o) => t.members.reduce((s, m) => s + heroVsTeam(m.hero, o).value, 0) / Math.max(1, t.n);
      const gaps = (t) => Math.min(1, t.needs.reduce((s, n) => s + n.pressure, 0) / 3);
      const edge = archetypeEdge(A.ally.primary?.id, A.enemy.primary?.id) * 0.3; // composition counter
      matchup = clamp01(0.5 + ((coh(A.ally) - coh(A.enemy)) * 3 + (ctr(A.ally, A.enemy) - ctr(A.enemy, A.ally)) * 2.5 + (gaps(A.enemy) - gaps(A.ally)) * 2 + edge) / 3);
    }
    const mine = myHero && perPick.find((p) => p.hero === myHero);
    const components = {
      compositionQuality: round2(0.5 * mean('compositionFit') + 0.5 * (1 - unmet)),
      synergy: round2(mean('synergyScore')),
      counterValue: round2(mean('counterScore')),
      winConditionClarity: round2(0.5 * mean('winConditionFit') + 0.5 * clarity),
      // lanes filled AND doing useful work (frontline, initiation, protection, damage, control)
      roleCoverage: round2(0.5 * mean('roleFit') + 0.5 * A.ally.coverage.score),
      metaValue: round2(mean('metaScore')),
      enemyMatchup: round2(matchup),
      playerFit: mine ? round2(mine.scores.playerFit || 0.4) : null, // not in pool → 0.4, unknown hero → excluded
    };
    const W = { compositionQuality: 0.22, synergy: 0.12, counterValue: 0.13, winConditionClarity: 0.12, roleCoverage: 0.10, metaValue: 0.09, enemyMatchup: 0.14, playerFit: 0.08 };
    const used = Object.keys(W).filter((k) => components[k] != null);
    const wSum = used.reduce((s, k) => s + W[k], 0);
    const weights = Object.fromEntries(used.map((k) => [k, round2(W[k] / wSum)]));
    const raw = used.reduce((s, k) => s + (W[k] / wSum) * components[k], 0);
    const rating = round1(raw * 10);
    return {
      rating, ...ratingBand(rating), components, weights, perPick,
      coverage: A.ally.coverage, damage: A.ally.damage, archetypes: { ally: A.ally.compLabel, enemy: A.enemy.compLabel },
      partial: ally.length < 5 || enemy.length < 5,
      note: 'Draft rating measures composition quality and fit from the picks made. It is not a win probability.',
    };
  }

  /** Why the best pick FOR YOU differs from the theoretical best: component-by-component contrast. */
  function contrastPicks(mine, theory) {
    if (!mine || !theory || mine.hero.id === theory.hero.id) return null;
    const TXT = {
      metaScore: 'stronger meta value', roleFit: 'better role fit', compositionFit: 'fits the current composition better',
      synergyScore: 'better synergy with your picks', counterScore: 'better counter value', winConditionFit: 'fits your win condition better',
      draftPriority: 'more urgent to secure',
    };
    const forMine = [];
    const forTheory = [];
    for (const k of Object.keys(TXT)) {
      const d = (mine.scores[k] ?? 0) - (theory.scores[k] ?? 0);
      if (d > 0.1) forMine.push(TXT[k]);
      if (d < -0.1) forTheory.push(TXT[k]);
    }
    if (mine.stars) forMine.unshift(`higher proficiency (${'★'.repeat(mine.stars)})`);
    forMine.push('in your active pool');
    return { mine: mine.hero.name, theory: theory.hero.name, forMine, forTheory, gap: round1(theory.draftFit - mine.draftFit) };
  }

  // ------------------------------------------------------------ role-first recommendations

  const ROLE_SUPPLY_CACHE = new Map();
  /** How much heroes of a role typically supply a need (0–1). */
  function roleSupply(need, role) {
    const key = `${need.id}|${need.label}|${role}`;
    if (!ROLE_SUPPLY_CACHE.has(key)) {
      const hs = db.all.filter((h) => h.lanes.includes(role));
      ROLE_SUPPLY_CACHE.set(key, hs.reduce((t, h) => t + Math.min(need.contrib(h), need.cap), 0) / Math.max(1, hs.length) / need.cap);
    }
    return ROLE_SUPPLY_CACHE.get(key);
  }

  /** What does this composition need from a specific role? Top needs that role can realistically supply. */
  function roleNeed(role, ally) {
    const needs = ally.needs
      .map((n) => ({ n, w: n.pressure * roleSupply(n, role) }))
      .filter((x) => x.n.pressure >= 0.2 && roleSupply(x.n, role) >= 0.3)
      .sort((a, b) => b.w - a.w).slice(0, 2).map((x) => x.n);
    const STRONG = ['frontline', 'engage', 'peel', 'burst', 'sustainedDamage', 'dive', 'objectiveControl', 'poke'];
    const have = STRONG.filter((f) => ally.vector[f] >= 1.0).sort((a, b) => ally.vector[b] - ally.vector[a]).slice(0, 2).map((f) => FUNCTION_LABEL[f].toLowerCase());
    const labels = needs.map((n) => n.short);
    let why;
    if (!ally.n) why = `No picks yet: take the strongest, most flexible ${ROLE_NAME[role]} option.`;
    else if (!labels.length) why = `Your team has no structural gap ${ROLE_NAME[role]} must fill; pick for synergy and counters.`;
    else why = `${have.length ? `Your team already has ${joinList(have)} but` : 'Your team'} lacks ${joinList(labels)}.`;
    return { needs, labels, why };
  }

  const THREAT_ADVICE = {
    dive: { backline: 'Prefer a {Role} hero with stronger self-protection (mobility, durability or anti-dive).', front: 'Prefer peel or anti-dive tools to protect your backline.', jungle: 'Prefer a jungler who can turn on divers or peel for the backline.' },
    engage: { backline: 'Prefer range and escape tools so their engage cannot catch you.', front: 'Prefer counter-engage or disengage tools.', jungle: 'Prefer a jungler who can punish their engage from the flank.' },
    pickoff: { all: 'Prefer a durable or self-sufficient {Role} hero; avoid giving them an easy target.' },
    poke: { all: 'Prefer a {Role} hero who can engage or close gaps quickly.' },
    protect: { all: 'Prefer backline access or anti-heal to reach their protected carry.' },
    scaling: { all: 'Prefer early pressure to close the game before they scale.' },
    frontline: { all: 'Prefer sustained damage or penetration to break their frontline.' },
    split: { all: 'Prefer a {Role} hero who can hold or answer a side lane.' },
  };
  function threatAdvice(role, enemy) {
    const top = (enemy.threats || [])[0];
    if (!top) return null;
    const t = THREAT_ADVICE[top.id] || {};
    const kind = role === 'gold' || role === 'mid' ? 'backline' : role === 'jungle' ? 'jungle' : 'front';
    const text = (t[kind] || t.all || t.backline || '').replace('{Role}', ROLE_NAME[role]);
    return { id: top.id, label: top.label, heroes: top.heroes, level: top.level, advice: text };
  }

  /** Which open roles most need filling next (1–2), ranked by need pressure × what the role supplies. */
  function suggestRoles(draft, side) {
    const A = analysisFor(draft, side);
    const open = draft.openRoles(side);
    const ranked = open.map((r) => ({ role: r, score: A.ally.needs.reduce((t, n) => t + n.pressure * roleSupply(n, r), 0) })).sort((a, b) => b.score - a.score);
    if (!ranked.length) return [];
    return ranked.filter((x, i) => i === 0 || (i === 1 && x.score >= ranked[0].score * 0.8)).map((x) => x.role);
  }

  const tagsFor = (r) => topFunctions(r.form ? { ...r.hero, a: r.form.a, form: r.form } : r.hero, 0.6, 3).map(([k]) => FUNCTION_LABEL[k]);

  /**
   * ROLE-FIRST recommendations: "what should our <role> pick?" Independent of myRole.
   * Returns { role, filledBy, need, threat, best, safe, counter, cards, mine, theory, preferPool, compelling, rows }.
   * When role === myRole, the player's pool leads (best FOR YOU), with the theoretical best shown separately.
   */
  function recommendForRole(draft, side, role, { myRole = null } = {}) {
    const A = analysisFor(draft, side);
    const theory = scorePicks(draft, side, { analysis: A, forRole: role });
    const mine = scorePicks(draft, side, { analysis: A, forRole: role, usePool: true });
    for (const r of [...theory, ...mine]) r.tag = timingTag(r, A.ally.n);
    const personal = myRole === role && mine.length > 0;
    const gap = theory[0] && mine[0] ? round1(theory[0].draftFit - mine[0].draftFit) : null;
    const compelling = personal && gap != null && gap >= 1.5 && !profile.rolesFor(theory[0].hero.id).includes(role)
      ? { hero: theory[0].hero, score: theory[0].score, gap } : null;
    const rows = personal ? mine : theory;
    const pool = rows.slice(0, 12);
    const best = pool[0] || null;
    const counter = pool.filter((r) => r !== best && r.scores.counterScore >= 0.55).sort((a, b) => b.scores.counterScore - a.scores.counterScore || b.draftFit - a.draftFit)[0] || null;
    const safeScore = (r) => r.draftFit - 1.5 * r.risks.length + (r.scores.roleFit >= 1 ? 1 : 0) + 0.8 * r.scores.compositionFit + (personal ? 2 * r.scores.playerFit : 0);
    const safe = pool.filter((r) => r !== best && r !== counter).sort((a, b) => safeScore(b) - safeScore(a))[0] || null;
    const card = (slot, label, r) => r && ({
      slot, label, row: r, hero: r.hero, score: r.score, tags: tagsFor(r),
      why: slot === 'safe'
        ? [r.scores.roleFit >= 1 ? `Natural ${ROLE_NAME[role]} pick` : null, r.risks.length ? null : 'No counter-pick risk from the enemy draft', ...r.reasons.slice(0, 2)].filter(Boolean).slice(0, 3)
        : slot === 'counter'
          ? [...r.ctr.reasons.slice(0, 2), ...r.reasons.filter((x) => !r.ctr.reasons.includes(x)).slice(0, 1)].slice(0, 3)
          : r.reasons.slice(0, 4),
    });
    // No counter evidence yet (e.g. no enemy picks): the third slot becomes the next-best alternative.
    const alt = counter ? null : pool.find((r) => r !== best && r !== safe) || null;
    const cards = [card('best', 'Best', best), card('safe', 'Safe', safe), counter ? card('counter', 'Counter', counter) : card('alt', 'Alternative', alt)].filter(Boolean);
    return {
      role, filledBy: draft.state.picks[side][role] || null, personal,
      need: roleNeed(role, A.ally), threat: threatAdvice(role, A.enemy),
      best, safe, counter, cards, rows,
      mine: mine.slice(0, 2), theory: theory.slice(0, 1), overall: theory[0] || null, theoryRows: theory,
      preferPool: personal && gap != null && gap < 1.5, compelling,
      analysis: A,
    };
  }

  // ------------------------------------------------------------ role board: the full decision space

  const CURATED_COUNTER = new Set(db.all.flatMap((h) => (h.counters.length ? [h.id, ...h.counters] : [])));
  const metaName = () => (meta.source || 'competitive dataset').split(' —')[0];

  /**
   * How much the analysis can be trusted for this hero, from the data that actually exists
   * (hero-profile review status, competitive sample size, curated counter data). Never invented.
   */
  function confidence(h) {
    const reasons = [];
    let pts = 0;
    if (h.profile === 'reviewed') { pts += 2; reasons.push('reviewed hero profile'); }
    else if (h.profile === 'provisional') reasons.push('provisional hero profile');
    else { pts += 1; reasons.push('baseline hero profile (ratings not individually reviewed)'); }
    const m = meta.hasData ? meta.get(h.id) : null;
    if (!m) reasons.push('no competitive data loaded: meta value is unavailable');
    else if (m.picks + m.bans >= 10) { pts += 2; reasons.push(`${m.picks} picks and ${m.bans} bans in ${metaName()}`); }
    else if (m.picks + m.bans > 0) { pts += 1; reasons.push(`small competitive sample (${m.picks + m.bans} picks/bans in ${metaName()})`); }
    else reasons.push(`no picks or bans in ${metaName()}: meta value is a factual zero, not an estimate`);
    if (CURATED_COUNTER.has(h.id)) { pts += 1; reasons.push('curated counter data'); }
    const level = h.provisional ? 'Provisional' : pts >= 3 ? 'High' : pts === 2 ? 'Medium' : 'Provisional';
    return { level, reasons };
  }

  const ADV = {
    counterScore: 'Better answer to the enemy draft', synergyScore: 'Better synergy with your picks', compositionFit: 'Covers more of what your team lacks',
    metaScore: 'Higher competitive priority', winConditionFit: 'Fits your win condition better', draftPriority: 'More urgent to secure', roleFit: 'More natural in this role',
  };
  const DEF = {
    counterScore: 'answers the enemy draft less well', synergyScore: 'weaker synergy with your picks', compositionFit: 'adds less of what your team is missing',
    metaScore: 'lower competitive priority', winConditionFit: 'reinforces your win condition less', draftPriority: 'less urgent to take now', roleFit: 'this is not its main lane',
  };

  /** One-sentence "why this hero?", relative to the best answer when it is not the best answer. */
  function whyLine(e, top, role) {
    const r = e.row;
    const gains = r.need.gains.slice(0, 2).map((x) => x.nd.short);
    if (e === top) {
      if (gains.length) return `Your team lacks ${joinList(gains)}; ${r.hero.name} supplies it${r.ctr.reasons[0] ? `, and ${lc(r.ctr.reasons[0])}` : ''}.`;
      if (r.ctr.reasons[0]) return `${r.ctr.reasons[0]}.`;
      if (r.syn.notes[0]) return `${cap(r.syn.notes[0])}.`;
      return `Strongest all-round ${ROLE_NAME[role]} option for this draft.`;
    }
    const d = COMPONENTS.filter((k) => ADV[k]).map((k) => ({ k, d: e.weights[k] * (e.scores[k] - top.scores[k]) })).sort((a, b) => b.d - a.d);
    const adv = d.find((x) => x.d > 0.004);
    const def = [...d].reverse().find((x) => x.d < -0.004);
    const lead = adv ? (adv.k === 'counterScore' && r.ctr.reasons[0] ? `${r.ctr.reasons[0]}` : `${ADV[adv.k]} than ${top.hero.name}`) : `Similar job to ${top.hero.name}`;
    return `${lead}${def ? `, but ${DEF[def.k]}` : ''}.`;
  }

  /**
   * ROLE BOARD: every available hero for `role`, ranked and explained. The visible Draft Fit (0–10)
   * uses the same eight sub-scores and stage weights as the engine, calibrated against the best value
   * any available hero for this role reaches on each dimension in THIS draft (floor 0.6, so weak fields
   * are not inflated). Best overall (team view) and best for you (pool-weighted) are kept separate.
   */
  function roleBoard(draft, side, role, { myRole = null } = {}) {
    const rec = recommendForRole(draft, side, role, { myRole });
    const { ally, enemy } = rec.analysis;
    const theory = rec.theoryRows;
    const w = weightsFor(ally.n, enemy.n, false);
    const wYou = weightsFor(ally.n, enemy.n, true);
    const ceil = Object.fromEntries(COMPONENTS.map((k) => [k, Math.max(0.6, ...theory.map((r) => r.scores[k]))]));
    ceil.playerFit = 1;
    const cal = (sc, W) => {
      let num = 0; let den = 0;
      for (const k of COMPONENTS) { num += W[k] * Math.min(sc[k], ceil[k]); den += W[k] * ceil[k]; }
      return Math.min(10, (10 * num) / Math.max(1e-6, den));
    };
    const personal = myRole === role;
    const entries = theory.map((r) => {
      const stars = profile.stars(r.hero.id, role);
      const scores = { ...r.scores, playerFit: round2(stars / 5) };
      const fitRaw = cal(scores, w);
      const conf = confidence(r.hero);
      const flags = {
        counter: enemy.n > 0 && scores.counterScore >= 0.62 && r.ctr.reasons.length > 0,
        safe: !r.risks.length && scores.roleFit >= 1 && !r.prio.hold && conf.level !== 'Provisional',
        situational: r.prio.hold || scores.roleFit < 1 || r.risks.length > 0 || conf.level === 'Provisional',
        offMeta: scores.metaScore < 0.1,
      };
      return {
        row: r, hero: r.hero, role, form: r.form, scores, weights: w, stars,
        pool: stars >= 5 ? 'comfort' : stars >= 2 ? 'pool' : stars === 1 ? 'avoid' : 'off',
        fitRaw, fit: round1(fitRaw), youFit: round1(cal(scores, wYou)), ...fitTier(fitRaw),
        tags: tagsFor(r), confidence: conf, flags, risks: r.risks, tag: r.tag,
      };
    }).sort((a, b) => b.fitRaw - a.fitRaw || b.row.draftFit - a.row.draftFit);
    entries.forEach((e, i) => { e.rank = i + 1; });
    for (const e of entries) e.flags.safe = e.flags.safe && e.fit >= 6;
    const top = entries[0] || null;
    for (const e of entries) e.why = whyLine(e, top, role);

    const used = new Set();
    const take = (key, label, hint, pred, max = Infinity) => {
      const list = entries.filter((e) => !used.has(e) && pred(e)).slice(0, max);
      list.forEach((e) => used.add(e));
      return { key, label, hint, entries: list };
    };
    const sections = [
      take('best', 'Best fit', 'The five strongest answers for this draft', (e) => e.rank <= 5),
      take('counter', 'Counter picks', 'Their value comes from answering an enemy threat', (e) => e.flags.counter, 5),
      take('safe', 'Safe picks', 'Reliable heroes with low draft risk', (e) => e.flags.safe, 5),
      take('strong', 'Strong alternatives', 'Work well, but solve slightly different problems', (e) => e.fit >= 6.5, 10),
      take('offpool', personal ? 'Off-pool / off-meta options' : 'Off-meta options', personal ? 'Viable for the draft, but outside your pool or with little competitive presence' : 'Viable for the draft, with little competitive presence', (e) => e.fit >= 6 && (e.flags.offMeta || (personal && e.stars < 2))),
      take('situational', 'Situational picks', 'Become strong only under specific conditions', (e) => e.fit >= 5),
      take('low', 'Low fit / niche', 'The rest of the role', () => true),
    ].filter((x) => x.entries.length);
    for (const sec of sections) for (const e of sec.entries) e.section = sec.key;

    const forYou = entries.filter((e) => e.stars >= 2).sort((a, b) => b.youFit - a.youFit || b.fitRaw - a.fitRaw)[0] || null;
    let forYouNote = null;
    if (forYou && top) {
      const gap = round1(top.fitRaw - forYou.fitRaw);
      forYouNote = forYou === top ? 'Your best pool option is also the best overall answer.'
        : gap < 1 ? `${forYou.hero.name} is preferred: it is in your pool (${'★'.repeat(forYou.stars)}) and only ${gap.toFixed(1)} below the best overall, while still fitting the draft.`
          : `${top.hero.name} is ${gap.toFixed(1)} ahead on draft fit. ${forYou.hero.name} is your strongest pool option; consider ${top.hero.name} if you can play it.`;
    }
    const th = rec.threat;
    // "damage" is redundant next to "sustained damage": keep the more specific label
    const labels = rec.need.labels.filter((l, i, xs) => !xs.some((o, j) => j !== i && o !== l && o.includes(l)));
    const need = {
      primary: labels[0] ? cap(labels[0]) : null,
      secondary: labels[1] ? cap(labels[1]) : null,
      risk: th ? `${th.label}${th.heroes.length ? ` (${th.heroes.join(', ')})` : ''}` : null,
      why: whyMatters(role, rec.analysis, { ...rec.need, labels }), advice: th?.advice || null,
    };
    // an off-pool hero that is dramatically better than anything you play here
    const compelling = personal && forYou && top && top.stars < 2 && top.fitRaw - forYou.fitRaw >= 1.5
      ? { hero: top.hero, fit: top.fit, gap: round1(top.fitRaw - forYou.fitRaw), why: top.why } : null;
    const board = { role, personal, entries, sections, bestOverall: top, bestForYou: forYou, forYouNote, compelling, need, weights: w, ceilings: ceil, calibration: CALIBRATION_NOTE };

    /**
     * Compare 2–3 heroes on every dimension, then a conditional decision:
     * "X is the best overall fit. Y becomes preferable if <its strongest relative advantage matters most>."
     */
    board.compare = (ids) => {
      const es = ids.map((id) => entries.find((e) => e.hero.id === id)).filter(Boolean);
      if (es.length < 2) return null;
      const EXTRA = { scaling: ['Scaling', (h) => functionProfile(h).scaling], early: ['Early game', (h) => functionProfile(h).earlyPressure] };
      const rows = [
        { key: 'fit', label: 'Draft fit', values: es.map((e) => e.fit) },
        ...COMPONENTS.map((k) => ({ key: k, label: COMPONENT_LABEL[k], values: es.map((e) => round1(e.scores[k] * 10)) })),
        ...Object.entries(EXTRA).map(([k, [label, f]]) => ({ key: k, label, values: es.map((e) => round1(f(e.hero) * 10)) })),
      ].map((r) => ({ ...r, best: Math.max(...r.values) }));
      const lead = [...es].sort((a, b) => b.fitRaw - a.fitRaw)[0];
      const topAlly = ally.members.length ? [...ally.members].sort((a, b) => synergyScore(b.hero, ally).value - synergyScore(a.hero, ally).value)[0]?.hero.name : null;
      const COND = {
        counterScore: th ? `if ${lc(th.label)} becomes the primary concern` : 'once the enemy reveals a hero it answers',
        playerFit: 'if execution matters more than a small fit gap: it is in your pool',
        synergyScore: topAlly ? `if you want the tightest link with ${topAlly}` : 'if synergy with your next picks matters most',
        compositionFit: `if covering ${need.primary ? lc(need.primary) : 'your team gaps'} is the priority`,
        metaScore: 'if you prefer the proven competitive pick',
        winConditionFit: 'if you commit fully to your win condition',
        draftPriority: 'if you must secure it before the enemy can',
        roleFit: 'if lane comfort matters most',
        scaling: 'if the game is likely to go long',
        early: 'if you want to win the early game',
      };
      const decision = [`${lead.hero.name} is the best overall fit (${lead.fit.toFixed(1)}).`];
      const used = new Set(); // each alternative gets its own reason, not a repeated one
      for (const e of es) {
        if (e === lead) continue;
        const cands = [
          ...COMPONENTS.map((k) => ({ k, d: (e.scores[k] - lead.scores[k]) * (k === 'playerFit' ? 0.15 : w[k]) })),
          ...Object.entries(EXTRA).map(([k, [, f]]) => ({ k, d: (f(e.hero) - f(lead.hero)) * 0.06 })),
        ].filter((x) => x.d > 0.004).sort((a, b) => b.d - a.d);
        const adv = cands.find((x) => !used.has(x.k)) || cands[0];
        if (adv) used.add(adv.k);
        decision.push(adv ? `${e.hero.name} becomes preferable ${COND[adv.k]}.` : `${e.hero.name} does not beat ${lead.hero.name} on any dimension in this draft.`);
      }
      return { heroes: es.map((e) => ({ hero: e.hero, fit: e.fit, tone: e.tone })), rows, decision };
    };

    /** Deep data for one hero (hover card): everything is derived from the board row. */
    board.detail = (heroId) => {
      const e = entries.find((x) => x.hero.id === heroId);
      if (!e) return null;
      const g = buildPersonalGuide({ db, ally: ally.members, enemy: enemy.members, role, heroId });
      return {
        hero: e.hero, role, rank: e.rank, of: entries.length, fit: e.fit, tier: e.label, tone: e.tone, tags: e.tags, stars: e.stars, pool: e.pool,
        why: e.why, reasons: [...e.row.reasons, ...e.row.syn.penalties.map((x) => `Synergy concern: ${x}`)].slice(0, 4),
        breakdown: COMPONENTS.map((k) => ({ key: k, label: COMPONENT_LABEL[k], value: round1(e.scores[k] * 10), weight: round2(e.weights[k]), note: k === 'metaScore' ? e.row.meta.note : null })),
        job: g.status === 'ready' ? { label: g.functionLabel, text: g.job } : null,
        watch: e.risks[0] || (enemy.n ? (g.status === 'ready' ? g.watch : null) : ownWeakness(e.hero)),
        whyNotTop: e.rank > 1 ? explainNotTop(entries.map((x) => x.row), heroId, ally, (row) => entries.find((x) => x.row === row).fit).text : null,
        confidence: e.confidence,
      };
    };
    return { ...rec, board };
  }

  /** Before the enemy shows heroes: the hero's own structural weakness (from its ratings, never invented). */
  function ownWeakness(h) {
    const a = h.a;
    if (a.fl === 0 && a.mob <= 1) return 'Immobile backliner: exposed if the enemy drafts dive or pickoff, so it needs peel nearby.';
    if (a.ea <= 1 && a.la >= 3) return 'Weak early game: needs farm and items before it can take even fights.';
    if (a.fl >= 3 && a.bu + a.dps <= 2) return 'Low damage of its own: it needs follow-up damage to turn engages into kills.';
    if (a.ac >= 3 && a.fl <= 1) return 'Fragile when it enters: if the dive fails, it has little way back.';
    if (a.la <= 1) return 'Falls off late: it has to convert its early advantage before the enemy scales.';
    return 'No structural weakness stands out; the enemy picks will decide what to watch.';
  }

  /** "Why this matters" for a role, from what the team already has, what the role must add, and the enemy risk. */
  function whyMatters(role, A, need) {
    const { ally, enemy } = A;
    const R = ROLE_NAME[role];
    if (!ally.n && !enemy.n) return `No picks yet: the first ${R} pick should be strong on its own and flexible, because nothing about the draft is fixed.`;
    const STRONG = { frontline: 'frontline', engage: 'initiation', peel: 'peel', burst: 'burst', sustainedDamage: 'sustained damage', backlineAccess: 'backline access', poke: 'poke', objectiveControl: 'objective control', disruption: 'crowd control' };
    const have = Object.keys(STRONG).filter((k) => ally.vector[k] >= 0.9).sort((a, b) => ally.vector[b] - ally.vector[a]).slice(0, 2);
    const who = [...new Set(have.map((k) => [...ally.members].sort((a, b) => functionProfile(b.hero)[k] - functionProfile(a.hero)[k])[0].hero.name))];
    const s1 = have.length ? `Your team already has ${joinList(have.map((k) => STRONG[k]))} (${joinList(who)})` : ally.n ? `Your ${ally.n === 1 ? 'first pick gives' : 'picks give'} little structure yet` : 'You have no picks yet';
    const labels = need.labels || [];
    const s2 = labels.length ? `${R} should provide ${joinList(labels)}` : `${R} has no structural gap to fill, so pick for synergy and counters`;
    const t = (enemy.threats || [])[0];
    let s3 = '';
    if (t) {
      const hs = joinList(t.heroes.slice(0, 2));
      s3 = role === 'gold' || role === 'mid' ? ` without becoming an easy target for ${hs}`
        : role === 'roam' ? `, and be ready to answer their ${t.short} (${hs})`
          : role === 'jungle' ? `, ideally with a way to punish ${hs}`
            : ` while holding up against ${hs}`;
    }
    return `${s1}. ${s2}${s3}.`;
  }

  /**
   * Inspect a hero already in a (finished) draft: its Draft Fit against every hero that could have taken
   * that role in the final context, plus functions, synergies, counters and its job in the composition.
   */
  function inspectPick(draft, side, heroId) {
    const team = members(draft, side);
    const self = team.find((m) => m.hero.id === heroId);
    if (!self) return null;
    const others = team.filter((m) => m !== self);
    const enemyM = members(draft, opp(side));
    const { role, hero } = self;
    const A = analyzeDraft(others, enemyM, db);
    const cands = db.all.filter((h) => h.lanes.includes(role) && (h.id === heroId || !draft.usedBy(h.id)));
    const gains = new Map(cands.map((h) => [h.id, needGain(h, A.ally.needs).gain]));
    const best = Math.max(0, ...gains.values());
    const scoreOf = (h) => ({
      metaScore: metaScore(h).value,
      roleFit: h.laneWeights[role] ?? 0.4,
      compositionFit: best > 0 ? clamp01(gains.get(h.id) / best) : 1,
      synergyScore: synergyScore(h, A.ally).value,
      counterScore: clamp01(0.5 + heroVsTeam(h, A.enemy).value / 2),
      draftPriority: draftPriority(h, { enemyFitN: null, allyN: 4, open: [role] }).value,
      playerFit: 0,
      winConditionFit: winConditionFit(h, A.ally).value,
    });
    const all = cands.map((h) => ({ h, s: scoreOf(h) }));
    const w = weightsFor(others.length, enemyM.length, false);
    const ceil = Object.fromEntries(COMPONENTS.map((k) => [k, Math.max(0.6, ...all.map((x) => x.s[k]))]));
    const fitOf = (s) => Math.min(10, (10 * COMPONENTS.reduce((t, k) => t + w[k] * Math.min(s[k], ceil[k]), 0)) / Math.max(1e-6, COMPONENTS.reduce((t, k) => t + w[k] * ceil[k], 0)));
    const ranked = all.map((x) => ({ ...x, fit: fitOf(x.s) })).sort((a, b) => b.fit - a.fit);
    const mine = ranked.find((x) => x.h.id === heroId);
    const syn = synergyScore(hero, A.ally);
    const ctr = heroVsTeam(hero, A.enemy);
    const g = buildPersonalGuide({ db, ally: team, enemy: enemyM, role, heroId });
    return {
      hero, role, side, fit: round1(mine.fit), ...fitTier(mine.fit), rank: ranked.indexOf(mine) + 1, of: ranked.length,
      tags: topFunctions(hero, 0.6, 3).map(([k]) => FUNCTION_LABEL[k]),
      breakdown: COMPONENTS.filter((k) => k !== 'playerFit').map((k) => ({ key: k, label: COMPONENT_LABEL[k], value: round1(mine.s[k] * 10) })),
      synergies: syn.notes, synergyConcerns: syn.penalties, counters: ctr.reasons, counteredBy: ctr.risks,
      job: g.status === 'ready' ? { label: g.functionLabel, text: g.job } : null,
      confidence: confidence(hero),
    };
  }

  return { forStep, analyze, scorePicks, scoreBans, analysisFor, members, scoreInContext, rateDraft, contrastPicks, recommendForRole, suggestRoles, roleNeed, roleBoard, inspectPick, confidence };
}

const CALIBRATION_NOTE = 'Draft Fit uses the eight sub-scores and the stage weights, measured against the best value any available hero for this role reaches on each dimension in this draft. It ranks options; it is not a win probability.';

/** Visible Draft Fit tiers for the role board (subtle colour per tone in the UI). */
export const FIT_TIERS = [
  { min: 9.0, label: 'Excellent Fit', tone: 'excellent' },
  { min: 8.0, label: 'Strong Fit', tone: 'strong' },
  { min: 7.0, label: 'Good Fit', tone: 'goodfit' },
  { min: 6.0, label: 'Playable', tone: 'playable' },
  { min: 5.0, label: 'Situational', tone: 'situational' },
  { min: -Infinity, label: 'Low Fit', tone: 'lowfit' },
];
export function fitTier(v) {
  const t = FIT_TIERS.find((x) => round1(v) >= x.min);
  return { label: t.label, tone: t.tone };
}

/** Rating bands. Wording describes draft quality, never win probability. */
export const RATING_BANDS = [
  { min: 9.0, label: 'Excellent Draft', tone: 'good' },
  { min: 8.0, label: 'Strong Draft', tone: 'good' },
  { min: 7.0, label: 'Favorable', tone: 'good' },
  { min: 6.0, label: 'Playable / Slight Edge', tone: 'even' },
  { min: 5.0, label: 'Even', tone: 'even' },
  { min: 4.0, label: 'Difficult', tone: 'bad' },
  { min: -Infinity, label: 'Very Difficult', tone: 'bad' },
];
export function ratingBand(rating) {
  const b = RATING_BANDS.find((x) => rating >= x.min);
  return { label: b.label, tone: b.tone };
}

function cap(s) { return s ? s.charAt(0).toUpperCase() + s.slice(1) : s; }
function lc(s) { return s ? s.charAt(0).toLowerCase() + s.slice(1) : s; }
function joinList(xs) {
  if (xs.length <= 1) return xs.join('');
  return `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`;
}
export { ROLE_LABEL };
