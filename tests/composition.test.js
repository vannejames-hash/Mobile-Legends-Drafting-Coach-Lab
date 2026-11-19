// Chapter 2 — Composition Intelligence: deterministic tests.
//   node tests/composition.test.js
import assert from 'node:assert/strict';
import { db, meta, makeDraft, makeProfile, setup } from './helpers.js';
import { createRecommendationEngine } from '../src/recommendationEngine.js';
import { functionProfile, topFunctions, FUNCTIONS } from '../src/heroFunctions.js';
import { analyzeDraft, ARCHETYPES, heroVsTeam } from '../src/compositionEngine.js';
import { createHeroDatabase } from '../src/heroDatabase.js';

let failures = 0;
const test = (name, fn) => {
  try { fn(); console.log(`  ✓ ${name}`); } catch (e) { failures++; console.log(`  ✗ ${name}\n      ${e.message.split('\n')[0]}`); }
};
const engine = createRecommendationEngine({ db, meta, profile: makeProfile() });
const members = (d, side) => d.team(side).map(({ role, id }) => ({ role, hero: db.get(id) }));
const fpOf = (id) => functionProfile(db.get(id));
const rankOf = (res, id) => res.rows.findIndex((r) => r.hero.id === id) + 1;

console.log('\nFunction layer');
test('Heroes carry many functions with 0–1 strengths (not one label, not booleans)', () => {
  const t = fpOf('tigreal'); const s = fpOf('saber'); const u = fpOf('suyou');
  console.log(`      Tigreal ${topFunctions(db.get('tigreal')).map(([k, v]) => `${k} ${v}`).join(', ')}`);
  console.log(`      Saber   ${topFunctions(db.get('saber')).map(([k, v]) => `${k} ${v}`).join(', ')}`);
  console.log(`      Suyou   ${topFunctions(db.get('suyou')).map(([k, v]) => `${k} ${v}`).join(', ')}`);
  assert.equal(Object.keys(t).length, FUNCTIONS.length);
  assert.ok(t.engage >= 0.9 && t.frontline >= 0.9 && t.peel >= 0.6 && t.burst <= 0.35 && t.poke <= 0.1);
  assert.ok(s.pickoff >= 0.9 && s.burst >= 0.9 && s.backlineAccess >= 0.9 && s.frontline <= 0.15 && s.peel <= 0.1);
  assert.ok(u.dive >= 0.9 && u.objectiveControl >= 0.9 && u.engage >= 0.5 && u.frontline > 0);
  assert.ok(Object.values(t).some((v) => v > 0 && v < 1), 'graded strengths, not booleans');
});

test('Composition vector exposes what the team has enough of', () => {
  const d = setup(makeDraft('FREE'), { blue: { roam: 'tigreal', jungle: 'suyou', gold: 'claude' } });
  const A = analyzeDraft(members(d, 'blue'), [], db);
  console.log(`      vector (0–10): ${['frontline', 'engage', 'peel', 'burst', 'sustainedDamage', 'poke', 'dive', 'scaling', 'objectiveControl'].map((k) => `${k} ${A.ally.profile[k]}`).join(' · ')}`);
  assert.ok(A.ally.profile.engage > A.ally.profile.poke);
  assert.ok(A.ally.vector.frontline > 0 && A.ally.vector.dive > 0);
  assert.ok(A.ally.archetypes.some((x) => x.id === 'split'), 'Split / Side Pressure archetype exists');
});

console.log('\nTeam needs + enemy threats');
test('TEST 1 — team lacks frontline → frontline hero rises', () => {
  const d = setup(makeDraft('FREE'), { blue: { jungle: 'ling', mid: 'valentina', gold: 'claude' }, red: { jungle: 'hirara' } });
  const res = engine.analyze(d, 'blue');
  const needs = res.analysis.ally.needs.slice(0, 3).map((n) => n.label);
  console.log(`      needs: ${needs.join(' · ')} | top ${res.topPick.hero.name} (frontline ${fpOf(res.topPick.hero.id).frontline})`);
  assert.ok(needs.some((n) => /frontline/i.test(n)));
  assert.ok(fpOf(res.topPick.hero.id).frontline >= 0.6);
});

