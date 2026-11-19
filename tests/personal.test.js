// Personal layer (My Role / My Hero / personal guide) + Draft Rating.
//   node tests/personal.test.js
import assert from 'node:assert/strict';
import { db, meta, makeDraft, makeProfile, setup } from './helpers.js';
import { createRecommendationEngine, ratingBand } from '../src/recommendationEngine.js';
import { createPlayerContext } from '../src/playerContext.js';
import { buildPersonalGuide } from '../src/personalGuide.js';

let failures = 0;
const test = (name, fn) => {
  try { fn(); console.log(`  ✓ ${name}`); } catch (e) { failures++; console.log(`  ✗ ${name}\n      ${e.message.split('\n')[0]}`); }
};
const memStore = () => { const m = new Map(); return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => m.set(k, v) }; };
const ctx = () => createPlayerContext({ lanesOf: (id) => db.get(id)?.lanes, storage: memStore() });
const members = (d, side) => d.team(side).map(({ role, id }) => ({ role, hero: db.get(id) }));
const guideFor = (d, role, heroId) => buildPersonalGuide({ db, ally: members(d, 'blue'), enemy: members(d, 'red'), role, heroId });
const labels = (g) => g.roleBlocks.map((b) => b.label);

console.log('\nPersonal guide');

test('A — Jungle · Suyou: guide is about Jungle Suyou with jungle-specific blocks', () => {
  const d = setup(makeDraft('FREE'), { blue: { jungle: 'suyou', roam: 'tigreal', gold: 'claude' }, red: { jungle: 'ling', gold: 'brody', roam: 'khufra' } });
  const g = guideFor(d, 'jungle', 'suyou');
  console.log(`      ${g.title} | ${g.functionLabel} | ${g.job} | ${g.todo}`);
  assert.equal(g.status, 'ready'); assert.equal(g.title, 'Jungle · Suyou');
  assert.deepEqual(labels(g), ['Tempo objective', 'First Turtle', 'When to invade', 'Target priority', 'With roam & mid']);
  assert.match(g.todo, /Turtle\/Lord/);
});

test('B — Roam · Tigreal: roam blocks; primary engager vs secondary when another engager exists', () => {
  const solo = setup(makeDraft('FREE'), { blue: { roam: 'tigreal', jungle: 'ling', gold: 'claude', mid: 'valentina' }, red: { jungle: 'hirara' } });
  const g1 = guideFor(solo, 'roam', 'tigreal');
  const duo = setup(makeDraft('FREE'), { blue: { roam: 'tigreal', exp: 'gatotkaca', gold: 'claude', mid: 'valentina' }, red: { jungle: 'hirara' } });
  const g2 = guideFor(duo, 'roam', 'tigreal');
  console.log(`      alone: ${g1.functionLabel} — ${g1.job}\n      with Gatotkaca: ${g2.functionLabel} — ${g2.job} | avoid: ${g2.avoid}`);
  assert.equal(g1.title, 'Roam · Tigreal');
  assert.deepEqual(labels(g1), ['Engage or peel', 'Vision', 'Frontline', 'Who to protect', 'When to rotate']);
  assert.equal(g1.function, 'primary-engage');
  assert.equal(g2.function, 'secondary-engage', 'same hero ≠ same job');
  assert.match(g2.job, /Follow up/); assert.match(g2.avoid, /Gatotkaca/);
});

test('C — Jungle · hero undecided → "Choose your hero"', () => {
  const d = setup(makeDraft('FREE'), { blue: { roam: 'tigreal' } });
  const g = guideFor(d, 'jungle', null);
  assert.equal(g.status, 'no-hero'); assert.equal(g.message, 'Choose your hero');
  assert.equal(g.title, 'Jungle · Choose your hero');
  assert.equal(g.roleBlocks.length, 5, 'still gives jungle guidance for the team');
});

test('D — picking Suyou into my Jungle sets My Hero automatically; manual choice wins', () => {
  const me = ctx();
  me.setRole('jungle');
  assert.equal(me.hero, null);
  const d = makeDraft('RANKED_DRAFT');
  ['freya', 'atlas', 'paquito', 'marcel', 'fanny', 'uranus', 'masha', 'barats', 'hylos', 'kalea'].forEach((h) => d.act(h));
  d.act('suyou');                         // our Pick 1, auto-assigned Jungle
  assert.equal(d.state.picks.blue.jungle, 'suyou');
  assert.ok(me.sync(d)); assert.equal(me.hero, 'suyou'); assert.equal(me.heroSource, 'auto');
  me.setHero('saber');                    // manual override
  assert.equal(me.sync(d), false); assert.equal(me.hero, 'saber'); assert.equal(me.heroSource, 'manual');
  me.setHero(null);                       // back to undecided → auto again
  me.sync(d); assert.equal(me.hero, 'suyou');
  me.setRole('roam');                     // role change drops an auto hero that isn't in the new role
  me.sync(d); assert.equal(me.hero, null);
});

test('E — Suyou strong but outside my pool → not my primary personal recommendation', () => {
  const profile = makeProfile({ jungle: { saber: 5, yisunshin: 4 } });
  const e = createRecommendationEngine({ db, meta, profile });
  const d = setup(makeDraft('FREE'), { blue: { roam: 'tigreal', gold: 'claude', mid: 'zhuxin', exp: 'freya' }, red: { jungle: 'ling', gold: 'brody' } });
  const theory = e.analyze(d, 'blue');
  const mine = e.analyze(d, 'blue', { usePool: true });
  const suyouRank = theory.rows.findIndex((r) => r.hero.id === 'suyou') + 1;
  console.log(`      theoretical #1 ${theory.topPick.hero.name}; Suyou theoretical #${suyouRank}; for you: ${mine.topPick.hero.name}`);
  assert.ok(suyouRank > 0, 'Suyou is a legal theoretical option here');
  assert.ok(!mine.rows.some((r) => r.hero.id === 'suyou'), 'not offered as a personal pick (outside my pool)');
  assert.ok(['saber', 'yisunshin'].includes(mine.topPick.hero.id), 'personal pick comes from my pool');
  const c = e.contrastPicks(mine.topPick, theory.topPick);
  console.log(`      why ${c?.mine}: ${c?.forMine.join(', ')} | ${c?.theory} has: ${c?.forTheory.join(', ')}`);
  assert.ok(c.forMine.includes('in your active pool'));
});

