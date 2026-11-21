// DRAFT ANALYSIS (post-draft report): evidence-first reasoning about ONE specific draft.
//
// Built on the composition engine (archetypes, threats, needs) and the hero function layer.
// Nothing here is a fixed paragraph per section: every conclusion is selected by conditions on
// the actual heroes, their functions, roles, power curves, counters and the enemy draft, and it
// carries an `evidence` list naming the inputs that produced it, so the analysis is auditable.
//
// Layers:  facts (per team)  →  identity + power curve  →  key clash (archetype interaction)
//          →  win / enemy / failure conditions  →  role breakdown  →  personal job
//          →  strengths / weaknesses  →  objectives  →  targets  →  counterfactuals.

import { analyzeDraft, ARCHETYPES, THREATS, heroVsTeam } from './compositionEngine.js';
import { functionProfile } from './heroFunctions.js';
import { heroFunction, jobText, avoidText } from './personalGuide.js';
import { itemizationPriorities } from './itemization.js';

const ROLES = ['exp', 'jungle', 'mid', 'gold', 'roam'];
const ROLE_NAME = { exp: 'EXP', jungle: 'Jungle', mid: 'Mid', gold: 'Gold', roam: 'Roam' };
const clamp = (v, lo = 0, hi = 1) => Math.max(lo, Math.min(hi, v));
const r2 = (v) => Math.round(v * 100) / 100;
const fp = (h) => functionProfile(h);
const cap1 = (x) => (x ? x.charAt(0).toUpperCase() + x.slice(1) : x);
/** First clause of a sentence: compresses a coaching line into a signal. */
const clause = (x) => (x ? x.split(/[:;]\s/)[0].replace(/\.$/, '') : x);
const mean = (xs) => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : 0);
const nm = (m) => m?.hero.name;
export function joinNames(xs) {
  const a = xs.filter(Boolean);
  if (a.length <= 1) return a.join('');
  return `${a.slice(0, -1).join(', ')} and ${a[a.length - 1]}`;
}
const names = (ms, max = 3) => joinNames(ms.slice(0, max).map(nm));
/** singular / plural verb for a list of members (or a count) */
const pl = (ms, one, many, max = 3) => ((Array.isArray(ms) ? Math.min(ms.filter(Boolean).length, max) : ms) > 1 ? many : one);
const poss = (x) => (x ? (x.endsWith('s') ? `${x}'` : `${x}'s`) : x);
const top = (ms, f, min = -Infinity) => [...ms].map((m) => ({ m, v: f(fp(m.hero), m.hero) })).filter((x) => x.v >= min).sort((a, b) => b.v - a.v).map((x) => x.m);

// ------------------------------------------------------------------ facts per team

const PHASE = { early: 'Early game', mid: 'Mid game', late: 'Late game' };

/** Power curve from hero functions: early pressure, mid-game tempo tools, late scaling (0–1 each). */
function powerCurve(t) {
  const ps = t.members.map((m) => fp(m.hero));
  const early = mean(ps.map((p) => p.earlyPressure));
  const late = mean(ps.map((p) => p.scaling));
  const mid = mean(ps.map((p) => 0.25 * p.earlyPressure + 0.25 * p.scaling + 0.5 * Math.max(p.engage, p.pickoff, p.dive, p.objectiveControl)));
  const c = { early: r2(early), mid: r2(mid), late: r2(late) };
  const sorted = Object.entries(c).sort((a, b) => b[1] - a[1]);
  const flat = sorted[0][1] - sorted[2][1] < 0.06;
  return { ...c, peak: flat ? null : sorted[0][0], label: flat ? 'Even across the game' : PHASE[sorted[0][0]] };
}

function factsOf(t, side, db) {
  const ms = t.members;
  const by = (role) => ms.find((m) => m.role === role) || null;
  const f = {
    side, team: t, members: ms, by,
    curve: powerCurve(t),
    carry: t.carry,
    engager: t.engager,
    divers: top(ms, (p) => p.dive + p.backlineAccess, 1.2),
    pickers: top(ms, (p) => p.pickoff, 0.66),
    pokers: top(ms, (p) => p.poke, 0.6),
    protectors: top(ms, (p) => Math.max(p.peel, p.antiDive, p.protection), 0.6).filter((m) => m !== t.carry),
    front: top(ms, (p) => p.frontline, 0.9),
    scalers: (() => { const all = top(ms, (p) => p.scaling, 0.9); const dmg = all.filter((m) => fp(m.hero).burst + fp(m.hero).sustainedDamage >= 1.0); return dmg.length ? dmg : t.carry ? [t.carry] : all; })(),
    earlyHeroes: top(ms, (p) => p.earlyPressure, 0.9),
    splitter: top(ms, (p) => p.sidePressure, 0.6)[0] || null,
    damage: top(ms, (p) => p.burst + p.sustainedDamage, 1.0),
    // backline that cannot escape or absorb: the target a dive/pickoff composition looks for
    exposed: ms.filter((m) => m.hero.a.fl === 0 && m.hero.a.mob <= 1 && (m.role === 'gold' || m.role === 'mid' || m === t.carry)),
    protection: r2(t.vector.peel + t.vector.antiDive),
  };
  f.threatLevel = (id) => (t.threats || []).find((x) => x.id === id)?.level || 0;
  f.level = (...ids) => Math.max(0, ...ids.map((id) => f.threatLevel(id)));
  f.arch = [t.primary?.id, t.secondary?.id].filter(Boolean);
  f.has = (id) => f.arch.includes(id);
  void db;
  return f;
}

// ------------------------------------------------------------------ identity

const FIGHT = {
  engage: (f) => `Objective-centred fights started by ${nm(f.engager) || 'the frontline'}${f.damage.length ? `, with ${names(f.damage.filter((m) => m !== f.engager), 2)} following up` : ''}`,
  pickoff: (f) => `Catch one target in fog with ${names(f.pickers, 2) || 'burst'} before committing`,
  dive: (f) => `Collapse on the enemy backline with ${names(f.divers, 2) || 'mobile damage'}`,
  poke: (f) => `Long-range sieges: chip with ${names(f.pokers, 2)} before any commitment`,
  protect: (f) => `Extended five-man fights around ${nm(f.carry) || 'the carry'}, kept alive by ${names(f.protectors.filter((m) => m !== f.carry), 2) || 'the frontline'}`,
  frontToBack: (f) => `Formation fights: ${names(f.front, 2) || 'the frontline'} in front, ${nm(f.carry) || 'the carry'} hitting the closest target`,
  scale: (f) => `Delayed fights once ${names(f.scalers, 2)} ${pl(f.scalers, 'has', 'have', 2)} their core items`,
  split: (f) => `Side pressure from ${nm(f.splitter) || 'a side-laner'} while the team holds the opposite objective`,
};

function identity(f) {
  const t = f.team;
  if (!t.primary) return null;
  const evidence = t.archetypes.slice(0, 3).map((a) => `${a.label} ${a.score}`);
  evidence.push(`curve early ${f.curve.early} · mid ${f.curve.mid} · late ${f.curve.late}`);
  return {
    primary: t.primary.label, primaryId: t.primary.id,
    secondary: t.secondary?.label || null, secondaryId: t.secondary?.id || null,
    curve: f.curve.label, curveValues: { early: f.curve.early, mid: f.curve.mid, late: f.curve.late },
    fight: FIGHT[t.primary.id](f),
    evidence,
  };
}

// ------------------------------------------------------------------ key clash

const WANTS = {
  engage: (f) => `wants coordinated 5v5 engagements started by ${nm(f.engager) || 'its frontline'}`,
  pickoff: (f) => `wants to isolate one target with ${names(f.pickers, 2)} before committing`,
  dive: (f) => `wants to bypass the frontline and reach the backline with ${names(f.divers, 2)}`,
  poke: (f) => `wants to chip from range with ${names(f.pokers, 2)} and never take an even engage`,
  protect: (f) => `wants long, grouped fights with ${nm(f.carry) || 'its carry'} protected by ${names(f.protectors.filter((m) => m !== f.carry), 2) || 'the team'}`,
  frontToBack: (f) => `wants straight formation fights: ${names(f.front, 2) || 'the frontline'} absorbs while ${nm(f.carry) || 'the carry'} deals sustained damage`,
  scale: (f) => `wants to delay decisive fights until ${names(f.scalers, 2)} ${pl(f.scalers, 'has', 'have', 2)} their items`,
  split: (f) => `wants to stretch the map with ${nm(f.splitter)}'s side pressure`,
};
/** Who executes the win plan, and what they must do (used inside clash / failure sentences). */
const ACTOR = {
  engage: (f) => [nm(f.engager), 'start the fight on your terms'],
  pickoff: (f) => [nm(f.pickers[0]), 'find the first pick'],
  dive: (f) => [nm(f.divers[0]), 'reach their backline first'],
  poke: (f) => [nm(f.pokers[0]), 'finish the siege'],
  protect: (f) => [nm(f.carry), 'win the extended fight'],
  frontToBack: (f) => [nm(f.carry), 'deal sustained damage from behind the frontline'],
  scale: (f) => [nm(f.carry || f.scalers[0]), 'reach the late game'],
  split: (f) => [nm(f.splitter), 'convert side pressure into objectives'],
};

