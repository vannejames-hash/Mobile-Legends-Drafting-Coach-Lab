// COMPOSITION ENGINE (Chapter 2): reasons in the order
//   hero → function → role → composition → archetype → win condition → enemy interaction.
// Built on the function layer (src/heroFunctions.js). Every rule is FUNCTIONAL and reusable
// ("engage + follow-up damage", "enemy dive + peel"), never a hand-written hero pair.
// Stateless and pure; every intermediate value is returned so it can be inspected.

import { ATTRS } from './heroDatabase.js';
import { FUNCTIONS, FUNCTION_LABEL, functionProfile, damageProfile } from './heroFunctions.js';

const ROLE_NAME = { exp: 'EXP', jungle: 'Jungle', mid: 'Mid', gold: 'Gold', roam: 'Roam' };
const clamp = (v, lo = 0, hi = 1) => Math.max(lo, Math.min(hi, v));
const r1 = (v) => Math.round(v * 10) / 10;
const r2 = (v) => Math.round(v * 100) / 100;
const hasFlag = (h, f) => h.flags.includes(f);
const fp = (h) => functionProfile(h);
const names = (ms) => ms.map((m) => m.hero.name);

// ------------------------------------------------------------------ archetypes
// score(h) is a 0–1 per-hero contribution from its function profile.
export const ARCHETYPES = {
  engage: {
    label: 'Engage', threat: 'Hard engage teamfights',
    score: (h) => { const p = fp(h); return 0.5 * p.engage + 0.3 * p.disruption + 0.2 * p.frontline; },
    requires: (t) => t.vector.engage >= 0.9,
  },
  frontToBack: {
    label: 'Front-to-Back', threat: 'Durable frontline with sustained DPS',
    score: (h) => { const p = fp(h); return 0.35 * p.frontline + 0.4 * p.sustainedDamage + 0.25 * p.peel; },
    requires: (t) => t.n < 3 || t.vector.frontline >= 1.2,
  },
  protect: {
    label: 'Protect / UBE', threat: 'Protected carry in extended fights',
    score: (h) => { const p = fp(h); return 0.45 * p.protection + 0.25 * p.peel + 0.3 * p.sustain; },
    requires: (t) => !!t.carry && t.vector.protection + t.vector.peel >= 1.4,
  },
  pickoff: {
    label: 'Pickoff', threat: 'Pickoffs on isolated targets',
    score: (h) => { const p = fp(h); return 0.55 * p.pickoff + 0.25 * p.burst + 0.2 * p.disruption; },
  },
  dive: {
    label: 'Dive', threat: 'High backline access',
    score: (h) => { const p = fp(h); return 0.45 * p.dive + 0.35 * p.backlineAccess + 0.2 * p.burst; },
  },
  poke: {
    label: 'Poke / Siege', threat: 'Long-range poke and siege',
    score: (h) => { const p = fp(h); return 0.5 * p.poke + 0.3 * p.siege + 0.2 * p.zoneControl; },
  },
  scale: {
    label: 'Scaling', threat: 'Late-game scaling',
    score: (h) => { const p = fp(h); return clamp(0.75 * p.scaling - 0.35 * p.earlyPressure + 0.15); },
  },
  split: {
    label: 'Split / Side Pressure', threat: 'Side-lane split pressure',
    score: (h) => { const p = fp(h); return 0.7 * p.sidePressure + 0.3 * p.objectiveControl; },
    requires: (t) => t.members.some((m) => fp(m.hero).sidePressure >= 0.6),
  },
};

/** Composition-level counters: which archetype answers which (a reusable heuristic table). */
export const ARCHETYPE_COUNTERS = {
  engage: ['poke', 'scale', 'split'],
  dive: ['poke', 'scale'],
  pickoff: ['split', 'scale', 'poke'],
  poke: ['frontToBack', 'protect'],
  protect: ['dive', 'pickoff'],
  frontToBack: ['dive', 'pickoff'],
  scale: [],
  split: ['frontToBack'],
};
export function archetypeEdge(mine, theirs) {
  if (!mine || !theirs) return 0;
  if (ARCHETYPE_COUNTERS[mine]?.includes(theirs)) return 1;
  if (ARCHETYPE_COUNTERS[theirs]?.includes(mine)) return -1;
  return 0;
}

// ------------------------------------------------------------------ team model

function sumOf(members) {
  const s = Object.fromEntries(ATTRS.map((k) => [k, 0]));
  for (const m of members) for (const k of ATTRS) s[k] += m.hero.a[k];
  return s;
}
function vectorOf(members) {
  const v = Object.fromEntries(FUNCTIONS.map((k) => [k, 0]));
  for (const m of members) { const p = fp(m.hero); for (const k of FUNCTIONS) v[k] += p[k]; }
  return Object.fromEntries(FUNCTIONS.map((k) => [k, r2(v[k])]));
}
function pickBy(members, score, min = -Infinity) {
  let best = null; let bestS = min;
  for (const m of members) { const s = score(m.hero); if (s > bestS) { best = m; bestS = s; } }
  return best;
}

