// Role-first picking: "what should our <role> pick?" (recommendationRole ≠ myRole).
//   node tests/role-picks.test.js
import assert from 'node:assert/strict';
import { db, meta, makeDraft, makeProfile, setup } from './helpers.js';
import { createRecommendationEngine } from '../src/recommendationEngine.js';
import { functionProfile } from '../src/heroFunctions.js';
import { buildPersonalGuide } from '../src/personalGuide.js';

let failures = 0;
const test = (name, fn) => {
  try { fn(); console.log(`  ✓ ${name}`); } catch (e) { failures++; console.log(`  ✗ ${name}\n      ${e.message.split('\n')[0]}`); }
};
const engine = createRecommendationEngine({ db, meta, profile: makeProfile() });
const fp = (r) => functionProfile(r.hero);
const show = (rec) => rec.cards.map((c) => `${c.label} ${c.hero.name} ${c.score.toFixed(1)} [${c.tags.join(' · ')}]`).join(' | ');
const members = (d, side) => d.team(side).map(({ role, id }) => ({ role, hero: db.get(id) }));

console.log('\nRole-first recommendations');

test('A — selecting Gold shows only Gold-eligible heroes (Best / Safe / Counter)', () => {
  const d = setup(makeDraft('FREE'), { blue: { roam: 'tigreal', jungle: 'suyou' }, red: { jungle: 'ling' } });
  const rec = engine.recommendForRole(d, 'blue', 'gold');
  console.log(`      ${show(rec)}`);
  assert.ok(rec.rows.length > 5);
  assert.ok(rec.rows.every((r) => r.hero.lanes.includes('gold') && r.role === 'gold'));
  assert.deepEqual(rec.cards.map((c) => c.slot), ['best', 'safe', 'counter']);
  const blind = engine.recommendForRole(makeDraft('FREE'), 'blue', 'gold');
  assert.deepEqual(blind.cards.map((c) => c.slot), ['best', 'safe', 'alt'], 'no enemy picks yet → Alternative instead of Counter');
  assert.equal(new Set(rec.cards.map((c) => c.hero.id)).size, 3, 'three different heroes');
  for (const c of rec.cards) { assert.ok(c.why.length >= 1, `${c.label} has a why`); assert.ok(c.tags.length >= 1); }
});

test('B — Gold → Mid → Roam → Gold changes recommendations without touching the draft', () => {
  const d = setup(makeDraft('FREE'), { blue: { roam: 'tigreal', jungle: 'suyou' }, red: { jungle: 'ling' } });
  const before = JSON.stringify(d.state); const log = d.log().length;
  const tops = ['gold', 'mid', 'roam', 'gold'].map((r) => engine.recommendForRole(d, 'blue', r).best.hero.id);
  console.log(`      best per role: ${tops.join(' → ')}`);
  assert.equal(JSON.stringify(d.state), before); assert.equal(d.log().length, log);
  assert.notEqual(tops[0], tops[1]); assert.equal(tops[0], tops[3], 'same role → same answer');
});

test('C — strong frontline → Gold favors damage / scaling', () => {
  const d = setup(makeDraft('FREE'), { blue: { roam: 'tigreal', jungle: 'barats', exp: 'uranus' }, red: { jungle: 'hirara' } });
  const rec = engine.recommendForRole(d, 'blue', 'gold');
  const p = fp(rec.best);
  console.log(`      need: ${rec.need.labels.join(' + ')} — ${rec.need.why} | best ${rec.best.hero.name} (sustained ${p.sustainedDamage}, scaling ${p.scaling})`);
  assert.match(rec.need.why, /frontline/i, 'recognises the existing frontline');
  assert.ok(rec.need.labels.some((l) => /damage|scaling|burst/i.test(l)), 'need is damage/scaling');
  assert.ok(p.sustainedDamage + p.burst >= 1.0 && p.scaling >= 0.6);
});