/** Interaction points for an archetype pair (only the pairs that apply are ever produced). */
function interactionPoints(us, them) {
  const a = us.team.primary?.id;
  const b = them.team.primary?.id;
  const P = [];
  const add = (cond, text) => { if (cond) P.push(text); };
  const isA = (...ids) => ids.some((x) => us.has(x));
  const isB = (...ids) => ids.some((x) => them.has(x));
  if (isA('engage') && isB('poke')) {
    add(true, `You need a reliable entry: ${nm(us.engager) || 'your engage'} must reach them in one move.`);
    add(true, `Do not stand in ${names(them.pokers, 2)}'s range waiting; every minute of chip damage lowers your engage odds.`);
    add(true, 'Win vision on the flanks so the engage comes from an angle they are not covering.');
  }
  if (isA('poke') && isB('engage')) {
    add(true, `Keep spacing: ${nm(them.engager)} only needs one good angle.`);
    add(us.protectors.length > 0, `${names(us.protectors, 2)} must hold disengage for ${nm(them.engager)}'s entry.`);
    add(true, 'Chip before every objective; never contest it at full enemy health.');
  }
  if (isA('pickoff', 'dive') && isB('protect')) {
    add(true, `Break their formation first: entering into ${names(them.protectors.filter((m) => m !== them.carry), 2) || 'their protection'} wastes your burst.`);
    add(true, 'Identify the isolated target each rotation; the protected core is not it.');
  }
  if (isA('protect', 'frontToBack') && isB('dive', 'pickoff')) {
    add(true, `Backline protection is the whole plan: ${names(us.protectors, 2) || 'your frontline'} ${pl(us.protectors.length ? us.protectors : [1], 'stays', 'stay', 2)} with ${nm(us.carry) || 'your carry'}.`);
    add(true, 'Hold formation and let their divers commit into you.');
    add(!!us.carry, `${nm(us.carry)} must not overextend before ${names(them.divers.length ? them.divers : them.pickers, 2)} are accounted for.`);
  }
  if (isA('dive', 'pickoff') && isB('frontToBack', 'engage')) {
    add(true, `Wait for ${names(them.front, 2) || 'their frontline'} to commit, then flank toward ${nm(them.carry) || 'their carry'}.`);
    add(true, 'A dive that starts before their engage is used gets caught in it.');
  }
  if (isA('engage') && isB('dive', 'pickoff') && !isA('protect', 'frontToBack')) {
    add(true, `Your frontline must hold formation; ${names(them.divers.length ? them.divers : them.pickers, 2)} look for the gap behind it.`);
    add(!!us.carry, `${nm(us.carry)} should not overextend: they are the target.`);
  }
  if (us.curve.late - them.curve.late >= 0.12 && them.curve.early - us.curve.early >= 0.08) {
    add(true, `Survive their first power window (${names(them.earlyHeroes, 2) || 'their early game'}).`);
    add(true, 'Trade objectives intelligently: give a contested Turtle for a safe tower or farm.');
    add(true, 'Minimise unnecessary fights until your core items are complete.');
  }
  if (us.curve.early - them.curve.early >= 0.08 && them.curve.late - us.curve.late >= 0.12) {
    add(true, `Use your early window (${names(us.earlyHeroes, 2)}): invade and take the first Turtles.`);
    add(true, `Close before ${names(them.scalers, 2)} ${pl(them.scalers, 'reaches', 'reach', 2)} their spikes; a slow game favours them.`);
  }
  add(isB('split') && !isA('split'), `Assign an answer to ${nm(them.splitter)}'s side lane; do not let one hero pull three.`);
  add(isA('split'), `${nm(us.splitter)} pressures the side; the other four hold the opposite objective and avoid 4v5s.`);
  void a; void b;
  return P.slice(0, 4);
}

function keyClash(us, them) {
  const a = us.team.primary?.id;
  const b = them.team.primary?.id;
  if (!a || !b) return null;
  const [actor, verb] = ACTOR[a](us);
  const R = [];
  // 1. their dive / pickoff vs our exposed or unprotected backline
  const theirReach = Math.max(them.level('dive', 'pickoff'), them.has('dive') || them.has('pickoff') ? 0.6 : 0);
  if ((them.divers.length || them.pickers.length) && (us.exposed.length || us.protection < 1.4)) {
    const hunters = them.divers.length ? them.divers : them.pickers;
    const victims = us.exposed.length ? us.exposed : [us.carry].filter(Boolean);
    R.push({ id: 'protect-backline', w: theirReach * (us.exposed.length ? 1.1 : 0.8) + (us.protection < 1.4 ? 0.15 : 0),
      text: `whether ${us.protectors.length ? names(us.protectors.filter((m) => !victims.includes(m)), 2) || 'your team' : 'your team'} can keep ${names(victims, 2) || 'your backline'} alive against ${names(hunters, 2)} long enough for ${actor || 'your team'} to ${verb}`,
      evidence: [`enemy ${hunters.map(nm).join(', ')} (dive/pickoff ${r2(them.level('dive', 'pickoff'))})`, us.exposed.length ? `exposed: ${us.exposed.map(nm).join(', ')} (immobile, no frontline)` : `your peel + anti-dive ${us.protection}`] });
  }
  // 2. our dive / pickoff vs their backline
  const ourReach = Math.max(us.level('dive', 'pickoff'), us.has('dive') || us.has('pickoff') ? 0.6 : 0);
  if (us.divers.length || us.pickers.length) {
    const hunters = us.divers.length ? us.divers : us.pickers;
    if (them.protection >= 1.4) {
      R.push({ id: 'break-protection', w: ourReach * 0.95,
        text: `whether ${names(hunters, 2)} can break ${names(them.protectors.filter((m) => m !== them.carry), 2) || 'their protection'} and remove ${nm(them.carry) || 'their carry'} instead of being stopped on entry`,
        evidence: [`your ${hunters.map(nm).join(', ')}`, `enemy peel + anti-dive ${them.protection}`] });
    } else if (them.exposed.length || them.carry) {
      R.push({ id: 'reach-backline', w: ourReach * (them.exposed.length ? 1.05 : 0.75),
        text: `whether ${names(hunters, 2)} can reach ${names(them.exposed.length ? them.exposed : [them.carry], 2)} before ${nm(them.engager) || 'their frontline'} forces the fight on their terms`,
        evidence: [`your ${hunters.map(nm).join(', ')}`, them.exposed.length ? `enemy exposed: ${them.exposed.map(nm).join(', ')}` : `enemy peel + anti-dive only ${them.protection}`] });
    }
  }
  // 3. engage vs poke
  if (us.engager && (them.has('poke') || them.team.vector.poke >= 1.5)) {
    R.push({ id: 'entry-vs-poke', w: 0.75 + (us.has('engage') ? 0.25 : 0) + (them.has('poke') ? 0.25 : 0),
      text: `whether ${nm(us.engager)} finds an entry before ${names(them.pokers, 2)} chip your team below fighting health`,
      evidence: [`your engage ${r2(us.team.vector.engage)} (${nm(us.engager)})`, `enemy poke ${r2(them.team.vector.poke)}`] });
  }
  if (them.engager && (us.has('poke') || us.team.vector.poke >= 1.5)) {
    R.push({ id: 'spacing-vs-engage', w: 0.75 + (them.has('engage') ? 0.25 : 0) + (us.has('poke') ? 0.25 : 0),
      text: `whether you keep enough spacing to chip ${nm(them.engager)}'s team down before they find an entry`,
      evidence: [`your poke ${r2(us.team.vector.poke)}`, `enemy engage ${r2(them.team.vector.engage)} (${nm(them.engager)})`] });
  }
  // 4. power curves
  const lateEdge = us.curve.late - them.curve.late;
  const earlyEdge = us.curve.early - them.curve.early;
  if (lateEdge >= 0.12 && earlyEdge <= -0.08) {
    R.push({ id: 'survive-early', w: Math.min(0.95, (lateEdge - earlyEdge) * 1.9),
      text: `whether you survive ${poss(names(them.earlyHeroes, 2)) || 'their'} early power window without conceding the objectives that would let them close the game before ${names(us.scalers, 2)} ${pl(us.scalers, 'comes', 'come', 2)} online`,
      evidence: [`early ${us.curve.early} vs ${them.curve.early}`, `late ${us.curve.late} vs ${them.curve.late}`] });
  }
  if (earlyEdge >= 0.08 && lateEdge <= -0.12) {
    R.push({ id: 'convert-early', w: Math.min(0.95, (earlyEdge - lateEdge) * 1.9),
      text: `whether you convert your early pressure (${names(us.earlyHeroes, 2)}) into an objective lead before ${names(them.scalers, 2)} ${pl(them.scalers, 'reaches', 'reach', 2)} their items`,
      evidence: [`early ${us.curve.early} vs ${them.curve.early}`, `late ${us.curve.late} vs ${them.curve.late}`] });
  }
  // 5. side pressure
  if (us.has('split') && us.splitter) R.push({ id: 'split', w: 0.7, text: `whether ${nm(us.splitter)}'s side pressure pulls the enemy apart before they force a 5v5`, evidence: [`your side pressure ${r2(us.team.vector.sidePressure)}`] });
  if (them.has('split') && them.splitter) R.push({ id: 'answer-split', w: 0.7, text: `whether you can answer ${nm(them.splitter)}'s side pressure without giving up the 5v5 objective`, evidence: [`enemy side pressure ${r2(them.team.vector.sidePressure)}`] });
  // 6. protected carry vs our damage
  if (them.has('protect') && !us.divers.length) R.push({ id: 'outlast', w: 0.7, text: `whether your damage can get through ${names(them.protectors, 2)} before ${nm(them.carry) || 'their carry'} wins the extended fight`, evidence: [`enemy protection ${them.protection}`, 'no reliable backline access on your side'] });

  let best = R.sort((x, y) => y.w - x.w)[0];
  if (!best) {
    const edge = vectorEdges(us.team, them.team);
    best = { id: 'edges', w: 0, text: edge.ours[0] && edge.theirs[0] ? `whether your ${edge.ours[0].label} outweighs their ${edge.theirs[0].label}` : 'execution and objective timing: neither draft has a structural edge', evidence: edge.ours.concat(edge.theirs).map((x) => `${x.label} ${x.d > 0 ? '+' : ''}${r2(x.d)}`) };
  }
  const usLine = `Your team ${WANTS[a](us)}.`;
  const themLine = `The enemy ${WANTS[b](them)}.`;
  return {
    id: best.id, ours: usLine, theirs: themLine,
    decider: `Therefore the draft is decided by ${best.text}.`,
    points: interactionPoints(us, them),
    pair: `${ARCHETYPES[a].label} vs ${ARCHETYPES[b].label}`,
    evidence: [...best.evidence, `archetypes: ${us.team.compLabel} vs ${them.team.compLabel}`],
    alternatives: R.filter((x) => x !== best).map((x) => x.id),
  };
}