/** Team damage profile: type split and delivery (burst / sustained / poke), with warnings. */
function teamDamage(members) {
  let phys = 0; let mag = 0; let burst = 0; let sustained = 0; let poke = 0;
  for (const m of members) {
    const d = damageProfile(m.hero);
    if (d.type === 'magic') mag += d.output; else phys += d.output;
    burst += d.burst; sustained += d.sustained; poke += d.poke;
  }
  const total = phys + mag || 1;
  const delivery = burst + sustained + poke || 1;
  const out = {
    physicalShare: r2(phys / total), magicShare: r2(mag / total),
    burstShare: r2(burst / delivery), sustainedShare: r2(sustained / delivery), pokeShare: r2(poke / delivery),
    dealers: { p: members.filter((m) => m.hero.dmg === 'p' && damageProfile(m.hero).output >= 1).length, m: members.filter((m) => m.hero.dmg === 'm' && damageProfile(m.hero).output >= 1).length },
    warnings: [],
  };
  if (members.length >= 3 && out.physicalShare >= 0.8) out.warnings.push('Heavy physical damage: armor items will blunt your team.');
  if (members.length >= 3 && out.magicShare >= 0.8) out.warnings.push('Heavy magic damage: magic resistance items will blunt your team.');
  if (members.length >= 3 && out.burstShare >= 0.55 && out.sustainedShare < 0.3) out.warnings.push('Mostly burst damage: weak in extended teamfights.');
  return out;
}

function baseTeam(members) {
  const n = members.length;
  const t = { members, n, sum: sumOf(members), vector: vectorOf(members) };
  t.profile = Object.fromEntries(FUNCTIONS.map((k) => [k, r1(Math.min(10, t.vector[k] * 4))])); // 0–10 display scale
  t.carry = pickBy(members.filter((m) => m.hero.a.fl < 3), (h) => h.a.dps * 1.2 + h.a.la + h.a.bu * 0.6, 3);
  t.engager = pickBy(members, (h) => fp(h).engage, 0.66);
  t.diver = pickBy(members, (h) => fp(h).dive + fp(h).backlineAccess, 1.2);
  t.burst = pickBy(members, (h) => fp(h).pickoff, 0.6);
  t.damage = teamDamage(members);
  t.dmg = t.damage.dealers;
  t.archetypes = !n ? [] : Object.entries(ARCHETYPES).map(([id, A]) => {
    let raw = 0; let tagged = 0;
    for (const m of members) { raw += clamp(A.score(m.hero)); if (m.hero.tags.includes(id)) tagged++; }
    let score = (raw + 0.12 * tagged) / n;
    if (A.requires && !A.requires(t)) score *= 0.72;
    return { id, label: A.label, score: r2(score) };
  }).sort((a, b) => b.score - a.score);
  t.primary = t.archetypes[0] || null;
  t.secondary = t.archetypes[1] && t.archetypes[1].score >= t.primary.score * 0.85 ? t.archetypes[1] : null;
  t.compLabel = t.primary ? [t.primary.label, t.secondary?.label].filter(Boolean).join(' + ') : null;
  return t;
}

// ------------------------------------------------------------------ team needs
// Targets are in "function units" (sum of 0–1 strengths across the five heroes).
// Calibrated against the hero pool: an average five-hero team produces roughly
// frontline 1.75 · engage 1.8 · peel 1.4 · damage 5.0 · disruption 2.3 · objective 2.4 units.
const NEEDS = [
  { id: 'frontline', label: 'Reliable frontline', short: 'frontline', target: 1.8, cap: 1, fn: 'frontline' },
  { id: 'engage', label: 'Engage / initiation', short: 'engage', target: 1.6, cap: 1, fn: 'engage' },
  { id: 'secondaryEngage', label: 'Secondary engage', short: 'secondary engage', target: 1.8, cap: 1, fn: 'secondaryEngage', weight: 0.6 },
  { id: 'peel', label: 'Peel for carries', short: 'peel', target: 1.3, cap: 1, fn: 'peel' },
  { id: 'damage', label: 'Damage output', short: 'damage', target: 4.6, cap: 1.5, contrib: (h) => fp(h).burst + fp(h).sustainedDamage },
  { id: 'sustainedDamage', label: 'Sustained damage', short: 'sustained damage', target: 2.0, cap: 1, fn: 'sustainedDamage', weight: 0.8 },
  { id: 'burst', label: 'Burst damage', short: 'burst', target: 2.0, cap: 1, fn: 'burst', weight: 0.6 },
  { id: 'cc', label: 'Crowd control', short: 'CC', target: 2.1, cap: 1, fn: 'disruption' },
  { id: 'objective', label: 'Objective control', short: 'objective pressure', target: 2.0, cap: 1, fn: 'objectiveControl' },
  { id: 'access', label: 'Backline access', short: 'backline access', target: 1.6, cap: 1, fn: 'backlineAccess' },
  { id: 'early', label: 'Early pressure', short: 'early power', target: 2.8, cap: 1, fn: 'earlyPressure', weight: 0.6 },
  { id: 'late', label: 'Late-game scaling', short: 'scaling', target: 2.9, cap: 1, fn: 'scaling', weight: 0.6 },
];

