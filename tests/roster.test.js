// Hero roster integrity: roster ≠ meta dataset. Uses the offline roster snapshot in data/roster.json
// (refresh with: node tools/check-roster.js --snapshot).
//   node tests/roster.test.js
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { db, meta, makeDraft, makeProfile, setup } from './helpers.js';
import { reconcile } from '../tools/check-roster.js';
import { createRecommendationEngine } from '../src/recommendationEngine.js';
import { functionProfile } from '../src/heroFunctions.js';

let failures = 0;
const test = (name, fn) => {
  try { fn(); console.log(`  ✓ ${name}`); } catch (e) { failures++; console.log(`  ✗ ${name}\n      ${e.message.split('\n')[0]}`); }
};
const roster = JSON.parse(readFileSync(new URL('../data/roster.json', import.meta.url)));
const ROLES = ['exp', 'jungle', 'mid', 'gold', 'roam'];

console.log('\nHero roster');

test('Test 1 — every hero in the current roster exists in the hero database', () => {
  const r = reconcile(roster.snapshot.titles, db, roster);
  console.log(`      roster ${r.roster} · database ${r.database} · missing ${r.missing.length}${r.extra.length ? ` · unmatched ${r.extra.join(', ')}` : ''}`);
  assert.deepEqual(r.missing, []);
  assert.equal(r.roster, r.database);
});

test('Test 2 — every hero has what Match Mode needs (lane, class, functions, portrait, search, role filter)', () => {
  for (const h of db.all) {
    assert.ok(h.id && h.name && h.cls.length, `${h.id}: identity`);
    assert.ok(ROLES.includes(h.primaryLane), `${h.id}: primary lane`);
    assert.ok(h.lanes.every((l) => ROLES.includes(l)), `${h.id}: lanes`);
    assert.ok(Object.values(functionProfile(h)).some((v) => v > 0), `${h.id}: function profile`);
    assert.ok(typeof h.portraitUrl === 'string' && h.portraitUrl.length > 0, `${h.id}: portraitUrl`);
    assert.equal(db.search(h.name)[0].id, h.id, `${h.id}: searchable by name`);
  }
});

test('Test 3 — a hero with zero MPL S18 data is still available, with explicit zero stats (not invented)', () => {
  const m = meta.get('odette');
  assert.deepEqual({ picks: m.picks, bans: m.bans, wins: m.wins, losses: m.losses, presence: m.presence, absent: m.absent }, { picks: 0, bans: 0, wins: 0, losses: 0, presence: 0, absent: true });
  assert.equal(m.winRate, null, 'no win rate without games');
  assert.ok(makeDraft('RANKED_DRAFT').status().availableHeroes.includes('odette'));
});

test('Test 4 — Odette can be searched', () => {
  assert.equal(db.search('Ode')[0].id, 'odette');
  assert.equal(db.search('odette')[0].name, 'Odette');
});

test('Test 5 — Odette can be picked (role inferred as Mid, switchable)', () => {
  const d = makeDraft('RANKED_DRAFT');
  ['freya', 'atlas', 'paquito', 'marcel', 'fanny', 'uranus', 'masha', 'barats', 'hylos', 'kalea'].forEach((h) => d.act(h));
  assert.ok(d.act('odette'));
  assert.equal(d.state.picks.blue.mid, 'odette');
  assert.ok(d.assignRole('blue', 'odette', 'roam'));
  assert.equal(d.state.picks.blue.roam, 'odette');
});

test('Test 6 — Odette can be banned (and double-banned in a blind Ranked phase)', () => {
  const d = makeDraft('RANKED_DRAFT');
  assert.ok(d.act('odette'));
  ['atlas', 'paquito', 'marcel', 'fanny'].forEach((h) => d.act(h));
  assert.ok(d.act('odette'), 'enemy can ban Odette too');
  assert.deepEqual(d.status().doubleBans, ['odette']);
});

test('Test 7 — no historical meta does not break recommendations or Draft Rating', () => {
  const e = createRecommendationEngine({ db, meta, profile: makeProfile() });
  const d = setup(makeDraft('FREE'), { blue: { roam: 'tigreal', jungle: 'suyou', gold: 'claude', exp: 'yuzhong' }, red: { jungle: 'ling' } });
  const rows = e.analyze(d, 'blue').rows;
  const o = rows.find((r) => r.hero.id === 'odette');
  assert.ok(o, 'Odette is a candidate for Mid');
  assert.equal(o.scores.metaScore, 0, 'meta value = factual zero presence, nothing invented');
  assert.ok(Number.isFinite(o.draftFit));
  const full = setup(makeDraft('FREE'), { blue: { roam: 'tigreal', jungle: 'suyou', gold: 'claude', exp: 'yuzhong', mid: 'odette' }, red: { jungle: 'ling', mid: 'cyclops', exp: 'jawhead', gold: 'brody', roam: 'khufra' } });
  const r = e.rateDraft(full, 'blue');
  console.log(`      draft with Odette rated ${r.rating} / 10 (${r.label}); Odette meta ${o.scores.metaScore}, draft fit ${o.score}`);
  assert.ok(Number.isFinite(r.rating) && r.rating > 0);
  assert.ok(Object.values(r.components).every((v) => v == null || Number.isFinite(v)));
});

console.log(failures ? `\n${failures} test(s) failed` : '\nAll roster tests passed');
process.exitCode = failures ? 1 : 0;