// ------------------------------------------------------------------ comparative edges

const EDGE = {
  engage: ['initiation', 'more reliable initiation'], frontline: ['frontline', 'a sturdier frontline'], peel: ['peel', 'more peel'],
  burst: ['burst', 'more burst'], sustainedDamage: ['sustained damage', 'more sustained damage'], backlineAccess: ['backline access', 'superior backline access'],
  poke: ['poke', 'more poke'], scaling: ['late-game scaling', 'better late-game scaling'], objectiveControl: ['objective control', 'stronger objective control'],
  earlyPressure: ['early pressure', 'a stronger early game'], protection: ['protection', 'more protection'], disruption: ['crowd control', 'more crowd control'],
  pickoff: ['pickoff threat', 'more pickoff threat'],
};
function vectorEdges(a, b, min = 0.4) {
  const d = Object.keys(EDGE).map((k) => ({ k, label: EDGE[k][0], phrase: EDGE[k][1], d: a.vector[k] - b.vector[k] }));
  return { ours: d.filter((x) => x.d >= min).sort((x, y) => y.d - x.d), theirs: d.filter((x) => x.d <= -min).sort((x, y) => x.d - y.d) };
}

function verdictSentence(A) {
  const e = vectorEdges(A.ally, A.enemy);
  const ours = e.ours.slice(0, 2).map((x) => x.phrase);
  const theirs = e.theirs.slice(0, 1).map((x) => x.phrase);
  const evidence = [...e.ours.slice(0, 2), ...e.theirs.slice(0, 1)].map((x) => `${x.label}: ${x.d > 0 ? '+' : ''}${r2(x.d)} function units`);
  if (ours.length && theirs.length) return { text: `Your composition has ${joinNames(ours)}, but the enemy has ${theirs[0]}.`, evidence };
  if (ours.length) return { text: `Your composition has ${joinNames(ours)}, and the enemy has no clear structural edge back.`, evidence };
  if (theirs.length) return { text: `The enemy has ${joinNames(e.theirs.slice(0, 2).map((x) => x.phrase))}; your draft has to win through execution of its plan.`, evidence };
  return { text: 'The two drafts are structurally even: no function separates them by much, so execution and objective timing decide it.', evidence };
}

// ------------------------------------------------------------------ win / enemy / failure

function winConditions(us, them, tgt, obj) {
  const a = us.team.primary.id;
  const b = them.team.primary.id;
  const first = tgt.first?.hero.name || nm(them.carry) || 'an isolated target';
  const objName = obj[0]?.name || 'the next objective';
  const PRIMARY = {
    engage: () => `Force ${objName} fights on ${nm(us.engager) || 'your'} engage while ${names(us.damage.filter((m) => m !== us.engager), 2) || 'your damage'} is in range.`,
    pickoff: () => `Catch ${first} (or whoever rotates alone) with ${names(us.pickers, 2)} before ${objName}, then take it 5v4.`,
    dive: () => `Reach ${first} with ${names(us.divers, 2)} at the start of each fight, before their peel is ready.`,
    poke: () => `Siege with ${names(us.pokers, 2)}: take towers and objectives only after the enemy is chipped down.`,
    protect: () => `Win extended fights by keeping ${nm(us.carry) || 'your carry'} alive behind ${names(us.protectors.filter((m) => m !== us.carry), 2) || 'your frontline'}.`,
    frontToBack: () => `Win straight teamfights: ${names(us.front, 2) || 'your frontline'} ${pl(us.front, 'holds', 'hold', 2)} the line while ${nm(us.carry) || 'your carry'} deals sustained damage.`,
    scale: () => `Reach the late game with ${names(us.scalers, 2)} and win the Lord fight with completed items.`,
    split: () => `Pull rotations with ${nm(us.splitter)} and take the objective on the far side.`,
  };
  let secondary;
  if (us.team.secondary && us.team.secondary.id !== a) secondary = PRIMARY[us.team.secondary.id]();
  else if (a !== 'engage' && us.engager && fp(us.engager.hero).engage >= 0.8) secondary = `Use ${nm(us.engager)}'s engage to force uneven fights after a pick or a cooldown advantage.`;
  else if (a === 'engage' && us.pickers.length) secondary = `Punish isolated enemies with ${names(us.pickers, 2)} between objective timers.`;
  else if (us.curve.late - them.curve.late >= 0.1) secondary = `Fall back on scaling: ${names(us.scalers, 2)} ${pl(us.scalers, 'out-scales', 'out-scale', 2)} ${names(them.scalers.length ? them.scalers : [them.carry], 2) || 'the enemy'}.`;
  else if (us.curve.early - them.curve.early >= 0.1) secondary = `Snowball the early game: ${names(us.earlyHeroes, 2)} win the first skirmishes.`;
  else secondary = `Out-trade them on objectives where ${nm(us.carry) || 'your damage'} can fight from safety.`;

  const victims = us.exposed.length ? us.exposed : [us.carry].filter(Boolean);
  const ENEMY = {
    engage: () => `Land a multi-target engage with ${nm(them.engager)} before your team is in position.`,
    pickoff: () => `Catch ${names(victims, 2) || 'one of your heroes'} in fog with ${names(them.pickers, 2)} before objectives.`,
    dive: () => `Dive ${names(victims, 2) || 'your backline'} with ${names(them.divers, 2)} and stop your backline from operating.`,
    poke: () => `Chip your team down with ${names(them.pokers, 2)} and take towers without an even fight.`,
    protect: () => `Keep ${nm(them.carry)} alive behind ${names(them.protectors.filter((m) => m !== them.carry), 2) || 'their frontline'} and win the long fight.`,
    frontToBack: () => `Out-trade you in formation fights: ${names(them.front, 2) || 'their frontline'} in front of ${nm(them.carry) || 'their carry'}.`,
    scale: () => `Stall the game until ${names(them.scalers, 2)} ${pl(them.scalers, 'out-scales', 'out-scale', 2)} you.`,
    split: () => `Pull your team apart with ${nm(them.splitter)}'s side pressure.`,
  };

  // failure: our key dependency meets their win route
  const key = ACTOR[a](us)[0];
  const TOOL = { engage: 'the engage', pickoff: 'their burst', dive: 'the dive', poke: 'the siege', protect: 'the protection', frontToBack: 'the formation', scale: 'farm', split: 'side pressure' };
  let failure;
  if ((b === 'dive' || b === 'pickoff') && victims.length && ['pickoff', 'dive', 'engage'].includes(a)) failure = `${key} spends ${TOOL[a]} on a low-value target while ${names(them.divers.length ? them.divers : them.pickers, 2)} reach ${names(victims, 2)}.`;
  else if (b === 'dive' || b === 'pickoff') {
    const others = victims.filter((m) => nm(m) !== key);
    failure = others.length
      ? `${names(others, 2)} ${pl(others, 'is', 'are', 2)} caught before ${key || 'your team'} can ${ACTOR[a](us)[1]}.`
      : `${key} is caught alone before the fight starts, and the plan has no second carry to fall back on.`;
  }
  else if (a === 'engage') failure = `${nm(us.engager)} engages without follow-up in range and ${names(them.protectors, 2) || 'the enemy'} turn the fight around.`;
  else if (a === 'protect') failure = `${nm(us.carry)} gets separated from ${names(us.protectors.filter((m) => m !== us.carry), 2) || 'the team'}.`;
  else if (a === 'poke') failure = `${nm(them.engager) || 'Their engage'} catches your poke heroes before the siege lands.`;
  else if (a === 'scale') failure = `You concede objectives early and the gap is too large by the time ${names(us.scalers, 2)} ${pl(us.scalers, 'comes', 'come', 2)} online.`;
  else if (a === 'split') failure = `${nm(us.splitter)} is caught on the side lane and your team fights 4v5.`;
  else if (a === 'dive' || a === 'pickoff') failure = them.protectors.length
    ? `${key} enters before ${poss(names(them.protectors, 2))} defensive tools are used and dies without a trade.`
    : `${key} enters before their frontline has committed and dies without a trade.`;
  else failure = `${names(us.front, 2) || 'Your frontline'} gets separated from ${nm(us.carry) || 'your backline'}.`;

  return {
    primary: { text: PRIMARY[a](), evidence: [`primary archetype ${us.team.primary.label} (${us.team.primary.score})`, tgt.first ? `first target ${first}` : null, obj[0] ? `top objective ${obj[0].name}` : null].filter(Boolean) },
    secondary: { text: secondary, evidence: [us.team.secondary ? `secondary archetype ${us.team.secondary.label}` : 'strongest alternative route from functions'] },
    enemy: { text: ENEMY[b](), evidence: [`enemy primary ${them.team.primary.label} (${them.team.primary.score})`, victims.length ? `your exposed: ${victims.map(nm).join(', ')}` : null].filter(Boolean) },
    failure: { text: failure, evidence: [`your plan depends on ${key || 'the team'}`, `enemy route: ${them.team.primary.label}`] },
  };
}

// ------------------------------------------------------------------ targets