function buildNeeds(t, o, db) {
  const remaining = 5 - t.n;
  const defs = NEEDS.map((d) => ({ ...d, contrib: d.contrib || ((h) => fp(h)[d.fn]) }));
  const patch = (id, p) => Object.assign(defs.find((d) => d.id === id), p);
  const threat = (id) => (o.threats || []).find((x) => x.id === id)?.level || 0;

  // Enemy-aware needs: what the enemy is trying to do changes what we need.
  if (threat('dive') >= 0.5) {
    defs.push({ id: 'antiDive', label: 'Answer to enemy dive', short: 'anti-dive', target: 1.6, cap: 1, contrib: (h) => fp(h).antiDive, weight: 1 });
    patch('peel', { target: 1.6 });
  }
  if (threat('poke') >= 0.5) patch('engage', { label: 'Engage to punish poke', target: 1.8 });
  if (threat('engage') >= 0.6) patch('peel', { label: 'Peel / disengage', target: Math.max(1.4, defs.find((d) => d.id === 'peel').target) });
  if (threat('scaling') >= 0.5) patch('early', { label: 'Early pressure (they out-scale)', weight: 1 });
  if (threat('split') >= 0.5) defs.push({ id: 'sidePressure', label: 'Side-lane answer', short: 'side-lane pressure', target: 1.2, cap: 1, fn: 'sidePressure', contrib: (h) => fp(h).sidePressure, weight: 0.8 });
  if (t.n >= 3 && t.damage.burstShare >= 0.55 && t.damage.sustainedShare < 0.3) patch('sustainedDamage', { weight: 1.2, label: 'Sustained damage (too much burst)' });

  const needs = defs.map((d) => {
    const have = t.members.reduce((s, m) => s + d.contrib(m.hero), 0);
    const deficit = Math.max(0, d.target - have);
    const avg = db.mean(`fn:${d.id}|${d.label}`, d.contrib);
    const projected = have + remaining * avg * 0.85;
    const pressure = deficit > 0 ? clamp((d.target - projected) / d.target + 0.15) * (d.weight ?? 1) : 0;
    return { ...d, have: r2(have), deficit: r2(deficit), pressure: r2(clamp(pressure)) };
  });

  const flagNeed = (id, label, short, test, pressure) =>
    needs.push({ id, label, short, target: 1, cap: 1, have: 0, deficit: 1, pressure, contrib: (h) => (test(h) ? 1 : 0) });
  if (remaining > 0) {
    const out = (h) => damageProfile(h).output >= 1;
    if (t.damage.dealers.p >= 2 && t.damage.physicalShare >= 0.75) flagNeed('magic', 'Magic damage source', 'magic damage', (h) => out(h) && h.dmg === 'm', t.damage.physicalShare >= 0.85 ? 0.85 : 0.5);
    if (t.damage.dealers.m >= 2 && t.damage.magicShare >= 0.75) flagNeed('physical', 'Physical damage source', 'physical damage', (h) => out(h) && h.dmg === 'p', t.damage.magicShare >= 0.85 ? 0.85 : 0.5);
    if (threat('protect') >= 0.5 && !t.members.some((m) => hasFlag(m.hero, 'antiHeal'))) flagNeed('antiheal', 'Answer to enemy sustain', 'anti-heal', (h) => hasFlag(h, 'antiHeal'), 0.35);
    const dashers = o.members.filter((m) => m.hero.a.mob >= 3).length;
    if (dashers >= 2 && !t.members.some((m) => hasFlag(m.hero, 'antiDash'))) flagNeed('antidash', 'Punish dash-heavy heroes', 'anti-dash', (h) => hasFlag(h, 'antiDash'), 0.4);
  }
  return needs.filter((n) => n.pressure > 0).sort((a, b) => b.pressure - a.pressure);
}