test('TEST 2 — two tanks, little damage → damage-oriented hero rises', () => {
  const d = setup(makeDraft('FREE'), { blue: { roam: 'atlas', jungle: 'barats', mid: 'faramis' }, red: { jungle: 'ling' } });
  const res = engine.analyze(d, 'blue');
  const p = fpOf(res.topPick.hero.id);
  console.log(`      needs: ${res.analysis.ally.needs.slice(0, 3).map((n) => n.label).join(' · ')} | top ${res.topPick.hero.name} (burst ${p.burst}, sustained ${p.sustainedDamage}, frontline ${p.frontline})`);
  assert.ok(p.burst + p.sustainedDamage >= 1.2, 'damage dealer');
  assert.ok(p.frontline <= 0.67, 'not another tank');
});

test('TEST 3 — enemy heavy dive → peel / anti-dive rises; threat + response named', () => {
  const ally = { jungle: 'suyou', gold: 'claude', mid: 'valentina' };
  const d = setup(makeDraft('FREE'), { blue: ally, red: { jungle: 'ling', exp: 'chou', mid: 'harith', gold: 'wanwan' } });
  const calm = setup(makeDraft('FREE'), { blue: ally, red: { jungle: 'barats', exp: 'uranus', mid: 'yve', gold: 'moskov' } });
  const res = engine.analyze(d, 'blue'); const base = engine.analyze(calm, 'blue');
  const th = res.analysis.enemy.threats;
  console.log(`      threats: ${th.map((t) => `${t.label} ${t.level} (${t.heroes.join(', ')})`).join(' | ')}\n      response: ${th[0].response} | top ${res.topPick.hero.name}`);
  assert.equal(th[0].id, 'dive');
  assert.match(th[0].response, /Protect Gold\/Mid/);
  assert.ok(fpOf(res.topPick.hero.id).antiDive >= 0.5 || fpOf(res.topPick.hero.id).peel >= 0.6);
  assert.ok(rankOf(res, 'khufra') < rankOf(base, 'khufra'), 'anti-dive hero rises vs dive');
});

test('TEST 4 — enemy vulnerable backline → pickoff/dive rises', () => {
  const ally = { roam: 'tigreal', gold: 'claude', mid: 'zhuxin' };
  const d = setup(makeDraft('FREE'), { blue: ally, red: { gold: 'miya', mid: 'cecilion', roam: 'estes' } });
  const calm = setup(makeDraft('FREE'), { blue: ally, red: { gold: 'karrie', mid: 'valir', roam: 'khufra' } });
  const res = engine.analyze(d, 'blue'); const base = engine.analyze(calm, 'blue');
  const p = fpOf(res.topPick.hero.id);
  console.log(`      top ${res.topPick.hero.name} (pickoff ${p.pickoff}, dive ${p.dive}); Chou #${rankOf(base, 'chou')} → #${rankOf(res, 'chou')}`);
  assert.ok(p.pickoff >= 0.7 || p.dive >= 0.7);
  assert.ok(rankOf(res, 'chou') < rankOf(base, 'chou'));
});

test('TEST 5 — engage but poor follow-up → follow-up damage/CC rises', () => {
  const d = setup(makeDraft('FREE'), { blue: { roam: 'tigreal', jungle: 'akai', exp: 'uranus' }, red: { jungle: 'hirara' } });
  const res = engine.analyze(d, 'blue');
  const t = res.topPick; const p = fpOf(t.hero.id);
  console.log(`      top ${t.hero.name} (burst ${p.burst}, sustained ${p.sustainedDamage}, disruption ${p.disruption}) | synergy: ${t.syn.notes.join('; ')}`);
  assert.ok(p.burst + p.sustainedDamage >= 1.0 || p.disruption >= 0.7);
  assert.ok(t.syn.notes.some((n) => /follow-up for/.test(n)), 'functional synergy: engage + follow-up');
});