function targets(us, them) {
  const ourAccess = clamp(us.team.vector.backlineAccess / 1.5);
  const protectedBy = (m) => them.protectors.filter((x) => x !== m);
  const scored = them.members.map((m) => {
    const a = m.hero.a;
    const dmg = (a.bu + a.dps + 0.5 * a.po) / 3;
    const enabler = m === them.engager ? 0.45 : 0;
    const carry = m === them.carry ? 0.35 : 0;
    const fragile = a.fl === 0 ? 1 : a.fl === 1 ? 0.65 : 0.25;
    const backline = a.fl <= 1;
    const reach = backline ? 0.45 + 0.55 * ourAccess : 1;
    const guard = backline && protectedBy(m).length ? 0.85 : 1;
    return { m, v: (0.6 * dmg + enabler + carry) * (0.45 + 0.55 * fragile) * reach * guard, dmg, fragile, backline, guarded: guard < 1 };
  }).sort((x, y) => y.v - x.v);
  const whatOf = (x) => {
    const h = x.m.hero;
    return x.m === them.carry ? `main ${h.a.dps >= h.a.bu ? 'sustained damage' : 'damage'} source`
      : x.m === them.engager ? 'the engage that starts their fights'
        : h.a.bu >= 3 ? 'a major burst threat' : 'a damage source';
  };
  const why = (x) => {
    const h = x.m.hero;
    const what = x.m === them.carry ? `takes out their main ${h.a.dps >= h.a.bu ? 'sustained damage' : 'damage'} source`
      : x.m === them.engager ? 'removes the engage that starts every fight they want'
        : h.a.bu >= 3 ? 'eliminates a major burst threat before your frontline commits' : 'removes a damage source from the fight';
    const reach = x.backline ? (us.divers.length || us.pickers.length ? `${names(us.divers.length ? us.divers : us.pickers, 2)} can reach them` : 'reach them after the frontline is broken') : 'they are in front, so they are in reach';
    const guard = x.guarded ? `; expect ${names(protectedBy(x.m), 1)} to protect them, so bait that first` : '';
    return `Removing ${h.name} ${what}; ${reach}${guard}.`;
  };
  const tank = [...them.members].sort((p, q) => (q.hero.a.fl * 2 - q.hero.a.bu - q.hero.a.dps) - (p.hero.a.fl * 2 - p.hero.a.bu - p.hero.a.dps))[0];
  const protectedCarry = scored.find((x) => x.guarded && x.m === them.carry && ourAccess < 0.5);
  const avoid = protectedCarry && protectedCarry !== scored[0]
    ? { hero: protectedCarry.m.hero, why: `${protectedCarry.m.hero.name} is protected by ${names(protectedBy(protectedCarry.m), 2)} and your team lacks the access to reach them first.`, short: `Protected by ${names(protectedBy(protectedCarry.m), 1)}; out of reach` }
    : tank && tank.hero.a.fl >= 3 ? { hero: tank.hero, why: `${tank.hero.name} is built to absorb: spending cooldowns on them is exactly what their composition wants.`, short: 'Built to absorb; lower value than their backline' } : null;
  return {
    first: scored[0] ? { hero: scored[0].m.hero, role: scored[0].m.role, why: why(scored[0]), short: cap1(whatOf(scored[0])) + (scored[0].guarded ? `; protected by ${names(protectedBy(scored[0].m), 1)}` : '') } : null,
    second: scored[1] ? { hero: scored[1].m.hero, role: scored[1].m.role, why: why(scored[1]), short: cap1(whatOf(scored[1])) + (scored[1].guarded ? `; protected by ${names(protectedBy(scored[1].m), 1)}` : '') } : null,
    avoid: avoid && avoid.hero.id !== scored[0]?.m.hero.id && avoid.hero.id !== scored[1]?.m.hero.id ? avoid : null,
    evidence: scored.map((x) => `${x.m.hero.name} ${r2(x.v)}`).concat(`your backline access ${r2(us.team.vector.backlineAccess)}`),
  };
}

// ------------------------------------------------------------------ objectives

function objectivePlan(us, them) {
  const earlyEdge = us.curve.early - them.curve.early;
  const lateEdge = us.curve.late - them.curve.late;
  const objEdge = us.team.vector.objectiveControl - them.team.vector.objectiveControl;
  const tf = (t) => t.vector.frontline + t.vector.sustainedDamage + t.vector.protection;
  const tfEdge = tf(us.team) - tf(them.team);
  const out = [];
  let turtle = 0.5 + earlyEdge * 2.5 + objEdge * 0.15;
  let tWhy;
  if (earlyEdge >= 0.08) tWhy = `Your early game is stronger (${names(us.earlyHeroes, 2)}): contest the first Turtles and turn them into gold.`;
  else if (earlyEdge <= -0.08) { tWhy = `The enemy is stronger early (${names(them.earlyHeroes, 2)}): trade the first Turtle for a safe tower or farm instead of a coin-flip fight.`; turtle -= 0.1; }
  else if (objEdge >= 0.3) tWhy = `Even early game, but your faster objective damage (${names(top(us.members, (p) => p.objectiveControl, 0.66), 2)}) wins the race if you have vision.`;
  else tWhy = 'Even early game: contest Turtle only with vision and your jungler and roam both present.';
  out.push({ name: 'Turtle', score: turtle, why: tWhy, evidence: [`early ${us.curve.early} vs ${them.curve.early}`, `objective control ${r2(us.team.vector.objectiveControl)} vs ${r2(them.team.vector.objectiveControl)}`] });
  let lord = 0.5 + lateEdge * 2.5 + tfEdge * 0.08;
  let lWhy;
  if (lateEdge >= 0.08) lWhy = `Your composition becomes more reliable late (${names(us.scalers, 2)}); the long Lord fight favours you once items are complete.`;
  else if (lateEdge <= -0.08) { lWhy = `The enemy out-scales (${names(them.scalers, 2)}): take Lord early off a pick or a won fight rather than waiting for the late game.`; lord += 0.1; }
  else if (tfEdge >= 0.5) lWhy = 'Your composition wins the longer, grouped fight, which is what a Lord contest becomes.';
  else lWhy = 'Lord is decided by the first pick or engage around it: set vision before it spawns.';
  out.push({ name: 'Lord', score: lord, why: lWhy, evidence: [`late ${us.curve.late} vs ${them.curve.late}`, `teamfight durability ${r2(tf(us.team))} vs ${r2(tf(them.team))}`] });
  const siege = us.team.vector.siege + us.team.vector.sidePressure * 0.5;
  if (siege >= 1.6 || us.has('poke') || us.has('split')) out.push({ name: 'Towers', score: 0.45 + siege * 0.15, why: `${names(top(us.members, (p) => p.siege + p.sidePressure, 0.7), 2)} take towers without forcing a fight; use them to open the map first.`, evidence: [`siege + side pressure ${r2(siege)}`] });
  const sorted = out.sort((x, y) => y.score - x.score);
  return sorted.map((o, i) => ({ ...o, priority: i === 0 && o.score >= 0.55 ? 'High' : o.score >= 0.45 ? 'Medium' : 'Low' }));
}

// ------------------------------------------------------------------ strengths / weaknesses

const DIM = [
  { k: 'frontline', label: 'frontline', essential: true }, { k: 'engage', label: 'initiation', essential: true }, { k: 'peel', label: 'peel', essential: true },
  { k: 'burst', label: 'burst', essential: true }, { k: 'sustainedDamage', label: 'sustained damage', essential: true }, { k: 'disruption', label: 'crowd control', essential: true },
  { k: 'objectiveControl', label: 'objective control', essential: true }, { k: 'pickoff', label: 'pickoff' }, { k: 'backlineAccess', label: 'backline access' },
  { k: 'poke', label: 'poke' }, { k: 'earlyPressure', label: 'early pressure' }, { k: 'scaling', label: 'late-game scaling' }, { k: 'protection', label: 'protection' }, { k: 'antiDive', label: 'anti-dive' },
];

function strengthsWeaknesses(us, them, db) {
  const t = us.team;
  const strengths = [];
  const weaknesses = [];
  for (const d of DIM) {
    const avg5 = 5 * db.mean(`pf:${d.k}`, (h) => fp(h)[d.k]);
    const v = t.vector[d.k];
    const ratio = v / Math.max(0.05, avg5);
    const who = top(us.members, (p) => p[d.k], 0.5);
    if (ratio >= 1.3 && who.length) strengths.push({ id: d.k, text: `Strong ${d.label}`, detail: `from ${names(who, 3)}`, w: ratio, evidence: [`${d.label} ${r2(v)} vs average ${r2(avg5)}`] });
    else if (d.essential && ratio <= 0.62) weaknesses.push({ id: d.k, text: `Limited ${d.label}`, detail: who.length ? `only ${names(who, 2)}` : 'no real source', w: 1 / Math.max(0.2, ratio), evidence: [`${d.label} ${r2(v)} vs average ${r2(avg5)}`] });
  }
  // a key function carried by one hero
  for (const k of ['engage', 'frontline', 'sustainedDamage', 'pickoff', 'peel']) {
    const parts = us.members.map((m) => ({ m, v: fp(m.hero)[k] })).sort((a, b) => b.v - a.v);
    const total = parts.reduce((s, x) => s + x.v, 0);
    if (total >= 0.8 && parts[0].v / total >= 0.68) weaknesses.push({ id: `rely-${k}`, text: `Reliant on ${nm(parts[0].m)} for ${DIM.find((x) => x.k === k).label}`, detail: 'if they are caught or behind, the plan has no backup', w: 1.4, evidence: [`${nm(parts[0].m)} supplies ${Math.round((parts[0].v / total) * 100)}% of ${k}`] });
  }
  // exposure to what the enemy does best
  for (const th of (them.team.threats || []).slice(0, 2)) {
    const answer = us.members.reduce((s, m) => s + THREATS[th.id].answer(fp(m.hero)), 0);
    if (th.level >= 0.55 && answer < 1.2) weaknesses.push({ id: `vs-${th.id}`, text: `Vulnerable to ${th.short}`, detail: `${th.heroes.join(', ')} threaten it and your answer is thin`, w: 1.2 + th.level, evidence: [`enemy ${th.short} ${th.level}`, `your answer ${r2(answer)}`] });
  }
  // composition-level edges vs this enemy
  const e = vectorEdges(t, them.team, 0.6);
  for (const x of e.ours.slice(0, 2)) if (!strengths.some((s) => s.id === x.k) && top(us.members, (p) => p[x.k], 0.5).length) strengths.push({ id: x.k, text: `More ${x.label} than the enemy`, detail: top(us.members, (p) => p[x.k], 0.5).length ? `from ${names(top(us.members, (p) => p[x.k], 0.5), 2)}` : '', w: 1 + x.d, evidence: [`${x.label} +${r2(x.d)}`] });
  for (const w of t.damage.warnings) weaknesses.push({ id: 'dmg', text: w.split(':')[0], detail: w.split(':')[1]?.trim() || '', w: 1, evidence: [`physical ${t.damage.physicalShare} · magic ${t.damage.magicShare} · burst ${t.damage.burstShare}`] });
  strengths.sort((a, b) => b.w - a.w);
  weaknesses.sort((a, b) => b.w - a.w);
  const S = strengths.slice(0, 4);
  const W = weaknesses.slice(0, 4);
  return { strengths: S, weaknesses: W, compensate: compensate(W[0], us, them) };
}