// ------------------------------------------------------------------ enemy threat engine
// "What is this composition trying to do to the other team?" Each threat has a level (0–1),
// the heroes driving it, a recommended response, and which functions answer it.
export const THREATS = {
  dive: { label: 'High backline access / dive', short: 'dive', metric: (p) => (p.backlineAccess + p.dive) / 2, response: 'Protect Gold/Mid and add anti-dive tools (peel, crowd control).', answer: (p) => 0.6 * p.antiDive + 0.4 * p.peel, failure: (t, o, hs) => `${o.carry ? o.carry.hero.name : 'Your backline'} gets isolated by ${hs} before your team can engage.` },
  engage: { label: 'Hard engage / AoE initiation', short: 'engage', metric: (p) => (p.engage + p.disruption) / 2, response: 'Spread out; add peel, disengage or counter-engage.', answer: (p) => 0.4 * p.peel + 0.3 * p.zoneControl + 0.3 * p.disruption, failure: () => 'They land a multi-target engage before your team is in position.' },
  pickoff: { label: 'Burst pickoffs on isolated targets', short: 'pickoff', metric: (p) => (p.pickoff + p.burst) / 2, response: 'Move as a group, control vision and add durable picks.', answer: (p) => 0.4 * p.frontline + 0.3 * p.protection + 0.3 * p.peel, failure: (t, o, hs) => `A key hero gets caught alone by ${hs} before an objective.` },
  poke: { label: 'Long-range poke / siege', short: 'poke', metric: (p) => (p.poke + p.siege) / 2, response: 'Add hard engage or mobile gap-closers; fight before you are chipped down.', answer: (p) => 0.5 * p.engage + 0.5 * p.dive, failure: () => 'You are chipped below fighting HP before objectives and forced to give them up.' },
  protect: { label: 'Protected carry with sustain', short: 'protected carry', metric: (p) => (p.protection + p.sustain) / 2, response: 'Bring anti-heal and backline access to reach the protected carry.', answer: (p) => 0.6 * p.backlineAccess + 0.4 * p.burst, failure: (t, o) => `Their protected ${o.carry ? o.carry.hero.name : 'carry'} outlasts your damage in extended fights.` },
  scaling: { label: 'Late-game scaling', short: 'scaling', metric: (p) => clamp(p.scaling - 0.5 * p.earlyPressure + 0.2), response: 'Pressure early and take objectives before their item spikes.', answer: (p) => 0.6 * p.earlyPressure + 0.4 * p.objectiveControl, failure: () => 'The game reaches the late stage without an objective lead.' },
  frontline: { label: 'Durable frontline with sustained damage', short: 'frontline', metric: (p) => (p.frontline + p.sustainedDamage) / 2, response: 'Bring sustained damage and penetration, or out-range their frontline.', answer: (p) => 0.6 * p.sustainedDamage + 0.4 * p.poke, failure: () => 'Your damage cannot get through their frontline in long fights.' },
  split: { label: 'Side-lane split pressure', short: 'split pressure', metric: (p) => p.sidePressure, response: 'Keep a side-laner to answer and force grouped fights on objectives.', answer: (p) => 0.6 * p.sidePressure + 0.4 * p.engage, failure: () => 'Side waves pull your team apart while they take objectives.' },
};

function threatsOf(t, db) {
  if (!t.n) return [];
  const list = Object.entries(THREATS).map(([id, T]) => {
    const per = t.members.map((m) => ({ m, v: T.metric(fp(m.hero)) })).sort((a, b) => b.v - a.v);
    const total = per.reduce((s, x) => s + x.v, 0);
    // level: how strongly the team does this RELATIVE to an average team of the same size
    // (≈0.35 for an average team, 1 at ~1.5× average), damped while few heroes are known.
    const expected = t.n * db.mean(`threat:${id}`, (h) => T.metric(fp(h)));
    const level = clamp((total / expected - 0.7) / 0.8) * Math.min(1, 0.55 + 0.15 * t.n);
    return { id, label: T.label, short: T.short, level: r2(level), heroes: per.filter((x) => x.v >= 0.45).slice(0, 3).map((x) => x.m.hero.name), response: T.response };
  });
  return list.filter((x) => x.level >= 0.4 && x.heroes.length).sort((a, b) => b.level - a.level).slice(0, 3);
}

// ------------------------------------------------------------------ hero vs team (tiered counters)
/**
 * How one hero performs against a team. value in [-1, 1].
 * Tiers: DIRECT (curated counter data), FUNCTIONAL (the hero answers a threat the team poses,
 * or exploits a weakness), COMPOSITION (its archetype answers their archetype).
 */
