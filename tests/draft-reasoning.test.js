// Draft-format enforcement + deterministic reasoning drafts (A–E) for the v1 engine.
//   node tests/draft-reasoning.test.js
import assert from 'node:assert/strict';
import { db, meta, formats, makeDraft, makeProfile, setup } from './helpers.js';
import { createRecommendationEngine, COMPONENTS } from '../src/recommendationEngine.js';

const engine = createRecommendationEngine({ db, meta, profile: makeProfile() });
let failures = 0;
const test = (name, fn) => {
  try { fn(); console.log(`  ✓ ${name}`); } catch (e) { failures++; console.log(`  ✗ ${name}\n      ${e.message.split('\n')[0]}`); }
};
const show = (res, n = 3) => res.rows.slice(0, n).map((r) => `${r.hero.name} ${r.score.toFixed(1)} [${COMPONENTS.map((k) => `${k.replace(/Score|Fit/, '')}:${r.scores[k]}`).join(' ')}]`).join('\n      ');

// ------------------------------------------------------------------ formats
console.log('\nDraft formats');

test('MPL_PH_S18 compiles to 10 bans + 10 picks in 4 phases', () => {
  const f = formats.MPL_PH_S18;
  assert.equal(f.steps.length, 20);
  assert.deepEqual(f.totals, { ban: 10, pick: 10 });
  assert.deepEqual(f.phases.map((p) => p.id), ['ban1', 'pick1', 'ban2', 'pick2']);
  assert.equal(f.enforced, true);
  assert.equal(f.verification.status, 'partial', 'unverified parts are flagged, not presented as fact');
});

test('status() exposes phase, side, action, timer and hero sets', () => {
  const d = makeDraft('MPL_PH_S18');
  const s = d.status();
  assert.equal(s.phase, 'ban'); assert.equal(s.side, 'blue'); assert.equal(s.actionType, 'ban');
  assert.equal(s.actionNumber, 1); assert.equal(s.timer, 30); assert.equal(s.phaseIndex, 0);
  assert.equal(s.availableHeroes.length, db.all.length);
  d.act('freya');
  const s2 = d.status();
  assert.equal(s2.side, 'red'); assert.equal(s2.actionNumber, 2);
  assert.deepEqual(s2.bannedHeroes, { blue: ['freya'], red: [] });
  assert.ok(!s2.availableHeroes.includes('freya'));
});

test('Tournament enforces turn order: wrong side / wrong action rejected', () => {
  const d = makeDraft('MPL_PH_S18');
  assert.equal(d.setTarget({ side: 'red', type: 'ban' }).ok, false, 'red cannot ban on blue’s turn');
  assert.equal(d.setTarget({ side: 'blue', type: 'pick', key: 'jungle' }).ok, false, 'no picks during ban phase');
  for (let i = 0; i < 6; i++) d.act(['freya', 'atlas', 'paquito', 'marcel', 'fanny', 'uranus'][i]);
  assert.equal(d.status().phase, 'pick');
  assert.equal(d.status().phaseLabel, 'Pick phase 1');
  assert.equal(d.setTarget({ side: 'red', type: 'pick', key: 'roam' }).ok, false, 'blue has first pick');
  assert.equal(d.setTarget({ side: 'blue', type: 'ban' }).ok, false, 'no bans during pick phase');
  assert.ok(d.setTarget({ side: 'blue', type: 'pick', key: 'roam' }).ok, 'current side may choose the role');
  assert.ok(d.act('carmilla'));
  assert.equal(d.state.picks.blue.roam, 'carmilla');
  assert.equal(d.canRemove().ok, false, 'picks are final in tournament (Undo only)');
  assert.equal(d.remove('blue', 'pick', 'roam'), false);
  assert.ok(d.canSwap().ok, 'role swaps allowed (flexBeforeRoleAssignment)');
});