function compensate(w, us, them) {
  if (!w) return 'No structural weakness stands out: play your win condition and do not over-adapt.';
  const hunters = them.divers.length ? them.divers : them.pickers;
  const k = w.id;
  if (k === 'sustainedDamage') return `Avoid extended fights unless ${nm(us.pickers[0] || us.engager) || 'your initiation'} has already forced the enemy formation apart.`;
  if (k === 'frontline') return `Without a real frontline, do not take straight 5v5s: fight on ${us.pickers.length ? 'picks' : 'your own timing'} and disengage when ${nm(them.engager) || 'the enemy'} commits.`;
  if (k === 'peel' || k === 'vs-dive' || k === 'vs-pickoff' || k === 'protection' || k === 'antiDive') return `Keep ${names(us.exposed.length ? us.exposed : [us.carry].filter(Boolean), 2) || 'your carry'} next to ${nm(us.protectors[0] || us.front[0]) || 'the team'} and fight only after ${names(hunters, 2) || 'their divers'} have committed.`;
  if (k === 'engage') return `With no reliable engage, let the enemy commit first and punish with ${names(us.damage, 2)}.`;
  if (k === 'burst') return 'Win through attrition and formation; you cannot delete a target quickly, so do not try to.';
  if (k === 'disruption') return 'Little crowd control to lock targets: focus the closest target together instead of chasing.';
  if (k === 'objectiveControl') return 'You take objectives slowly: clear vision first and start only with a numbers advantage.';
  if (k.startsWith('rely-')) return `Protect ${w.text.replace(/^Reliant on (.*) for .*/, '$1')}'s key cooldown: do not start fights while it is down.`;
  if (k === 'vs-engage') return `Spread out before objectives and keep disengage for ${nm(them.engager)}'s entry.`;
  if (k === 'vs-poke') return `Do not sit in ${names(them.pokers, 2)}'s range: force the fight or give the objective.`;
  if (k === 'vs-scaling') return `Close the game before ${names(them.scalers, 2)} ${pl(them.scalers, 'completes', 'complete', 2)} their items.`;
  if (k === 'dmg') return 'Expect the enemy to itemise defensively against your main damage type; prioritise penetration.';
  return `Play around it: ${w.detail}.`;
}

// ------------------------------------------------------------------ draft-context function
/**
 * Refines the guide's hero function with the other four heroes and the enemy draft: the same hero
 * becomes a counter-diver, the team's initiator, a backline remover, an exposed or protected carry ...
 */
function contextFunction(m, fn, us, them, tgt, A) {
  const h = m.hero;
  const a = h.a;
  const hunters = them.divers.length ? them.divers : them.pickers;
  const victims = (us.exposed.length ? us.exposed : [us.carry]).filter((x) => x && x !== m);
  const assassin = ['dive', 'pickoff'].includes(fn.primary) || (a.ac >= 3 && a.bu >= 2 && a.en < 2);
  const base = { label: fn.labels.slice(0, 2).join(' + '), job: jobText(fn, A.enemy.carry), id: fn.primary };
  if (assassin) {
    if (them.level('dive', 'pickoff') >= 0.5 && hunters.length && victims.length && a.cc >= 1 && us.protection < 1.6) {
      return { id: 'counter-dive', label: 'Counter-dive', job: `Stay close to ${names(victims, 2)} and punish ${names(hunters, 2)} the moment they jump in: their diver is your pick.` };
    }
    if (!us.engager || us.engager === m) {
      return { id: 'initiator', label: 'Primary pickoff / initiation', job: 'Your team has no frontline engage: your entry starts every fight, so commit only on an isolated target.' };
    }
    if (tgt.first && tgt.first.hero.a.fl <= 1) {
      return { id: 'backline-removal', label: 'Backline removal', job: `Follow ${poss(nm(us.engager))} engage straight onto ${tgt.first.hero.name}; you finish the fight they start.` };
    }
    return { id: 'pickoff', label: 'Primary pickoff', job: 'Catch whoever rotates alone and turn each pick into an objective.' };
  }
  if (['carry', 'damage', 'zone'].includes(fn.primary)) {
    if (a.la <= 1 && a.ea >= 2) return { id: 'early-damage', label: 'Early damage', job: 'Use your early power: win skirmishes and objectives before the enemy scales past you.' };
    if (us.exposed.includes(m) && hunters.length) return { id: 'exposed-carry', label: m === us.carry ? 'Exposed carry' : 'Exposed damage', job: `Deal damage from behind ${names(us.protectors.length ? us.protectors : us.front, 2) || 'your team'}; ${names(hunters, 2)} ${pl(hunters, 'is', 'are', 2)} looking for you.` };
    if (m === us.carry && us.protectors.length >= 1 && us.has('protect')) return { id: 'protected-carry', label: 'Protected carry', job: `The draft is built around you: farm, then fight in the middle of ${names(us.protectors, 2)}.` };
  }
  if (fn.primary === 'primary-engage' && us.has('pickoff') && us.pickers.some((x) => x !== m)) {
    const others = us.pickers.filter((x) => x !== m);
    return { id: 'pick-engage', label: 'Engage for the pick', job: `Lock down the target ${names(others, 2)} ${pl(others, 'chooses', 'choose', 2)}; your engage starts a pick, not a straight 5v5.` };
  }
  return base;
}

// ------------------------------------------------------------------ roles

function laneRelation(h, x) {
  if (h.counters.includes(x.id)) return 'you counter them';
  if (x.counters.includes(h.id)) return 'they counter you';
  const d = h.a.ea - x.hero?.a?.ea;
  void d;
  return null;
}

function roleBreakdown(us, them, A, tgt) {
  return ROLES.map((role) => {
    const m = us.by(role);
    if (!m) return null;
    const h = m.hero;
    const others = us.members.filter((x) => x !== m);
    const fn = heroFunction(h, role, others, A);
    const lane = them.by(role);
    let matchup;
    let evidence = [`function: ${fn.labels.join(', ')}`];
    const rel = (x) => laneRelation(h, x.hero);
    if (['dive', 'pickoff'].includes(fn.primary) && tgt.first) {
      matchup = `vs ${tgt.first.hero.name}: your target${them.protectors.length && tgt.first.hero.a.fl <= 1 ? `; wait for ${names(them.protectors.filter((x) => x.hero.id !== tgt.first.hero.id), 1)} to commit` : ''}.`;
    } else if (['carry', 'damage', 'zone'].includes(fn.primary) && (them.divers.length || them.pickers.length)) {
      const hunter = them.divers[0] || them.pickers[0];
      matchup = `vs ${nm(hunter)}: ${h.a.mob >= 2 ? 'keep your escape for their entry' : 'stay behind your frontline; you cannot escape them alone'}.`;
      evidence.push(`${nm(hunter)} dive ${r2(fp(hunter.hero).dive)}`, `your mobility ${h.a.mob}/3`);
    } else if (['peel', 'anti-dive'].includes(fn.primary) && (them.divers.length || them.pickers.length)) {
      matchup = `vs ${names(them.divers.length ? them.divers : them.pickers, 2)}: hold crowd control for their entry.`;
    } else if (['primary-engage', 'secondary-engage', 'frontline'].includes(fn.primary)) {
      const into = them.exposed[0] || them.carry || lane;
      matchup = into ? `vs ${nm(into)}: ${fn.primary === 'frontline' ? `absorb the first rotation, then walk into ${nm(into)}` : 'your engage target'}${them.protectors.length ? `; ${names(them.protectors.slice(0, 1), 1)} can peel it` : ''}.` : null;
    }
    if (lane) {
      const r = rel(lane);
      const laneLine = `Lane: ${lane.hero.name}${r ? ` (${r})` : h.a.ea > lane.hero.a.ea ? ' (you are stronger early)' : h.a.ea < lane.hero.a.ea ? ' (they are stronger early)' : ''}.`;
      matchup = matchup ? `${matchup} ${laneLine}` : laneLine;
      evidence.push(`lane early ${h.a.ea} vs ${lane.hero.a.ea}`);
    }
    const cf = contextFunction(m, fn, us, them, tgt, A);
    return { role, hero: h, function: cf.label, functionId: cf.id, job: cf.job, matchup, evidence };
  }).filter(Boolean);
}

// ------------------------------------------------------------------ personal (my role + hero, in THIS draft)