export function heroVsTeam(h, team) {
  let v = 0;
  const reasons = [];
  const risks = [];
  const tiers = { direct: 0, functional: 0, composition: 0 };
  for (const m of team.members) {
    const e = m.hero;
    if (h.counters.includes(e.id)) { v += 0.3; tiers.direct += 0.3; reasons.push(`Counters ${e.name}`); }
    if (e.counters.includes(h.id)) { v -= 0.3; tiers.direct -= 0.3; risks.push(`Countered by ${e.name}`); }
  }
  if (!team.n) return { value: 0, reasons, risks, tiers };
  const p = fp(h);
  // functional: answering what they are trying to do (capped so generic answers can't saturate
  // the score and drown out specific evidence like direct counters or exploitable weaknesses)
  let answered = 0;
  for (const th of team.threats || []) {
    const ans = THREATS[th.id].answer(p) * th.level * 0.45;
    if (ans >= 0.12) { answered += ans; reasons.push(`Answers enemy ${th.short}`); }
  }
  answered = Math.min(0.3, answered);
  v += answered; tiers.functional += answered;
  // functional: exploiting a vulnerable backline (immobile, squishy mid/gold)
  const immobile = team.members.filter((m) => (m.role === 'gold' || m.role === 'mid') && m.hero.a.mob <= 1 && m.hero.a.fl === 0);
  if (immobile.length && p.backlineAccess >= 0.9 && p.burst >= 0.6) { v += 0.3; tiers.functional += 0.3; reasons.unshift(`Punishes immobile ${immobile.map((m) => m.hero.name).join(' / ')}`); }
  const s = team.sum;
  if (s.fl >= 8 && hasFlag(h, 'tankShred')) { v += 0.2; tiers.functional += 0.2; reasons.push('Shreds a tanky frontline'); }
  if (s.mob >= 9 && hasFlag(h, 'antiDash')) { v += 0.15; tiers.functional += 0.15; reasons.push('Punishes dash-heavy lineup'); }
  if (s.cc >= 9 && hasFlag(h, 'antiCC')) { v += 0.2; tiers.functional += 0.2; reasons.push('Cleanses heavy CC'); }
  // composition: does this hero's strongest archetype answer theirs?
  const mine = Object.entries(ARCHETYPES).map(([id, A]) => [id, A.score(h)]).sort((a, b) => b[1] - a[1])[0];
  const edge = archetypeEdge(mine[0], team.primary?.id);
  if (edge && mine[1] >= 0.5) { v += 0.08 * edge; tiers.composition += 0.08 * edge; if (edge > 0) reasons.push(`${ARCHETYPES[mine[0]].label} answers their ${team.primary.label}`); }
  // functional: a backline hero that can protect ITSELF against a dive threat (mobility, durability, anti-dive)
  const dive = (team.threats || []).find((x) => x.id === 'dive');
  if (dive && dive.level >= 0.5 && h.a.fl <= 1) {
    const selfProt = 0.5 * p.antiDive + 0.3 * (h.a.mob / 3) + 0.2 * p.frontline;
    const add = Math.min(0.2, selfProt * dive.level * 0.3);
    if (add >= 0.06) { v += add; tiers.functional += add; reasons.push('Can protect itself against the enemy dive'); }
  }
  // risk: immobile squishy into heavy dive
  if (h.a.fl === 0 && h.a.mob <= 1 && dive && dive.level >= 0.6) { v -= 0.15; risks.push('Exposed to enemy dive'); }
  return { value: clamp(v, -1, 1), reasons, risks, tiers: Object.fromEntries(Object.entries(tiers).map(([k, x]) => [k, r2(x)])) };
}

/** Role function: what does this composition need from an open role? */
export function roleFunction(role, team, db) {
  const relevant = team.needs
    .filter((n) => n.pressure >= 0.25)
    .map((n) => ({ n, avg: db.mean(`fn:${n.id}:${role}`, n.contrib, role) / n.cap }))
    .filter((x) => x.avg >= 0.35)
    .sort((a, b) => b.n.pressure * b.avg - a.n.pressure * a.avg);
  return relevant[0]?.n || null;
}

// ------------------------------------------------------------------ win / failure conditions
const nameOf = (m, fallback) => (m ? m.hero.name : fallback);