test('Tournament full sequence: B R B R B R | B RR BB R | R B R B | R BB R', () => {
  const d = makeDraft('MPL_PH_S18');
  const order = [];
  const pool = db.all.map((h) => h.id);
  while (!d.status().complete) {
    const s = d.status();
    order.push(`${s.actionType[0].toUpperCase()}${s.side[0]}`);
    assert.ok(d.act(pool.find((id) => d.canAct(id).ok)));
  }
  assert.equal(order.join(' '), 'Bb Br Bb Br Bb Br Pb Pr Pr Pb Pb Pr Br Bb Br Bb Pr Pb Pb Pr');
  assert.equal(d.status().phase, 'complete');
  assert.equal(new Set([...Object.values(d.state.picks.blue), ...Object.values(d.state.picks.red), ...d.state.bans.blue, ...d.state.bans.red]).size, 20, 'no duplicates');
});

test('Free Draft allows arbitrary order, removal and undo', () => {
  const d = makeDraft('FREE');
  assert.ok(d.setTarget({ side: 'red', type: 'pick', key: 'gold' }).ok);
  assert.ok(d.act('claude'));
  assert.ok(d.setTarget({ side: 'blue', type: 'ban' }).ok);
  assert.ok(d.act('freya'));
  assert.ok(d.remove('red', 'pick', 'gold'));
  assert.ok(d.undo());
  assert.equal(d.state.picks.red.gold, 'claude');
});

test('Verification target (S18 GF G1) is consistent with MPL_PH_S18 sets; order still unverified', async () => {
  const { readFileSync } = await import('node:fs');
  const log = JSON.parse(readFileSync(new URL('../data/drafts/mpl-ph-s18.json', import.meta.url)));
  const t = log.verificationTargets.find((x) => x.id === 'S18-GF-FLCN-RORA-G1');
  const f = formats.MPL_PH_S18;
  const all = [];
  for (const side of ['blue', 'red']) {
    assert.equal(t[side].picks.length, f.picksPerSide);
    assert.equal(t[side].bans.length, f.bansPerSide);
    for (const id of [...t[side].picks, ...t[side].bans]) { assert.ok(db.get(id), `unknown hero ${id}`); all.push(id); }
  }
  assert.equal(new Set(all).size, 20);
  // Sets alone must not upgrade the preset: it stays 'partial' until an ordered sequence is checked.
  assert.equal(t.orderedSequence, null);
  assert.equal(f.verification.status, 'partial');
});

// ------------------------------------------------------------------ reasoning drafts
console.log('\nReasoning drafts (v1 engine)');

test('A — existing damage, weak frontline → durable/frontline pick', () => {
  const d = setup(makeDraft('FREE'), { blue: { jungle: 'ling', mid: 'valentina', gold: 'claude' }, red: { jungle: 'hirara', gold: 'brody' } });
  const res = engine.analyze(d, 'blue');
  console.log(`      need: ${res.teamNeed} | top: ${show(res)}`);
  assert.match(res.teamNeed || '', /frontline/i, 'engine names frontline as the need');
  assert.ok(res.topPick.a.fl >= 2, `${res.topPick.hero.name} should be durable (frontline ${res.topPick.a.fl})`);
  assert.ok(res.topPick.scores.compositionFit >= 0.8, 'top pick is driven by composition fit');
});