test('TEST 6 — too much physical damage → magic damage rises', () => {
  const d = setup(makeDraft('FREE'), { blue: { jungle: 'ling', gold: 'claude', exp: 'paquito' }, red: { jungle: 'hirara' } });
  const A = engine.analysisFor(d, 'blue');
  const res = engine.analyze(d, 'blue');
  const dealer = (r) => { const p = fpOf(r.hero.id); return p.burst + p.sustainedDamage >= 1.0; };
  const bestDealer = res.rows.find(dealer);
  console.log(`      physical share ${A.ally.damage.physicalShare} | needs: ${A.ally.needs.slice(0, 3).map((n) => n.label).join(' · ')} | best damage pick ${bestDealer.hero.name} (${bestDealer.hero.dmg}) #${rankOf(res, bestDealer.hero.id)}`);
  assert.ok(A.ally.damage.physicalShare >= 0.8);
  assert.ok(A.ally.needs.some((n) => n.id === 'magic'), 'magic damage named as a need');
  assert.equal(bestDealer.hero.dmg, 'm', 'the best damage-dealing option deals magic damage');
  // and it rises compared with the same open slots on a magic-heavy team
  const magicTeam = setup(makeDraft('FREE'), { blue: { jungle: 'gusion', gold: 'natan', exp: 'alice' }, red: { jungle: 'hirara' } });
  const base = engine.analyze(magicTeam, 'blue');
  assert.ok(rankOf(res, bestDealer.hero.id) < rankOf(base, bestDealer.hero.id), `${bestDealer.hero.name} rises when the team is physical-heavy`);
});

console.log('\nPlayer fit');
test('TEST 7 — Saber ★★★★★ vs Suyou ★★★: similar fit → Saber gets higher playerFit', () => {
  const e = createRecommendationEngine({ db, meta, profile: makeProfile({ jungle: { saber: 5, suyou: 3 } }) });
  const d = setup(makeDraft('FREE'), { blue: { roam: 'tigreal', gold: 'claude', mid: 'zhuxin', exp: 'freya' } });
  const res = e.analyze(d, 'blue', { usePool: true });
  const saber = res.rows.find((r) => r.hero.id === 'saber'); const suyou = res.rows.find((r) => r.hero.id === 'suyou');
  console.log(`      playerFit saber ${saber.scores.playerFit} vs suyou ${suyou.scores.playerFit}`);
  assert.equal(saber.scores.playerFit, 1); assert.equal(suyou.scores.playerFit, 0.6);
});

test('TEST 8 — theoretical best outside the pool is still shown; playable best recommended separately', () => {
  const e = createRecommendationEngine({ db, meta, profile: makeProfile({ jungle: { saber: 5, yisunshin: 4 } }) });
  const d = setup(makeDraft('FREE'), { blue: { roam: 'tigreal', gold: 'claude', mid: 'zhuxin', exp: 'freya' }, red: { gold: 'brody' } });
  const theory = e.analyze(d, 'blue'); const mine = e.analyze(d, 'blue', { usePool: true });
  const c = e.contrastPicks(mine.topPick, theory.topPick);
  console.log(`      theoretical ${theory.topPick.hero.name} ${theory.topPick.score} | for you ${mine.topPick.hero.name} ${mine.topPick.score} | ${c ? c.forMine.join(', ') : 'same hero'}`);
  assert.ok(!['saber', 'yisunshin'].includes(theory.topPick.hero.id), 'theoretical best is outside the pool');
  assert.ok(['saber', 'yisunshin'].includes(mine.topPick.hero.id));
  assert.ok(c.forMine.includes('in your active pool'));
});

console.log('\nCounters, synergy, win condition, personal job');
test('Counters are tiered: direct, functional, composition', () => {
  const d = setup(makeDraft('FREE'), { red: { jungle: 'ling', exp: 'chou', mid: 'harith', gold: 'wanwan' } });
  const A = engine.analysisFor(d, 'blue');
  const k = heroVsTeam(db.get('khufra'), A.enemy);
  console.log(`      Khufra vs dive team: ${JSON.stringify(k.tiers)} | ${k.reasons.slice(0, 4).join('; ')}`);
  assert.ok(k.tiers.direct > 0, 'direct counters');
  assert.ok(k.tiers.functional > 0, 'functional: answers the dive threat');
});