function winCondition(t, o) {
  if (t.n < 2 || !t.primary) return null;
  const carry = nameOf(t.carry, 'your main carry');
  const W = {
    engage: ['Force coordinated fights around major objectives.', `${nameOf(t.engager, 'Your frontline')} must create reliable initiation while follow-up damage stays in range.`],
    pickoff: ['Catch isolated targets with vision, then convert each pick into an objective.', `${nameOf(t.burst, 'Your burst')} needs flank angles and vision on enemy rotations.`],
    dive: ['Collapse on the enemy backline before their carries can respond.', `${nameOf(t.diver, 'Your diver')} must reach ${nameOf(o.carry, 'the enemy carry')}; track their escape and peel tools first.`],
    poke: ['Siege towers and chip HP before committing to fights.', 'Keep spacing; never let the enemy engage onto your poke heroes.'],
    protect: [`Group around ${carry} and win extended fights.`, `${carry} must survive the opening seconds of every fight.`],
    frontToBack: ['Hold formation: the frontline absorbs while the backline deals sustained damage.', 'Maintain frontline formation; the backline stays behind it and hits whatever is closest.'],
    scale: ['Reach item spikes without conceding objectives.', 'Trade cross-map instead of contesting early fights you cannot win.'],
    split: ['Win through side-lane pressure: pull rotations, then take objectives on the other side.', `${nameOf(pickBy(t.members, (h) => fp(h).sidePressure), 'Your side-laner')} must hold a side wave without dying.`],
  };
  const SECOND = {
    engage: 'Look for engages on objective timers.', pickoff: 'Punish face-checks and isolated rotations.',
    dive: 'Threaten the backline to force defensive positioning.', poke: 'Soften targets before every objective.',
    protect: `Protect ${carry} through the scaling window.`, frontToBack: 'Fight in formation, not in pieces.',
    scale: 'Lean into late-game item spikes.', split: 'Use side pressure to force favorable objective fights.',
  };
  let secondary = t.secondary ? SECOND[t.secondary.id] : null;
  if (!secondary && t.carry?.role === 'gold' && t.carry.hero.a.la >= 3) secondary = `Protect ${t.carry.hero.name} through the scaling window.`;
  const [primary, required] = W[t.primary.id];
  const top = (o.threats || [])[0];
  const failure = top
    ? THREATS[top.id].failure(t, t, top.heroes.join(', ') || 'the enemy')
    : { engage: 'Your engage is wasted without damage in range.', pickoff: 'You commit to 5v5s without getting a pick first.', dive: 'Your divers go in before the enemy peel is used.', poke: 'The enemy engages onto your poke heroes.', protect: 'Your carry gets caught away from the group.', frontToBack: 'Your backline gets isolated before the team can engage.', scale: 'You fall too far behind before your spikes.', split: 'Your side-laner gets caught and the team fights 4v5.' }[t.primary.id];
  return { primary, secondary, key: required, required, failure };
}

function threatSummary(t) {
  if (!t.n || !t.primary) return null;
  const top = t.threats[0];
  if (top) return { label: top.label, heroes: top.heroes, response: top.response };
  const A = ARCHETYPES[t.primary.id];
  return { label: A.threat, heroes: [...t.members].sort((a, b) => A.score(b.hero) - A.score(a.hero)).slice(0, 2).map((m) => m.hero.name) };
}

export function analyzeDraft(allyMembers, enemyMembers, db) {
  const ally = baseTeam(allyMembers);
  const enemy = baseTeam(enemyMembers);
  ally.threats = threatsOf(ally, db);       // what WE threaten
  enemy.threats = threatsOf(enemy, db);     // what THEY threaten (= "enemy threat")
  ally.needs = buildNeeds(ally, enemy, db);
  enemy.needs = buildNeeds(enemy, ally, db);
  ally.threat = threatSummary(ally);
  enemy.threat = threatSummary(enemy);
  ally.win = winCondition(ally, enemy);
  enemy.win = winCondition(enemy, ally);
  ally.coverage = functionalCoverage(ally);
  enemy.coverage = functionalCoverage(enemy);
  return { ally, enemy };
}

/** Are the five roles doing useful work? Core functions covered by the team (0–1 each). */
export function functionalCoverage(t) {
  const v = t.vector;
  const core = {
    frontline: clamp(v.frontline / 1.2),
    initiation: clamp(v.engage / 1.0),
    protection: clamp(Math.max(v.peel, v.antiDive) / 0.9),
    damage: clamp((v.burst + v.sustainedDamage) / 2.4),
    control: clamp(v.disruption / 1.4),
  };
  const score = Object.values(core).reduce((s, x) => s + x, 0) / Object.keys(core).length;
  return { score: r2(score), core: Object.fromEntries(Object.entries(core).map(([k, x]) => [k, r2(x)])), missing: Object.entries(core).filter(([, x]) => x < 0.6).map(([k]) => k) };
}

// ---------------------------------------------------------------- post-draft