test('B — enemy has a vulnerable backline → pickoff/dive pick (and those heroes rise)', async () => {
  const { functionProfile } = await import('../src/heroFunctions.js');
  const ally = { roam: 'tigreal', gold: 'claude', mid: 'zhuxin' };
  const d = setup(makeDraft('FREE'), { blue: ally, red: { gold: 'miya', mid: 'cecilion', roam: 'estes' } });
  const durable = setup(makeDraft('FREE'), { blue: ally, red: { gold: 'karrie', mid: 'valir', roam: 'khufra' } });
  const res = engine.analyze(d, 'blue');
  const base = engine.analyze(durable, 'blue');
  console.log(`      threat: ${res.enemyThreat} | top: ${show(res)}`);
  const p = functionProfile(res.topPick.hero);
  assert.ok(p.pickoff >= 0.7 || p.dive >= 0.7, `${res.topPick.hero.name} should be pickoff/dive (pickoff ${p.pickoff}, dive ${p.dive})`);
  for (const id of ['saber', 'chou']) {
    const rank = (x) => x.rows.findIndex((r) => r.hero.id === id) + 1;
    console.log(`      ${id}: #${rank(base)} vs durable backline → #${rank(res)} vs immobile backline`);
    assert.ok(rank(res) < rank(base), `${id} rises against a vulnerable backline`);
  }
  assert.ok(res.counterPick, 'a counter pick is offered');
});

test('C — team already durable → damage-oriented EXP', () => {
  const d = setup(makeDraft('FREE'), { blue: { jungle: 'barats', roam: 'atlas', mid: 'zhuxin', gold: 'claude' }, red: { gold: 'brody', mid: 'valentina' } });
  const res = engine.analyze(d, 'blue');
  console.log(`      need: ${res.teamNeed} | top: ${show(res)}`);
  const t = res.topPick;
  assert.equal(t.role, 'exp');
  assert.ok(t.a.bu + t.a.dps >= 4, `${t.hero.name} should bring damage (burst+dps ${t.a.bu + t.a.dps})`);
  assert.ok(t.a.fl <= 2, `${t.hero.name} should not be another tank (frontline ${t.a.fl})`);
});

test('D — enemy has strong dive → peel/protection pick', () => {
  const d = setup(makeDraft('FREE'), { blue: { jungle: 'suyou', gold: 'claude', mid: 'valentina' }, red: { jungle: 'ling', exp: 'chou', mid: 'harith', gold: 'wanwan' } });
  const res = engine.analyze(d, 'blue');
  console.log(`      threat: ${res.enemyThreat} | need: ${res.teamNeed} | top: ${show(res)}`);
  const t = res.topPick;
  assert.match(res.enemyThreat || '', /backline access|dive/i);
  assert.ok(t.a.pe >= 2 || t.flags.includes('antiDive') || t.hero.flags.includes('antiDive') || t.hero.flags.includes('antiDash'),
    `${t.hero.name} should protect (peel ${t.a.pe}, flags ${t.hero.flags})`);
});

test('E — meta-high but incompatible hero is not top, with an explanation', () => {
  // Same team as A: damage-heavy, missing frontline. Freya has 100% S18 presence but is a damage fighter.
  const d = setup(makeDraft('FREE'), { blue: { jungle: 'ling', mid: 'valentina', gold: 'claude' }, red: { jungle: 'hirara', gold: 'brody' } });
  const res = engine.analyze(d, 'blue');
  const freya = res.rows.find((r) => r.hero.id === 'freya');
  console.log(`      top: ${res.topPick.hero.name} ${res.topPick.score.toFixed(1)} | freya: #${res.rows.indexOf(freya) + 1} ${freya.score.toFixed(1)} meta ${freya.scores.metaScore} comp ${freya.scores.compositionFit}`);
  assert.ok(freya.scores.metaScore >= 0.9, 'Freya is meta-high');
  assert.notEqual(res.topPick.hero.id, 'freya');
  assert.ok(freya.scores.compositionFit < res.topPick.scores.compositionFit, 'loses on composition fit');
  const why = res.explainNotTop('freya');
  console.log(`      why not Freya: ${why.text}`);
  assert.match(why.text, /meta value/i, 'acknowledges its meta strength');
  assert.match(why.text, /composition fit/i, 'names the composition problem');
});