test('Rules generalize to an unseen hero (no hand-written hero pairs)', () => {
  // A brand-new engage tank that no rule, counter or synergy list mentions.
  const raw = { heroes: [{ id: 'newtank', name: 'Newtank', class: ['Tank'], damageType: 'magic', lanes: { primary: 'roam', flex: {} }, functions: [], archetypes: [],
    ratings: { frontline: 3, engage: 3, cc: 3, burst: 0, damage: 0, poke: 0, mobility: 1, peel: 2, sustain: 0, objective: 1, dive: 1, early: 2, scaling: 2 }, flags: [] }] };
  const nt = createHeroDatabase(raw).get('newtank');
  const p = functionProfile(nt);
  const d = setup(makeDraft('FREE'), { blue: { jungle: 'ling', mid: 'valentina', gold: 'claude' } });
  const A = engine.analysisFor(d, 'blue');
  const syn = engine.scoreInContext(nt, 'roam', members(d, 'blue'), []);
  console.log(`      Newtank: engage ${p.engage}, frontline ${p.frontline} → synergy ${syn.synergyScore}, composition fit ${syn.compositionFit}`);
  assert.ok(p.engage >= 0.9 && p.frontline >= 0.9);
  assert.ok(syn.synergyScore > 0.5, 'engage + existing damage dealers = synergy, by rule');
  assert.ok(syn.compositionFit >= 0.8, 'fills the missing frontline/engage');
  void A;
});

test('Win condition engine: primary, secondary, required and failure conditions', () => {
  const d = setup(makeDraft('FREE'), { blue: { roam: 'tigreal', jungle: 'suyou', gold: 'claude', mid: 'zhuxin', exp: 'yuzhong' }, red: { jungle: 'ling', exp: 'chou', mid: 'harith', gold: 'wanwan', roam: 'mathilda' } });
  const w = engine.analysisFor(d, 'blue').ally.win;
  console.log(`      ${w.primary} | ${w.secondary} | required: ${w.required} | failure: ${w.failure}`);
  assert.ok(w.primary && w.required && w.failure);
  assert.match(w.failure, /isolated|caught|engage/i);
});

test('Same hero, different job: Tigreal engages, peels, or protects against dive', () => {
  return import('../src/personalGuide.js').then(({ buildPersonalGuide }) => {
    const g = (blue, red) => { const d = setup(makeDraft('FREE'), { blue, red }); return buildPersonalGuide({ db, ally: members(d, 'blue'), enemy: members(d, 'red'), role: 'roam', heroId: 'tigreal' }); };
    const alone = g({ roam: 'tigreal', gold: 'claude', mid: 'valentina' }, { jungle: 'hirara' });
    const second = g({ roam: 'tigreal', exp: 'gatotkaca', gold: 'claude' }, { jungle: 'hirara' });
    const vsDive = g({ roam: 'tigreal', gold: 'claude', mid: 'valentina' }, { jungle: 'ling', exp: 'chou', mid: 'harith', gold: 'wanwan' });
    console.log(`      alone: ${alone.function} | with Gatotkaca: ${second.function} | vs dive: ${vsDive.function} — ${vsDive.job}`);
    assert.equal(alone.function, 'primary-engage');
    assert.equal(second.function, 'secondary-engage');
    assert.equal(vsDive.function, 'anti-dive');
    assert.match(vsDive.job, /Protect your Gold and Mid/);
  });
});

test('Why #1 is explained from the actual components', () => {
  const e = createRecommendationEngine({ db, meta, profile: makeProfile({ jungle: { suyou: 5 } }) });
  const d = setup(makeDraft('FREE'), { blue: { roam: 'tigreal', gold: 'claude', mid: 'zhuxin', exp: 'freya' }, red: { gold: 'brody' } });
  const r = e.analyze(d, 'blue', { usePool: true }).topPick;
  const shown = Object.fromEntries(Object.entries(r.scores).map(([k, v]) => [k, (v * 10).toFixed(1)]));
  console.log(`      ${r.hero.name} ${r.score} ${JSON.stringify(shown)}\n      why: ${r.reasons.join(' · ')}`);
  assert.ok(r.reasons.length >= 2);
  for (const reason of r.reasons) assert.ok(/needs|engage|plan|pool|presence|counter|answers|protect|follow-up|win condition|flex|meta|strengthens|balance|lockdown|Punishes|Fits/i.test(reason), reason);
  assert.ok(r.reasons.some((x) => /pool/.test(x)), 'player fit appears when it drives the pick');
});

console.log(failures ? `\n${failures} test(s) failed` : '\nAll composition-intelligence tests passed');
process.exitCode = failures ? 1 : 0;