const MID_PLAN = {
  engage: 'Set up Turtle/Lord with vision and force fights on your engage timing.',
  pickoff: 'Ward enemy jungle entrances, catch rotations and convert each pick into towers or Turtle.',
  dive: 'Fight where your divers can flank: side brushes and river angles around objectives.',
  poke: 'Siege outer towers and chip the enemy down before objectives spawn.',
  protect: 'Group as five, play around your sustain and take fights inside your own vision.',
  frontToBack: 'Rotate together and contest objectives in straight-up formation fights.',
  scale: 'Farm efficiently and trade objectives cross-map until key items complete.',
  split: 'Push side waves to pull rotations, then hit the objective on the far side.',
};
const DONT = {
  engage: ['Take fights away from objective timing.', 'Engage without follow-up damage in range.'],
  pickoff: ['Commit five-man into an even fight without a pick first.'],
  dive: ['Dive before the enemy has used their key CC or peel.'],
  poke: ['Face-check brushes.', 'Let the enemy engage onto your poke heroes.'],
  protect: ['Split up: your strength is grouping.'],
  frontToBack: ['Let your frontline get separated from the backline.'],
  scale: ['Force early 5v5 fights.', 'Give up free objectives while farming.'],
  split: ['Fight 4v5 without vision on the split-pusher.'],
};

export function postDraftReport({ ally, enemy }) {
  const coh = (t) => t.primary?.score || 0;
  const gaps = (t) => Math.min(1, t.needs.reduce((s, n) => s + n.pressure, 0) / 3);
  const ctr = (t, o) => t.members.reduce((s, m) => s + heroVsTeam(m.hero, o).value, 0) / Math.max(1, t.n);
  const parts = {
    cohesion: (coh(ally) - coh(enemy)) * 3,
    counters: (ctr(ally, enemy) - ctr(enemy, ally)) * 2.5,
    gaps: (gaps(enemy) - gaps(ally)) * 2,
    composition: archetypeEdge(ally.primary?.id, enemy.primary?.id) * 0.3,
  };
  const diff = parts.cohesion + parts.counters + parts.gaps + parts.composition;
  const verdict = diff > 0.35 ? 'Favorable' : diff < -0.35 ? 'Difficult' : 'Even';
  const factors = [];
  if (parts.cohesion > 0.15) factors.push('Your composition has a clearer identity.');
  if (parts.cohesion < -0.15) factors.push('The enemy composition is more cohesive.');
  if (parts.counters > 0.15) factors.push('You hold more favorable hero matchups.');
  if (parts.counters < -0.15) factors.push('The enemy holds more counter-matchups.');
  if (parts.gaps > 0.15) factors.push('The enemy draft has more structural gaps.');
  if (parts.gaps < -0.15) factors.push('Your draft has more structural gaps to play around.');
  if (parts.composition > 0) factors.push(`Your ${ally.primary.label} plan naturally answers their ${enemy.primary.label}.`);
  if (parts.composition < 0) factors.push(`Their ${enemy.primary.label} plan naturally answers your ${ally.primary.label}.`);

  const carry = nameOf(ally.carry, 'your primary damage dealer');
  const ea = ally.sum.ea - enemy.sum.ea;
  const la = ally.sum.la - enemy.sum.la;
  const early = ea >= 2
    ? 'You are stronger early: invade, contest the first Turtle and pressure the enemy jungler.'
    : ea <= -2
      ? 'You are weaker early: protect your jungle, trade objectives cross-map and avoid isolated fights.'
      : 'Even early game: establish river vision and contest the first Turtle together.';
  const late = la >= 2
    ? `You out-scale: avoid coin-flip fights and protect ${carry} until items complete.`
    : la <= -2
      ? 'They out-scale: close the game. Force Lord and high ground before their spikes.'
      : ['protect', 'frontToBack'].includes(ally.primary?.id)
        ? `Protect ${carry} and maintain formation in Lord fights.`
        : 'Lord fights decide it: engage only once their key CC or peel is down.';

  const tgt = pickBy(enemy.members, (h) => h.a.dps * 1.2 + h.a.la + h.a.bu * 0.8 - h.a.fl * 1.2);
  const dont = [...(DONT[ally.primary?.id] || [])];
  if (['dive', 'pickoff'].includes(enemy.primary?.id)) dont.push('Walk into fog alone: the enemy wants isolated targets.');
  if (enemy.primary?.id === 'poke') dont.push('Sit in their poke range waiting for objectives.');

  return {
    verdict, diff, parts, factors,
    allyComp: ally.compLabel, enemyComp: enemy.compLabel,
    win: ally.win,
    failure: ally.win?.failure || null,
    threats: enemy.threats,
    early, mid: MID_PLAN[ally.primary?.id] || MID_PLAN.frontToBack, late,
    target: tgt ? `${tgt.hero.name} (${ROLE_NAME[tgt.role]})` : null,
    threat: enemy.threat,
    dont,
    damage: ally.damage,
    items: itemization(ally, enemy),
    priorityObjective: priorityObjective(ally, enemy, ea, la),
    matchup: matchupStatement(ally, enemy),
    keyInstruction: enemy.threats?.[0]?.response || (ally.win?.required ?? null),
    bestObjective: ea >= 2
      ? 'Early Turtles: your early game is stronger, so take the first two.'
      : la >= 2
        ? 'Late Lord: concede early objectives cheaply and fight for Lord once scaled.'
        : { engage: 'Turtle and Lord fights you can set up with vision.', pickoff: 'Whatever spawns right after a successful pick.', dive: 'Objectives the enemy must contest in the open.', poke: 'Towers: siege before fighting for objectives.', protect: 'Lord, fought as five around your carry.', frontToBack: 'Lord fights in formation.', scale: 'Lord after your core items complete.', split: 'The objective opposite your split-pusher.' }[ally.primary?.id] || 'Turtle and Lord with numbers advantage.',
  };
}