test('E2 — stacking tanks is penalised in synergy', () => {
  const d = setup(makeDraft('FREE'), { blue: { exp: 'uranus', jungle: 'barats', mid: 'zhuxin' }, red: { jungle: 'hirara', gold: 'claude' } });
  const res = engine.analyze(d, 'blue');
  const atlas = res.rows.find((r) => r.hero.id === 'atlas');
  assert.ok(atlas.syn.penalties.some((p) => /third tank/.test(p)), 'third tank flagged');
  assert.ok(atlas.scores.synergyScore < 0.4);
});

test('Sub-scores are all present, bounded and combine to draftFit', () => {
  const d = setup(makeDraft('FREE'), { blue: { roam: 'tigreal' }, red: { jungle: 'hirara' } });
  const res = engine.analyze(d, 'blue', { usePool: false });
  for (const r of res.rows.slice(0, 20)) {
    for (const k of COMPONENTS) assert.ok(r.scores[k] >= 0 && r.scores[k] <= 1, `${r.hero.id}.${k}=${r.scores[k]}`);
    const sum = COMPONENTS.reduce((s, k) => s + r.weights[k] * r.scores[k], 0) * 10;
    assert.ok(Math.abs(sum - r.draftFit) < 0.05, 'draftFit = Σ weight × sub-score');
  }
  assert.equal(res.rows[0].weights.playerFit, 0, 'playerFit has no weight in theoretical mode');
});

test('Player fit: pool mode prefers comfort picks and excludes ★ Avoid', () => {
  const prof = makeProfile({ jungle: { saber: 5, suyou: 4, ling: 1 } });
  const e = createRecommendationEngine({ db, meta, profile: prof });
  const d = setup(makeDraft('FREE'), { blue: { roam: 'tigreal', gold: 'claude', mid: 'zhuxin', exp: 'freya' } });
  const res = e.analyze(d, 'blue', { usePool: true });
  assert.deepEqual(res.rows.map((r) => r.hero.id).sort(), ['saber', 'suyou']);
  assert.ok(res.rows[0].weights.playerFit > 0);
});

console.log(failures ? `\n${failures} test(s) failed` : '\nAll draft-reasoning tests passed');
process.exitCode = failures ? 1 : 0;

// ------------------------------------------------------------------ live input model (pick order ≠ role)
console.log('\nLive input model');

test('Ranked Draft is the default and groups bans: your 3 → enemy 3 → your 2 → enemy 2', async () => {
  const { defaultId } = await import('./helpers.js');
  assert.equal(defaultId, 'RANKED_DRAFT');
  for (const userSide of ['blue', 'red']) {
    const d = makeDraft('RANKED_DRAFT', userSide);
    const bans = d.format.steps.filter((s) => s.type === 'ban').map((s) => (s.side === userSide ? 'you' : 'enemy'));
    assert.deepEqual(bans, ['you', 'you', 'you', 'you', 'you', 'enemy', 'enemy', 'enemy', 'enemy', 'enemy'], `as ${userSide}`);
    assert.equal(d.status().phaseLabel, 'Ban phase · your bans');
    ['freya', 'atlas', 'paquito', 'marcel', 'fanny'].forEach((h) => d.act(h));
    assert.equal(d.status().phaseLabel, 'Ban phase · enemy bans');
    assert.deepEqual(d.state.bans[userSide], ['freya', 'atlas', 'paquito', 'marcel', 'fanny'], 'your five bans in one block');
  }
});

test('Hero first: a pick is logged in order, then its role is inferred', () => {
  const d = makeDraft('RANKED_DRAFT');
  ['freya', 'atlas', 'paquito', 'marcel', 'fanny', 'uranus', 'masha', 'barats', 'hylos', 'kalea'].forEach((h) => d.act(h));
  assert.equal(d.status().actionType, 'pick');
  assert.ok(d.act('suyou'));
  const p = d.picks('blue')[0];
  assert.deepEqual({ order: p.order, hero: p.hero, assignedRole: p.assignedRole, roleSource: p.roleSource }, { order: 1, hero: 'suyou', assignedRole: 'jungle', roleSource: 'auto' });
});