test('D — enemy heavy dive → Gold favors anti-dive / self-protection', () => {
  const ally = { roam: 'tigreal', jungle: 'suyou', mid: 'zhuxin' };
  const dive = setup(makeDraft('FREE'), { blue: ally, red: { jungle: 'ling', exp: 'chou', mid: 'harith', roam: 'saber' } });
  const calm = setup(makeDraft('FREE'), { blue: ally, red: { jungle: 'barats', exp: 'uranus', mid: 'yve', roam: 'franco' } });
  const r1 = engine.recommendForRole(dive, 'blue', 'gold');
  const r0 = engine.recommendForRole(calm, 'blue', 'gold');
  const selfProt = (r) => { const p = fp(r); return 0.5 * p.antiDive + 0.3 * (r.hero.a.mob / 3) + 0.2 * p.frontline; };
  const avg = (rec) => rec.cards.reduce((t, c) => t + selfProt(c.row), 0) / rec.cards.length;
  console.log(`      threat: ${r1.threat.label} → "${r1.threat.advice}"\n      vs dive: ${show(r1)}\n      vs calm: ${show(r0)}`);
  assert.equal(r1.threat.id, 'dive'); assert.match(r1.threat.advice, /self-protection/);
  assert.ok(avg(r1) > avg(r0), `cards protect themselves better vs dive (${avg(r1).toFixed(2)} vs ${avg(r0).toFixed(2)})`);
  const melissa = (rec) => rec.theory.concat(rec.rows).findIndex((r) => r.hero.id === 'melissa');
  assert.ok(r1.rows.findIndex((r) => r.hero.id === 'melissa') < r0.rows.findIndex((r) => r.hero.id === 'melissa'), 'anti-dive marksman rises');
  void melissa;
});

test('E — myRole Jungle · myHero Suyou, recommendationRole Gold: Gold recs shown, guide stays Jungle · Suyou', () => {
  const e = createRecommendationEngine({ db, meta, profile: makeProfile({ jungle: { suyou: 5 }, gold: { claude: 5 } }) });
  const d = setup(makeDraft('FREE'), { blue: { jungle: 'suyou', roam: 'tigreal' }, red: { jungle: 'ling' } });
  const rec = e.recommendForRole(d, 'blue', 'gold', { myRole: 'jungle' });
  const guide = buildPersonalGuide({ db, ally: members(d, 'blue'), enemy: members(d, 'red'), role: 'jungle', heroId: 'suyou' });
  assert.equal(rec.role, 'gold'); assert.equal(rec.personal, false, 'team perspective: not my role, so not pool-restricted');
  assert.ok(rec.rows.every((r) => r.hero.lanes.includes('gold')));
  assert.equal(guide.title, 'Jungle · Suyou');
});

test('My role = Gold: pool leads; off-pool hero flagged only when dramatically better', () => {
  const e = createRecommendationEngine({ db, meta, profile: makeProfile({ gold: { claude: 5, miya: 3 } }) });
  const d = setup(makeDraft('FREE'), { blue: { roam: 'tigreal', jungle: 'suyou' }, red: { jungle: 'ling' } });
  const rec = e.recommendForRole(d, 'blue', 'gold', { myRole: 'gold' });
  console.log(`      for you: ${rec.mine.map((r) => `${r.hero.name} ${r.score}`).join(', ')} | overall: ${rec.overall.hero.name} ${rec.overall.score} | ${rec.compelling ? `compelling off-pool ${rec.compelling.hero.name} +${rec.compelling.gap}` : `prefer pool: ${rec.preferPool}`}`);
  assert.equal(rec.personal, true);
  assert.ok(['claude', 'miya'].includes(rec.best.hero.id));
  assert.ok(rec.preferPool || rec.compelling, 'either the pool is close enough, or the gap is flagged');
  if (rec.compelling) assert.ok(rec.compelling.gap >= 1.5);
});

test('Next role suggestion: team has Jungle, Mid, Roam → EXP and/or Gold', () => {
  const d = setup(makeDraft('FREE'), { blue: { jungle: 'suyou', mid: 'zhuxin', roam: 'tigreal' } });
  const s = engine.suggestRoles(d, 'blue');
  console.log(`      next role: ${s.join(' or ')}`);
  assert.ok(s.length >= 1 && s.every((r) => ['exp', 'gold'].includes(r)));
});

console.log(failures ? `\n${failures} test(s) failed` : '\nAll role-pick tests passed');
process.exitCode = failures ? 1 : 0;