function personalGuideFor(us, them, A, tgt, role, heroId, db, catalog = null) {
  const m = us.members.find((x) => x.hero.id === heroId && (!role || x.role === role)) || (heroId && role ? { role, hero: db.get(heroId) } : null);
  if (!m || !m.hero) return null;
  const h = m.hero;
  const others = us.members.filter((x) => x.hero.id !== h.id);
  const fn = heroFunction(h, m.role, others, A);
  const p = fp(h);
  const hunters = them.divers.length ? them.divers : them.pickers;
  const ePeel = them.protectors;
  let target;
  let timing;
  if (['dive', 'pickoff'].includes(fn.primary) || (p.backlineAccess >= 0.9 && p.burst >= 0.6)) {
    target = tgt.first ? { hero: tgt.first.hero.name, why: tgt.first.why } : null;
    timing = ePeel.length ? `After ${names(ePeel, 2)} ${pl(ePeel, 'commits', 'commit', 2)} their defensive tools or your engage locks them down.` : `After their frontline commits forward and the backline is uncovered.`;
  } else if (['peel', 'anti-dive'].includes(fn.primary)) {
    target = hunters[0] ? { hero: names(hunters, 2), why: `Stop them reaching ${names(us.exposed.length ? us.exposed : [us.carry].filter(Boolean), 2) || 'your backline'}.` } : null;
    timing = hunters.length ? `Hold your crowd control until ${names(hunters, 2)} commit; use it on their entry, not before.` : 'Hold crowd control for whoever reaches your carry first.';
  } else if (['primary-engage', 'secondary-engage'].includes(fn.primary)) {
    const into = them.exposed[0] || them.carry;
    target = into ? { hero: nm(into), why: `${nm(into)} is the engage target: the highest-value hero in reach.` } : null;
    timing = fn.primary === 'primary-engage'
      ? `When ${names(us.damage.filter((x) => x.hero.id !== h.id), 2) || 'your damage'} is in range${ePeel.length ? ` and ${names(ePeel, 1)}'s disengage is down` : ''}.`
      : `Right after ${fn.primaryEngager ? nm(fn.primaryEngager) : 'the first engage'} lands, never before.`;
  } else {
    const close = them.front[0] || them.engager;
    target = tgt.first ? { hero: tgt.first.hero.name, why: 'Hit them when they are in range; otherwise hit the closest target.' } : null;
    timing = `After ${nm(us.engager) || 'your frontline'} starts the fight${close ? ` and ${nm(close)} has committed` : ''}.`;
  }
  // what enables / limits this hero (functional relations, with names)
  const enables = [];
  for (const o of others) {
    const q = fp(o.hero);
    if (['dive', 'pickoff'].includes(fn.primary) && (q.engage >= 0.8 || q.disruption >= 0.8)) enables.push(`${o.hero.name}'s ${q.engage >= 0.8 ? 'engage' : 'crowd control'}`);
    else if (['carry', 'damage', 'zone'].includes(fn.primary) && (q.peel >= 0.6 || q.frontline >= 0.9)) enables.push(`${o.hero.name}'s ${q.peel >= 0.6 ? 'peel' : 'frontline'}`);
    else if (['primary-engage', 'secondary-engage', 'frontline'].includes(fn.primary) && q.burst + q.sustainedDamage >= 1.2) enables.push(`${o.hero.name}'s follow-up damage`);
    else if (['peel', 'anti-dive'].includes(fn.primary) && o === us.carry) enables.push(`${o.hero.name} as the carry worth protecting`);
  }
  const limits = [];
  for (const e of them.members) {
    const q = fp(e.hero);
    if (e.hero.counters.includes(h.id)) limits.push(`${e.hero.name} (direct counter)`);
    else if (['dive', 'pickoff'].includes(fn.primary) && (q.peel >= 0.6 || q.antiDive >= 0.6)) limits.push(`${e.hero.name}'s ${q.antiDive >= 0.6 ? 'anti-dive' : 'protection'}`);
    else if (['carry', 'damage', 'zone'].includes(fn.primary) && q.dive + q.backlineAccess >= 1.2) limits.push(`${e.hero.name}'s backline access`);
    else if (['primary-engage', 'secondary-engage'].includes(fn.primary) && (q.peel >= 0.6 || q.poke >= 0.8)) limits.push(`${e.hero.name}'s ${q.peel >= 0.6 ? 'disengage' : 'poke'}`);
  }
  const avoid = ['dive', 'pickoff'].includes(fn.primary) && us.engager && us.engager.hero.id !== h.id
    ? `Forcing the first engage: ${nm(us.engager)} starts fights, you finish them.`
    : avoidText(fn, others, A.enemy);
  const cf = contextFunction(m, fn, us, them, tgt, A);
  if (cf.id === 'counter-dive') {
    target = { hero: names(hunters, 2), why: `They are diving ${names((us.exposed.length ? us.exposed : [us.carry]).filter((x) => x && x.hero.id !== h.id), 2) || 'your backline'}; killing them as they commit wins the fight.` };
    timing = `The moment ${names(hunters, 2)} ${pl(hunters, 'commits', 'commit', 2)} onto your backline, not before.`;
  }
  if (!enables.length) enables.push(cf.id === 'initiator' ? 'Nobody sets up for you: look for targets that are already isolated' : 'No teammate directly sets you up; play off the team formation');
  if (!limits.length) limits.push('No enemy hero directly shuts you down: your limit is positioning, not a counter');
  const items = catalog ? itemizationPriorities({ hero: h, role: m.role, jobId: cf.id, us, them, catalog }) : null;
  return {
    role: m.role, hero: h, title: `${ROLE_NAME[m.role]} · ${h.name}`,
    function: cf.label, functionId: cf.id, items,
    job: cf.job, target, timing,
    enables: enables.slice(0, 3), limits: limits.slice(0, 3), avoid,
    evidence: [`function from ${others.length} teammates: ${fn.labels.join(', ')}`, ...(hunters.length ? [`enemy hunters ${hunters.map(nm).join(', ')}`] : [])],
  };
}

// ------------------------------------------------------------------ counterfactuals

function quality(members, enemyMembers, db) {
  const X = analyzeDraft(members, enemyMembers, db);
  const unmet = Math.min(1, X.ally.needs.reduce((s, n) => s + n.pressure, 0) / 2.5);
  const ctr = mean(members.map((m) => heroVsTeam(m.hero, X.enemy).value));
  return 0.5 * (1 - unmet) + 0.3 * X.ally.coverage.score + 0.2 * clamp(0.5 + ctr / 2);
}

function counterfactuals(us, them, db, isAvailable, topWeakness) {
  const base = quality(us.members, them.members, db);
  const taken = new Set([...us.members, ...them.members].map((m) => m.hero.id));
  const best = [];
  for (const m of us.members) {
    let b = null;
    for (const h of db.all) {
      if (!h.lanes.includes(m.role) || taken.has(h.id) || !isAvailable(h.id)) continue;
      const q = quality(us.members.map((x) => (x === m ? { role: m.role, hero: h } : x)), them.members, db);
      if (!b || q > b.q) b = { q, h };
    }
    if (b && b.q - base >= 0.025) best.push({ m, h: b.h, gain: b.q - base });
  }
  best.sort((a, b) => b.gain - a.gain);
  const FN = { frontline: 'frontline', engage: 'engage', peel: 'peel', antiDive: 'anti-dive', burst: 'burst', sustainedDamage: 'sustained damage', disruption: 'crowd control', objectiveControl: 'objective control', protection: 'protection', backlineAccess: 'backline access', scaling: 'scaling', earlyPressure: 'early pressure', poke: 'poke' };
  const out = best.slice(0, 2).map(({ m, h, gain }) => {
    const pa = fp(h); const pb = fp(m.hero);
    const diffs = Object.keys(FN).map((k) => ({ k, d: pa[k] - pb[k] })).sort((x, y) => y.d - x.d);
    const adds = diffs.filter((x) => x.d >= 0.3).slice(0, 2).map((x) => FN[x.k]);
    const loses = diffs.filter((x) => x.d <= -0.3).sort((x, y) => x.d - y.d).slice(0, 1).map((x) => FN[x.k]);
    return {
      role: m.role, from: m.hero, to: h, gain: r2(gain),
      text: `${h.name} at ${ROLE_NAME[m.role]} instead of ${m.hero.name} would have added ${joinNames(adds) || 'a better fit for the gaps'}${loses.length ? ` at the cost of some ${loses[0]}` : ''}, making the composition more stable.`,
      evidence: [`draft quality ${r2(base)} → ${r2(base + gain)}`],
    };
  });
  const missing = (w) => {
    if (w.id.startsWith('vs-')) return `an answer to the enemy ${w.text.replace(/^Vulnerable to /, '')}`;
    if (w.id.startsWith('rely-')) return `a second source of ${w.text.replace(/^Reliant on .* for /, '')}`;
    if (w.id === 'dmg') return 'a more varied damage profile';
    return w.text.replace(/^Limited /, '');
  };
  const lead = topWeakness ? `The biggest missing element is ${missing(topWeakness)}.` : null;
  return { lead, options: out, note: out.length ? null : 'No available hero would have improved this composition meaningfully: the draft was close to the best this pool allowed.' };
}

// ------------------------------------------------------------------ power implication

function powerImplication(us, them) {
  const E = us.curve.early - them.curve.early;
  const L = us.curve.late - them.curve.late;
  const ev = [`early ${us.curve.early} vs ${them.curve.early}`, `mid ${us.curve.mid} vs ${them.curve.mid}`, `late ${us.curve.late} vs ${them.curve.late}`];
  if (E <= -0.08 && L >= 0.08) return { text: `The enemy is strongest before ${nm(us.carry) || names(us.scalers, 1)} reaches two core items. Your priority is to preserve map stability rather than force early fights.`, evidence: ev };
  if (E >= 0.08 && L <= -0.08) return { text: `Your window is early: ${names(us.earlyHeroes, 2)} ${pl(us.earlyHeroes, 'wins', 'win', 2)} the first fights, while ${names(them.scalers, 2)} ${pl(them.scalers, 'takes', 'take', 2)} over late. Snowball objectives and end before their spikes.`, evidence: ev };
  if (E >= 0.08 && L >= 0.08) return { text: 'You are stronger at both ends of the game; the only danger is a thrown mid-game fight. Play patiently.', evidence: ev };
  if (E <= -0.08 && L <= -0.08) return { text: `The enemy peaks earlier and later; your best window is the ${us.curve.peak === 'mid' || !us.curve.peak ? 'mid game' : PHASE[us.curve.peak].toLowerCase()}, so force your fights there.`, evidence: ev };
  if (us.curve.peak && us.curve.peak === them.curve.peak) return { text: `Both drafts peak in the ${PHASE[us.curve.peak].toLowerCase()}: the first big fight of that phase decides tempo, so prepare vision for it.`, evidence: ev };
  return { text: 'Power curves are close: neither side can wait the other out, so objective setup decides it.', evidence: ev };
}

// ------------------------------------------------------------------ role matchup (draft value per role, not a 1v1)

const DUTY_LABEL = { exp: 'side-lane pressure', jungle: 'objective and pickoff threat', mid: 'damage and control', gold: 'sustained damage', roam: 'engage and protection' };
export const EDGE_TIERS = [
  { min: 1.0, label: 'Strong advantage', tone: 'up2' },
  { min: 0.3, label: 'Slight advantage', tone: 'up1' },
  { min: -0.2, label: 'Even', tone: 'even' },
  { min: -0.9, label: 'Slight disadvantage', tone: 'down1' },
  { min: -Infinity, label: 'Major disadvantage', tone: 'down2' },
];
export const edgeTier = (e) => EDGE_TIERS.find((t) => Math.round(e * 10) / 10 >= t.min);