test('Auto roles re-infer jointly: a pure jungler moves a flex hero to its flex lane', () => {
  const d = makeDraft('FREE');
  d.setTarget({ side: 'blue', type: 'pick' }); d.act('suyou');   // Suyou: Jungle (primary) / EXP (flex)
  assert.equal(d.inferRole('blue', 'ling'), 'jungle', 'preview: Ling would take Jungle');
  d.setTarget({ side: 'blue', type: 'pick' }); d.act('ling');    // Ling: Jungle only
  assert.equal(d.state.picks.blue.jungle, 'ling');
  assert.equal(d.state.picks.blue.exp, 'suyou', 'Suyou flexes to EXP');
  assert.deepEqual(d.picks('blue').map((p) => p.hero), ['suyou', 'ling'], 'pick order unchanged');
});

test('Manual role switch sticks, swaps the occupant, keeps pick order, and updates composition', () => {
  const d = makeDraft('FREE');
  for (const h of ['suyou', 'chou', 'claude']) { d.setTarget({ side: 'blue', type: 'pick' }); d.act(h); }
  assert.equal(d.state.picks.blue.jungle, 'suyou');
  const before = d.team('blue').map((m) => `${m.id}:${m.role}`).join(',');
  assert.ok(d.assignRole('blue', 'suyou', 'exp'));
  const s = d.picks('blue').find((p) => p.hero === 'suyou');
  assert.equal(s.assignedRole, 'exp'); assert.equal(s.roleSource, 'manual');
  assert.notEqual(d.team('blue').map((m) => `${m.id}:${m.role}`).join(','), before, 'composition view changed');
  assert.deepEqual(d.picks('blue').map((p) => p.hero), ['suyou', 'chou', 'claude']);
  // a later pick never overrides a manual role
  d.setTarget({ side: 'blue', type: 'pick' }); d.act('fredrinn');
  assert.equal(d.state.picks.blue.exp, 'suyou');
  // switching into an occupied role swaps
  const roamHero = d.state.picks.blue.roam;
  assert.ok(d.assignRole('blue', 'suyou', 'roam'));
  assert.equal(d.state.picks.blue.roam, 'suyou');
  assert.ok(Object.values(d.state.picks.blue).includes(roamHero), 'displaced hero still has a role');
  assert.ok(d.undo()); assert.equal(d.state.picks.blue.exp, 'suyou', 'undo reverts the switch');
});

test('Roles stay unique and every pick keeps a role through 5 picks', () => {
  const d = makeDraft('FREE');
  for (const h of ['suyou', 'ling', 'hirara', 'nolan', 'fanny']) { d.setTarget({ side: 'blue', type: 'pick' }); assert.ok(d.act(h)); }
  const roles = d.picks('blue').map((p) => p.assignedRole);
  assert.equal(new Set(roles).size, 5); assert.ok(roles.every(Boolean));
});

test('Start over restores the initial state (picks, bans, roles, phase, history)', () => {
  const d = makeDraft('RANKED_DRAFT');
  [...['freya', 'atlas', 'paquito', 'marcel', 'fanny', 'uranus', 'masha', 'barats', 'hylos', 'kalea'], 'suyou'].forEach((h) => d.act(h));
  d.assignRole('blue', 'suyou', 'exp');
  d.reset();
  const s = d.status();
  assert.equal(s.pickedHeroes.blue.length + s.pickedHeroes.red.length + s.bannedHeroes.blue.length + s.bannedHeroes.red.length, 0);
  assert.equal(s.phaseIndex, 0); assert.equal(s.phaseLabel, 'Ban phase · your bans');
  assert.equal(d.canUndo(), false); assert.equal(d.log().length, 0);
  assert.equal(s.format, 'RANKED_DRAFT', 'format kept');
});

console.log(failures ? `\n${failures} test(s) failed` : '\nAll live-input tests passed');
process.exitCode = failures ? 1 : 0;