/** One short sentence: where each composition is stronger (from the function vectors). */
function matchupStatement(ally, enemy) {
  if (!ally.n || !enemy.n) return null;
  const KEYS = { engage: 'engage', frontline: 'frontline', peel: 'peel', burst: 'burst', sustainedDamage: 'sustained damage', backlineAccess: 'backline access', poke: 'poke', scaling: 'scaling', objectiveControl: 'objective control', earlyPressure: 'early pressure' };
  const diffs = Object.keys(KEYS).map((k) => ({ k, d: ally.vector[k] - enemy.vector[k] }));
  const ours = diffs.filter((x) => x.d >= 0.4).sort((a, b) => b.d - a.d)[0];
  const theirs = diffs.filter((x) => x.d <= -0.4).sort((a, b) => a.d - b.d)[0];
  if (ours && theirs) return `Your composition has stronger ${KEYS[ours.k]}, while the enemy has stronger ${KEYS[theirs.k]}.`;
  if (ours) return `Your composition has stronger ${KEYS[ours.k]}; the enemy has no clear structural edge.`;
  if (theirs) return `The enemy has stronger ${KEYS[theirs.k]}; play to your win condition rather than trading evenly.`;
  return 'The compositions are structurally even; execution and objective timing decide it.';
}

/** Draft-based objective priority (no live game state): which objective this draft should play for. */
function priorityObjective(ally, enemy, ea, la) {
  const id = ally.primary?.id;
  if (id === 'poke') return { name: 'Towers', why: 'Your poke/siege composition wins by chipping towers before forcing fights.' };
  if (id === 'split') return { name: 'Side towers', why: 'Side pressure pulls rotations; trade towers for objectives on the other side.' };
  if (ea >= 2 || (['engage', 'pickoff', 'dive'].includes(id) && la <= 0)) return { name: 'Turtle', why: 'Your composition is strongest in controlled early teamfights; turn that into early Turtles and gold.' };
  if (la >= 2 || ['scale', 'protect'].includes(id)) return { name: 'Lord', why: 'Your composition scales; play for controlled late-game Lord setups once items are complete.' };
  return { name: 'Turtle → Lord', why: 'Even timing: contest the first Turtle together, then build vision around Lord.' };
}

/** Contextual item adaptation notes based on the enemy draft. */
export function itemization(ally, enemy) {
  const out = [];
  if (!enemy.n) return out;
  const s = enemy.sum;
  if (enemy.damage.magicShare >= 0.6 && enemy.n >= 3) out.push({ title: 'Magic-heavy enemy', text: "Athena's Shield or Radiant Armor on your frontline and exposed carries." });
  if (enemy.damage.physicalShare >= 0.6 && enemy.n >= 3) out.push({ title: 'Physical-heavy enemy', text: 'Antique Cuirass or Blade Armor on the frontline; Wind of Nature on marksmen.' });
  if (s.su >= 5) out.push({ title: 'Enemy sustain', text: 'Buy anti-heal early: Dominance Ice (tank), Sea Halberd (physical), Necklace of Durance (magic).' });
  if (s.cc >= 9) out.push({ title: 'Heavy crowd control', text: 'Tough Boots on carries; consider Purify as battle spell.' });
  if (s.bu >= 8) out.push({ title: 'Burst threat', text: 'Winter Truncheon on mages to survive burst windows; build one defensive item earlier.' });
  if (s.fl >= 9) out.push({ title: 'Tanky frontline', text: 'Penetration: Malefic Roar (physical) or Divine Glaive (magic).' });
  if (s.mob >= 10) out.push({ title: 'Slippery lineup', text: 'Prioritize slows and lockdown: Ice Queen Wand on mages.' });
  for (const w of ally.damage.warnings) out.push({ title: 'Your damage profile', text: w });
  return out;
}

export { FUNCTION_LABEL };