/**
 * roleMatchupScore: what this hero gives ITS team in THIS draft, compared with the enemy hero in the same role —
 * plan contribution, role duty, counter value against the whole enemy team, direct counter, exposure to enemy
 * hunters, power-curve fit and tempo. Not the Draft Fit, and not a claim about the 1v1.
 */
function roleValue(m, F, O, counterpart) {
  const h = m.hero; const p = fp(h);
  const plan = F.team.primary ? clamp(ARCHETYPES[F.team.primary.id].score(h)) : 0.5;
  const ctr = heroVsTeam(h, O.team);
  const direct = counterpart ? (h.counters.includes(counterpart.hero.id) ? 1 : counterpart.hero.counters.includes(h.id) ? -1 : 0) : 0;
  const hunters = O.divers.length ? O.divers : O.pickers;
  const vulnerable = F.exposed.includes(m) && hunters.length ? 1 : 0;
  const curve = F.curve.peak === 'early' ? p.earlyPressure : F.curve.peak === 'late' ? p.scaling : (p.earlyPressure + p.scaling) / 2;
  const duty = {
    exp: 0.5 * p.sidePressure + 0.5 * Math.max(p.frontline, Math.min(1, (p.burst + p.sustainedDamage) / 1.5)),
    jungle: 0.5 * p.objectiveControl + 0.5 * Math.max(p.pickoff, p.engage, p.dive),
    mid: 0.5 * Math.max(p.burst, p.poke, p.sustainedDamage) + 0.5 * p.disruption,
    gold: 0.6 * p.sustainedDamage + 0.4 * p.scaling,
    roam: 0.5 * Math.max(p.engage, p.peel, p.protection) + 0.5 * p.frontline,
  }[m.role] ?? 0.5;
  const tempo = p.earlyPressure * ({ exp: 0.6, mid: 0.6, gold: 0.5, jungle: 0.5, roam: 0.2 }[m.role] ?? 0.4);
  const parts = { plan: plan * 2, duty: duty * 1.2, counter: ctr.value * 1.5, direct: direct * 0.8, vulnerable: -vulnerable * 0.7, curve: curve * 0.6, tempo };
  return { total: Object.values(parts).reduce((t, x) => t + x, 0), parts, ctr };
}

function roleMatchups(us, them, clash) {
  const rows = [];
  for (const role of ROLES) {
    const a = us.by(role); const b = them.by(role);
    if (!a || !b) continue;
    const va = roleValue(a, us, them, b); const vb = roleValue(b, them, us, a);
    const edge = Math.round((va.total - vb.total) * 10) / 10;
    const diffs = Object.keys(va.parts).map((k) => ({ k, d: va.parts[k] - vb.parts[k] })).sort((x, y) => (edge >= 0 ? y.d - x.d : x.d - y.d));
    const k = diffs[0].k;
    const us_ = a.hero.name; const th = b.hero.name;
    const pos = edge >= 0;
    const REASON = {
      plan: pos ? `${us_} drives your ${us.team.primary?.label || 'game'} plan more than ${th} drives theirs` : `${th} is more central to their ${them.team.primary?.label || 'game'} plan`,
      duty: pos ? `Better ${DUTY_LABEL[role]}` : `Their ${DUTY_LABEL[role]} is stronger`,
      counter: pos ? (va.ctr.reasons[0] ? `${us_}: ${va.ctr.reasons[0].charAt(0).toLowerCase()}${va.ctr.reasons[0].slice(1)}` : `${us_} answers their draft better`) : (vb.ctr.reasons[0] ? `${th}: ${vb.ctr.reasons[0].charAt(0).toLowerCase()}${vb.ctr.reasons[0].slice(1)}` : `${th} answers your draft better`),
      direct: pos ? `${us_} directly counters ${th}` : `${th} directly counters ${us_}`,
      vulnerable: pos ? `${th} is exposed to your ${names(us.divers.length ? us.divers : us.pickers, 1)}` : `${us_} is exposed to ${names(them.divers.length ? them.divers : them.pickers, 2)}`,
      curve: pos ? `${us_} peaks with your team` : `${th} peaks with their team`,
      tempo: pos ? 'Better early pressure' : 'Their early pressure is stronger',
    };
    const t = edgeTier(edge);
    rows.push({ role, us: a.hero, them: b.hero, edge, label: t.label, tone: t.tone, reason: Math.abs(edge) <= 0.2 ? 'Even trade: neither side gains much here' : REASON[k], factor: k,
      evidence: Object.keys(va.parts).map((x) => `${x} ${r2(va.parts[x])} vs ${r2(vb.parts[x])}`) });
  }
  if (!rows.length) return null;
  const byEdge = [...rows].sort((x, y) => y.edge - x.edge);
  const ours = byEdge[0].edge >= 0.3 ? byEdge[0] : null;
  const worst = byEdge.at(-1).edge <= -0.3 ? byEdge.at(-1) : null;
  // the enemy's strongest role: the enemy hero carrying the most value, regardless of our counterpart
  const theirsBest = [...rows].sort((x, y) => roleValue(them.by(y.role), them, us, us.by(y.role)).total - roleValue(them.by(x.role), them, us, us.by(x.role)).total)[0];
  // decisive role: the role the key clash runs through
  const victimRole = (us.exposed[0] || us.carry)?.role;
  const DECISIVE = { 'protect-backline': victimRole, 'break-protection': (us.divers[0] || us.pickers[0])?.role, 'reach-backline': (us.divers[0] || us.pickers[0])?.role,
    'entry-vs-poke': us.engager?.role, 'spacing-vs-engage': (us.pokers[0] || us.carry)?.role, 'survive-early': (us.carry || us.scalers[0])?.role,
    'convert-early': us.earlyHeroes[0]?.role, split: us.splitter?.role, 'answer-split': us.splitter?.role || 'exp' };
  const dRole = DECISIVE[clash?.id] || [...rows].sort((x, y) => Math.abs(y.edge) - Math.abs(x.edge))[0].role;
  const decisive = rows.find((r) => r.role === dRole) || [...rows].sort((x, y) => Math.abs(y.edge) - Math.abs(x.edge))[0];
  const sentence = worst && ours
    ? `Their ${ROLE_NAME[worst.role]} (${worst.them.name}) is your biggest problem, while your ${ROLE_NAME[ours.role]} (${ours.us.name}) has the clearest edge.`
    : ours ? `Your ${ROLE_NAME[ours.role]} (${ours.us.name}) has the clearest edge; no role is a major disadvantage.`
      : worst ? `Their ${ROLE_NAME[worst.role]} (${worst.them.name}) is your biggest problem, and no role gives you a clear edge back.`
        : 'Every role is close: the draft is decided by the team plan, not by one role.';
  return { rows, strongest: ours, enemyStrongest: theirsBest, disadvantage: worst, decisive, sentence };
}

// ------------------------------------------------------------------ coaching signals (scan layer)

const WIN_SHORT = {
  pickoff: () => 'Create picks → convert to objective',
  dive: (us, them, t) => `Reach ${t.first?.hero.name || 'their carry'} → collapse`,
  engage: (us) => `${nm(us.engager) || 'Frontline'} engages → objective fight`,
  poke: () => 'Chip → siege → take objectives',
  protect: (us) => `Protect ${nm(us.carry) || 'the carry'} → win long fights`,
  frontToBack: () => 'Hold the line → out-damage',
  scale: () => 'Survive → scale → Lord',
  split: (us) => `${nm(us.splitter)} splits → far-side objective`,
};
const DONT_SHORT = {
  pickoff: 'Force a 5v5 without a pick', dive: 'Dive before their peel is used', engage: 'Engage without follow-up in range',
  poke: 'Let them engage onto your poke', protect: 'Split up', frontToBack: 'Let the frontline separate', scale: 'Force early fights', split: 'Fight 4v5 without vision',
};