test('F — chosen hero is a poor fit → the guide says so and reframes the job', () => {
  // Damage-heavy team with no frontline and no sustained teamfight damage; I am on Saber.
  const d = setup(makeDraft('FREE'), { blue: { jungle: 'saber', mid: 'eudora', gold: 'brody', exp: 'paquito' }, red: { roam: 'khufra', exp: 'yuzhong', jungle: 'fredrinn' } });
  const g = guideFor(d, 'jungle', 'saber');
  console.log(`      fit: ${g.fit.level} — ${g.fit.note}`);
  assert.notEqual(g.fit.level, 'good');
  assert.match(g.fit.note, /Saber is strong individually, but your composition currently lacks/);
  assert.match(g.fit.note, /frontline|damage/);
  assert.match(g.fit.note, /pickoff rather than initiating a 5v5/);
});

test('D2 — my detected hero stays in my role; teammates flex around me', async () => {
  const { createDraftState } = await import('../src/draftState.js');
  const { formats } = await import('./helpers.js');
  const me2 = ctx(); me2.setRole('jungle');
  const d = createDraftState({ lanesOf: (id) => db.get(id)?.lanes, formats, format: 'FREE', heroIds: db.all.map((h) => h.id),
    roleLock: (side, id) => (side === d.userSide && me2.role && me2.hero === id ? me2.role : null) });
  const pick = (id) => { d.setTarget({ side: 'blue', type: 'pick' }); d.act(id); if (me2.sync(d)) d.refreshRoles(); };
  pick('suyou');
  assert.equal(me2.hero, 'suyou');
  for (const id of ['carmilla', 'saber', 'zetian', 'arlott']) pick(id);   // the browser case that used to push Suyou to Gold
  assert.equal(d.state.picks.blue.jungle, 'suyou', 'Suyou stays my Jungle');
  assert.equal(me2.hero, 'suyou', 'My Hero is sticky');
  assert.notEqual(d.state.picks.blue.jungle, 'saber');
});

console.log('\nDraft rating');
const engine = createRecommendationEngine({ db, meta, profile: makeProfile({ jungle: { suyou: 5 } }) });

test('Rating is 0–10, derived from visible components, and never called a win probability', () => {
  const d = setup(makeDraft('FREE'), { blue: { exp: 'yuzhong', jungle: 'suyou', mid: 'valentina', gold: 'claude', roam: 'tigreal' }, red: { exp: 'esmeralda', jungle: 'ling', mid: 'pharsa', gold: 'brody', roam: 'khufra' } });
  const r = engine.rateDraft(d, 'blue', { myHero: 'suyou' });
  console.log(`      ${r.rating} / 10 — ${r.label} | ${JSON.stringify(r.components)}`);
  assert.ok(r.rating >= 0 && r.rating <= 10);
  assert.deepEqual(Object.keys(r.components), ['compositionQuality', 'synergy', 'counterValue', 'winConditionClarity', 'roleCoverage', 'metaValue', 'enemyMatchup', 'playerFit']);
  const recomputed = Object.entries(r.weights).reduce((s, [k, w]) => s + w * r.components[k], 0) * 10;
  assert.ok(Math.abs(recomputed - r.rating) < 0.15, 'rating = Σ weight × component');
  assert.equal(r.perPick.length, 5); assert.equal(Object.keys(r.perPick[0].scores).length, 8, 'eight sub-scores per pick');
  assert.match(r.note, /not a win probability/);
  assert.equal(r.components.playerFit, 1, 'Suyou ★★★★★ → player fit 1');
});

test('A coherent draft rates higher than a broken one', () => {
  const good = setup(makeDraft('FREE'), { blue: { exp: 'yuzhong', jungle: 'suyou', mid: 'valentina', gold: 'claude', roam: 'tigreal' }, red: { exp: 'esmeralda', jungle: 'ling', mid: 'pharsa', gold: 'brody', roam: 'khufra' } });
  const bad = setup(makeDraft('FREE'), { blue: { exp: 'argus', jungle: 'fanny', mid: 'cecilion', gold: 'layla', roam: 'estes' }, red: { exp: 'yuzhong', jungle: 'fredrinn', mid: 'valentina', gold: 'claude', roam: 'tigreal' } });
  const g = engine.rateDraft(good, 'blue'); const b = engine.rateDraft(bad, 'blue');
  console.log(`      coherent ${g.rating} (${g.label}) vs broken ${b.rating} (${b.label})`);
  assert.ok(g.rating - b.rating >= 2);
});

test('Rating bands use the agreed labels', () => {
  const cases = [[9.4, 'Excellent Draft'], [8.4, 'Strong Draft'], [7.0, 'Favorable'], [6.2, 'Playable / Slight Edge'], [5.0, 'Even'], [4.5, 'Difficult'], [3.1, 'Very Difficult']];
  for (const [r, label] of cases) assert.equal(ratingBand(r).label, label, `${r}`);
});

console.log(failures ? `\n${failures} test(s) failed` : '\nAll personal + rating tests passed');
process.exitCode = failures ? 1 : 0;