function coachingSignals(us, them, clash, win, tgt, obj, P, sw) {
  const a = us.team.primary.id;
  const b = them.team.primary.id;
  const hunters = them.divers.length ? them.divers : them.pickers;
  const ourHunters = us.divers.length ? us.divers : us.pickers;
  const victims = (us.exposed.length ? us.exposed : [us.carry]).filter(Boolean);
  const Q = {
    'protect-backline': () => `Can ${names(us.protectors.filter((m) => !victims.includes(m)), 2) || 'your team'} keep ${names(victims, 2)} alive against ${names(hunters, 2)}?`,
    'break-protection': () => `Can ${names(ourHunters, 2)} get through ${names(them.protectors, 2) || 'their protection'}?`,
    'reach-backline': () => 'Who creates the first favorable backline opening?',
    'entry-vs-poke': () => `Does ${nm(us.engager)} find an entry before the poke wins?`,
    'spacing-vs-engage': () => `Can you keep spacing against ${nm(them.engager)}?`,
    'survive-early': () => 'Can you survive their early window?',
    'convert-early': () => `Can you close before ${names(them.scalers, 2)} ${pl(them.scalers, 'scales', 'scale', 2)}?`,
    split: () => `Can ${nm(us.splitter)} pull them apart?`,
    'answer-split': () => `Can you answer ${poss(nm(them.splitter))} side lane?`,
    outlast: () => 'Can your damage out-last their protection?',
    edges: () => 'Who executes their plan first?',
  };
  const DECISIVE = {
    'protect-backline': () => `Whether ${names(victims, 2)} ${pl(victims, 'survives', 'survive', 2)} the first dive`,
    'break-protection': () => `${poss(names(ourHunters, 1))} first entry: through the peel, or stopped`,
    'reach-backline': () => 'First successful pick → first objective conversion',
    'entry-vs-poke': () => 'The first clean engage before an objective',
    'spacing-vs-engage': () => `Spacing when ${nm(them.engager)} looks for the angle`,
    'survive-early': () => 'Objectives traded, not lost, before your items',
    'convert-early': () => 'An objective lead before their item spikes',
    split: () => 'Rotations around the side lane', 'answer-split': () => 'Rotations around the side lane',
    outlast: () => 'Damage through their sustain', edges: () => 'Objective timing and execution',
  };
  const id = clash.id in Q ? clash.id : 'edges';
  // power window: phases where we are ahead
  const phases = ['early', 'mid', 'late'];
  const ahead = phases.filter((k) => us.curve[k] - them.curve[k] >= 0.04);
  const behind = phases.filter((k) => them.curve[k] - us.curve[k] >= 0.04);
  const label = (ks) => (ks.length === 3 ? 'Whole game' : ks.length ? ks.map(cap1).join('–') : null);
  const th = (them.team.threats || [])[0];
  const threat = th ? `${cap1(th.short)}${victims.length && ['dive', 'pickoff'].includes(th.id) ? ` onto ${victims.map((m) => `${ROLE_NAME[m.role]} (${nm(m)})`).slice(0, 1).join('')}` : ''}` : them.team.primary.label;
  const plan = {
    win: WIN_SHORT[a](us, them, tgt),
    threat,
    job: P ? { hero: P.hero, function: P.function, line: clause(P.job) } : null,
    target: tgt.first ? { hero: tgt.first.hero, short: tgt.first.short } : null,
    objective: obj[0] ? { name: obj[0].name, priority: obj[0].priority } : null,
    dont: P ? clause(P.avoid) : DONT_SHORT[a],
  };
  // why the player's hero matters in THIS draft
  let whyYouMatter = null;
  if (P) {
    const key = ACTOR[a](us)[0];
    const self = us.members.find((m) => m.hero.id === P.hero.id);
    if (P.hero.name === key) whyYouMatter = `The plan runs through you: ${ACTOR[a](us)[1]} and the rest of the draft follows.`;
    else if (self && victims.includes(self)) whyYouMatter = `You are their main target: if you survive ${names(hunters, 2) || 'the first dive'}, their plan has nothing left.`;
    else if (self && us.protectors.includes(self) && hunters.length) whyYouMatter = `You are the answer to ${names(hunters, 2)}: without you, your backline has no protection.`;
    else if (self && self === us.engager) whyYouMatter = 'Every fight your team wants starts with you.';
    else if (P.functionId === 'backline-removal' || P.functionId === 'pickoff') whyYouMatter = `You turn ${poss(nm(us.engager) || 'the team')} openings into kills; without a finisher the engage is wasted.`;
    else if (P.functionId === 'counter-dive') whyYouMatter = `Their plan is to dive; you are the hero who punishes it.`;
    else whyYouMatter = `You supply ${P.function.toLowerCase()}, which this composition has from no one else.`;
  }
  // important interactions (only the ones that matter)
  const inter = [];
  const add = (x) => { if (x && !inter.some((y) => y.from.id === x.from.id && y.to.id === x.to.id)) inter.push(x); };
  if (ourHunters[0] && tgt.first) {
    const t = them.members.find((m) => m.hero.id === tgt.first.hero.id);
    const guard = them.protectors.filter((m) => m !== t);
    add({ from: ourHunters[0].hero, to: tgt.first.hero, label: us.divers.length ? 'Backline dive' : 'High-value pickoff',
      advantage: guard.length ? `Contested: ${names(guard, 1)} protects them${them.exposed.includes(t) ? ', but they cannot escape' : ''}` : them.exposed.includes(t) ? 'Favorable: the target cannot escape' : 'Favorable',
      todo: guard.length ? `Wait for ${names(guard, 1)} to commit, then go.` : 'Go as soon as they are separated from their frontline.', tone: guard.length ? 'warn' : 'good' });
  }
  if (us.engager && us.engager !== ourHunters[0]) {
    const into = them.exposed[0] || them.carry || them.members[0];
    add({ from: us.engager.hero, to: into.hero, label: 'Primary engage', advantage: them.protectors.length ? `Contested: ${names(them.protectors, 1)} can disengage` : 'Favorable: little disengage',
      todo: `Engage when ${names(us.damage.filter((m) => m !== us.engager), 2) || 'your damage'} ${pl(us.damage.filter((m) => m !== us.engager), 'is', 'are', 2)} in range.`, tone: them.protectors.length ? 'warn' : 'good' });
  }
  if (hunters[0] && victims[0]) {
    add({ from: hunters[0].hero, to: victims[0].hero, label: 'Enemy dive threat', advantage: us.protection < 1.4 ? 'Unfavorable: thin peel' : 'Covered: you have peel',
      todo: us.protectors.length ? `Keep ${nm(victims[0])} next to ${names(us.protectors.filter((m) => m !== victims[0]), 1)}.` : `${nm(victims[0])} plays at max range.`, tone: us.protection < 1.4 ? 'bad' : 'warn' });
  }
  for (const m of us.members) for (const e of them.members) {
    if (inter.length >= 5) break;
    if (m.hero.counters.includes(e.hero.id)) add({ from: m.hero, to: e.hero, label: 'Direct counter', advantage: 'Favorable', todo: `Look for ${nm(e)} with ${nm(m)}.`, tone: 'good' });
    else if (e.hero.counters.includes(m.hero.id)) add({ from: e.hero, to: m.hero, label: 'Countered', advantage: 'Unfavorable', todo: `${nm(m)} avoids ${nm(e)} where possible.`, tone: 'bad' });
  }
  // swing factors
  const key = ACTOR[a](us)[0];
  const BIG = {
    pickoff: `${key} gets the first high-value pick`, dive: `${key} reaches ${tgt.first?.hero.name || 'their carry'} before their peel is ready`,
    engage: `${nm(us.engager)} lands a multi-target engage`, poke: 'Your siege takes the first towers without a fight',
    protect: `${nm(us.carry)} survives the first dive`, frontToBack: `${names(us.front, 1) || 'Your frontline'} holds while ${nm(us.carry)} gets items`,
    scale: `The game reaches the late stage with ${nm(us.carry) || 'your carry'} alive`, split: `${nm(us.splitter)} draws two defenders`,
  };
  const w = sw.weaknesses[0];
  const improve = !w ? 'Vision on the next objective before it spawns'
    : ['peel', 'protection', 'antiDive', 'vs-dive', 'vs-pickoff'].includes(w.id) ? `${names(victims, 1) || 'Your carry'} itemises defensively against ${names(hunters, 1) || 'their dive'}`
      : w.id === 'sustainedDamage' ? 'Fights stay short: picks before 5v5s'
        : w.id === 'frontline' ? `Fights happen on your timing, not ${poss(nm(them.engager) || 'theirs')}`
          : w.id === 'engage' ? 'The enemy commits first'
            : w.id.startsWith('rely-') ? `${w.text.replace(/^Reliant on (.*) for .*/, '$1')} saves the key cooldown for the right fight`
              : 'Vision on the next objective before it spawns';
  const RISK = {
    dive: `${nm(them.divers[0]) || 'Their diver'} reaches ${names(victims, 1) || 'your carry'} first`, pickoff: `${nm(them.pickers[0])} catches ${names(victims, 1) || 'a carry'} in fog`,
    engage: `${nm(them.engager)} lands the first engage`, scale: 'The enemy reaches Lord with full items', poke: 'Your team is chipped down before objectives',
    protect: `${nm(them.carry)} survives your first entry`, frontToBack: 'A long, even 5v5 at an objective', split: `${nm(them.splitter)} pulls your team apart`,
  };
  const swings = [
    { sign: '+', kind: 'Big swing', text: BIG[a] },
    { sign: '+', kind: 'Improvement', text: improve },
    { sign: '−', kind: 'Risk', text: them.curve.late - us.curve.late >= 0.1 && !['dive', 'pickoff'].includes(b) ? 'The enemy reaches Lord uncontested' : RISK[b] },
  ];
  return {
    question: Q[id](), decisive: DECISIVE[id](), plan, whyYouMatter,
    window: { ours: label(ahead), theirs: label(behind) },
    interactions: inter.slice(0, 5), swings,
  };
}

// ------------------------------------------------------------------ entry point

/**
 * Full post-draft analysis for `ally` vs `enemy` (arrays of { role, hero }).
 * opts: rating (from rateDraft), myRole / myHero (personal guide), isAvailable(id) (counterfactual pool).
 */
export function analyzeCompletedDraft({ db, ally, enemy, rating = null, myRole = null, myHero = null, isAvailable = () => true, items = null }) {
  const A = analyzeDraft(ally, enemy, db);
  if (!A.ally.n || !A.enemy.n || !A.ally.primary || !A.enemy.primary) return null;
  const us = factsOf(A.ally, 'ally', db);
  const them = factsOf(A.enemy, 'enemy', db);
  const tgt = targets(us, them);
  const obj = objectivePlan(us, them);
  const sw = strengthsWeaknesses(us, them, db);
  const verdict = verdictSentence(A);
  const clash = keyClash(us, them);
  const win = winConditions(us, them, tgt, obj);
  const personal = myHero ? personalGuideFor(us, them, A, tgt, myRole, myHero, db, items) : null;
  const sig = coachingSignals(us, them, clash, win, tgt, obj, personal, sw);
  return {
    verdict: { rating: rating?.rating ?? null, label: rating?.label ?? null, tone: rating?.tone ?? null, text: verdict.text, evidence: verdict.evidence },
    identity: { ally: identity(us), enemy: identity(them) },
    clash: { ...clash, question: sig.question, decisive: sig.decisive },
    win,
    plan: sig.plan,
    window: sig.window,
    interactions: sig.interactions,
    roleMatchup: roleMatchups(us, them, clash),
    swings: sig.swings,
    power: { ally: us.curve, enemy: them.curve, implication: powerImplication(us, them) },
    roles: roleBreakdown(us, them, A, tgt),
    personal: personal ? { ...personal, whyYouMatter: sig.whyYouMatter } : null,
    strengths: sw.strengths, weaknesses: sw.weaknesses, compensate: sw.compensate,
    objectives: obj,
    targets: tgt,
    counterfactual: counterfactuals(us, them, db, isAvailable, sw.weaknesses[0]),
    analysis: A,
  };
}
