// Role board: the full, ranked and explained decision space for one role.
//   node tests/role-board.test.js
import assert from 'node:assert/strict';
import { db, meta, makeDraft, makeProfile, setup } from './helpers.js';
import { createRecommendationEngine, COMPONENTS } from '../src/recommendationEngine.js';

let failures = 0;
const test = (name, fn) => {
  try { fn(); console.log(`  ✓ ${name}`); } catch (e) { failures++; console.log(`  ✗ ${name}\n      ${e.message.split('\n')[0]}`); }
};
const engine = createRecommendationEngine({ db, meta, profile: makeProfile() });
const board = (d, role, eng = engine, opts = {}) => eng.roleBoard(d, 'blue', role, opts).board;
const top = (b, n = 5) => b.entries.slice(0, n).map((e) => `${e.hero.name} ${e.fit}`).join(', ');
const available = (d, role) => db.all.filter((h) => h.lanes.includes(role) && !d.usedBy(h.id));
const fitOf = (b, id) => b.entries.find((e) => e.hero.id === id)?.fit;

// a mid-draft fixture: our frontline/engage is in, the enemy has shown a dive core
const midDraft = () => setup(makeDraft('FREE'), { blue: { roam: 'tigreal', jungle: 'suyou' }, red: { jungle: 'ling', exp: 'yuzhong', mid: 'pharsa' } });

console.log('\nRole board');

test('A — Gold selected: every available Gold hero is on the board', () => {
  const d = midDraft();
  const b = board(d, 'gold');
  const want = available(d, 'gold').map((h) => h.id).sort();
  console.log(`      ${b.entries.length} Gold heroes · top: ${top(b)}`);
  assert.deepEqual(b.entries.map((e) => e.hero.id).sort(), want);
  assert.ok(b.entries.every((e) => e.role === 'gold'));
  assert.equal(b.sections.reduce((t, s) => t + s.entries.length, 0), b.entries.length, 'every hero sits in exactly one section');
});

test('B — the top 5 are ranked by Draft Fit and form the Best fit section', () => {
  const b = board(midDraft(), 'gold');
  const fits = b.entries.map((e) => e.fitRaw);
  assert.deepEqual(fits, [...fits].sort((x, y) => y - x), 'board sorted by Draft Fit');
  assert.equal(b.sections[0].key, 'best');
  assert.deepEqual(b.sections[0].entries.map((e) => e.rank), [1, 2, 3, 4, 5]);
  for (const e of b.entries) {
    assert.ok(e.fit >= 0 && e.fit <= 10);
    const want = e.fit >= 9 ? 'Excellent Fit' : e.fit >= 8 ? 'Strong Fit' : e.fit >= 7 ? 'Good Fit' : e.fit >= 6 ? 'Playable' : e.fit >= 5 ? 'Situational' : 'Low Fit';
    assert.equal(e.label, want, `${e.hero.name} ${e.fit} → tier`);
  }
});

test('C — hover detail: score, eight sub-scores, functions, why, draft job (and why-not-top below #3)', () => {
  const b = board(midDraft(), 'gold');
  for (const e of [b.entries[0], b.entries[6]]) {
    const d = b.detail(e.hero.id);
    assert.equal(d.fit, e.fit);
    assert.ok(d.tier);
    assert.deepEqual(d.breakdown.map((x) => x.key), COMPONENTS, 'all eight sub-scores');
    assert.ok(d.breakdown.every((x) => x.value >= 0 && x.value <= 10));
    assert.ok(d.tags.length >= 1, 'function tags');
    assert.ok(d.why && d.why.length > 10, 'why sentence');
    assert.ok(d.job && d.job.label && d.job.text, 'draft job');
    assert.ok(['High', 'Medium', 'Provisional'].includes(d.confidence.level));
  }
  const d7 = b.detail(b.entries[6].hero.id);
  console.log(`      #7 ${d7.hero.name}: ${d7.why}\n      why not top: ${d7.whyNotTop}`);
  assert.ok(d7.whyNotTop && d7.whyNotTop.includes(b.entries[0].hero.name));
  assert.equal(b.detail(b.entries[0].hero.id).whyNotTop, null);
});

test('D — a My Pool hero gets player-fit weighting (best for you ≠ best overall, Draft Fit unchanged)', () => {
  const d = midDraft();
  const plain = board(d, 'gold');
  const mid = plain.entries[7]; // a decent hero that is not top
  const pooled = createRecommendationEngine({ db, meta, profile: makeProfile({ gold: { [mid.hero.id]: 5 } }) });
  const b = board(d, 'gold', pooled, { myRole: 'gold' });
  const e = b.entries.find((x) => x.hero.id === mid.hero.id);
  console.log(`      ${e.hero.name}: draft fit ${e.fit} · for you ${e.youFit} (was ${mid.youFit}) · best overall ${b.bestOverall.hero.name} ${b.bestOverall.fit}`);
  console.log(`      ${b.forYouNote}`);
  assert.equal(e.fit, mid.fit, 'team Draft Fit does not change with the pool');
  assert.ok(e.youFit > mid.youFit + 1, 'player fit lifts the personal score');
  assert.equal(b.bestForYou.hero.id, mid.hero.id);
  assert.notEqual(b.bestOverall.hero.id, b.bestForYou.hero.id, 'best overall and best for you are kept separate');
  assert.equal(e.pool, 'comfort');
  assert.ok(b.entries.filter((x) => x !== e).every((x) => x.pool === 'off'));
});

test('E — the enemy draft changes the recommendations', () => {
  const ally = { roam: 'tigreal', jungle: 'suyou' };
  const before = board(setup(makeDraft('FREE'), { blue: ally }), 'gold');
  const after = board(setup(makeDraft('FREE'), { blue: ally, red: { jungle: 'ling', exp: 'yuzhong', mid: 'pharsa', roam: 'atlas' } }), 'gold');
  const moves = before.entries.map((e) => ({ n: e.hero.name, d: Math.round(((fitOf(after, e.hero.id) ?? e.fit) - e.fit) * 10) / 10 })).sort((a, b) => Math.abs(b.d) - Math.abs(a.d));
  console.log(`      biggest moves: ${moves.slice(0, 4).map((m) => `${m.n} ${m.d > 0 ? '+' : ''}${m.d}`).join(', ')}`);
  assert.ok(Math.abs(moves[0].d) >= 0.3, 'some Draft Fit moves noticeably');
  assert.equal(before.need.risk, null);
  assert.ok(after.need.risk, `risk shown: ${after.need.risk}`);
  assert.equal(before.entries.filter((e) => e.flags.counter).length, 0, 'no counter picks before the enemy shows heroes');
});

test('F — role need changes the recommendations', () => {
  const front = board(setup(makeDraft('FREE'), { blue: { roam: 'tigreal', exp: 'yuzhong' } }), 'gold');
  const soft = board(setup(makeDraft('FREE'), { blue: { mid: 'pharsa', jungle: 'ling' } }), 'gold');
  console.log(`      with frontline: need ${front.need.primary} · ${top(front, 3)}\n      without: need ${soft.need.primary}/${soft.need.secondary} · ${top(soft, 3)}`);
  assert.notDeepEqual([front.need.primary, front.need.secondary], [soft.need.primary, soft.need.secondary]);
  assert.notDeepEqual(front.entries.slice(0, 5).map((e) => e.hero.id), soft.entries.slice(0, 5).map((e) => e.hero.id));
});

test('G — the Counter filter returns heroes with high counter value', () => {
  const b = board(midDraft(), 'gold');
  const c = b.entries.filter((e) => e.flags.counter);
  const mean = (xs) => xs.reduce((t, e) => t + e.scores.counterScore, 0) / xs.length;
  console.log(`      counters: ${c.map((e) => `${e.hero.name} ${e.scores.counterScore}`).join(', ')} (board mean ${mean(b.entries).toFixed(2)})`);
  assert.ok(c.length >= 1);
  assert.ok(c.every((e) => e.scores.counterScore >= 0.62 && e.row.ctr.reasons.length));
  assert.ok(mean(c) > mean(b.entries) + 0.1);
});

test('H — the Safe filter returns stable, low-risk options', () => {
  for (const role of ['gold', 'jungle', 'roam']) {
    const b = board(midDraft(), role === 'jungle' ? 'mid' : role);
    const s = b.entries.filter((e) => e.flags.safe);
    assert.ok(s.length >= 1, `${role}: has safe options`);
    assert.ok(s.every((e) => !e.risks.length && e.scores.roleFit >= 1 && !e.row.prio.hold && e.confidence.level !== 'Provisional' && e.fit >= 6));
  }
});

test('I — a hero with low/absent meta data still appears, with honest confidence', () => {
  const d = midDraft();
  for (const role of ['gold', 'jungle', 'exp', 'mid', 'roam']) {
    const b = board(d, role);
    const zero = b.entries.filter((e) => { const m = meta.get(e.hero.id); return !m || m.picks + m.bans === 0; });
    for (const e of zero) {
      assert.equal(e.scores.metaScore, 0, 'no invented meta value');
      assert.notEqual(e.confidence.level, 'High');
      assert.ok(e.confidence.reasons.some((r) => /factual zero|unavailable/.test(r)));
    }
    if (role === 'gold') console.log(`      Gold heroes with no ${meta.source.split(' —')[0]} presence still ranked: ${zero.map((e) => `${e.hero.name} #${e.rank} (${e.confidence.level})`).join(', ')}`);
  }
});

test('J — the whole role stays visible even when few heroes score highly', () => {
  // late draft: four of our roles filled, many heroes used
  const d = setup(makeDraft('FREE'), {
    blue: { roam: 'tigreal', jungle: 'suyou', mid: 'pharsa', exp: 'yuzhong' },
    red: { jungle: 'ling', exp: 'freya', mid: 'valentina', roam: 'atlas' },
    bans: { blue: ['claude', 'melissa', 'beatrix'], red: ['brody', 'moskov'] },
  });
  const b = board(d, 'gold');
  const high = b.entries.filter((e) => e.fit >= 8).length;
  console.log(`      ${b.entries.length} Gold heroes shown, ${high} at Strong Fit or better`);
  assert.equal(b.entries.length, available(d, 'gold').length);
  assert.ok(b.entries.length > 5);
  for (const role of ['gold', 'exp', 'jungle', 'mid', 'roam']) assert.equal(board(midDraft(), role).entries.length, available(midDraft(), role).length, role);
});

test('Completed draft — any picked hero can be inspected (fit, functions, synergies, counters, role, job)', () => {
  const d = setup(makeDraft('FREE'), {
    blue: { roam: 'tigreal', jungle: 'suyou', mid: 'pharsa', exp: 'yuzhong', gold: 'claude' },
    red: { jungle: 'ling', exp: 'freya', mid: 'valentina', roam: 'atlas', gold: 'melissa' },
  });
  for (const [side, id] of [['blue', 'claude'], ['red', 'atlas']]) {
    const x = engine.inspectPick(d, side, id);
    console.log(`      ${x.hero.name} (${side}, ${x.role}): ${x.fit} ${x.label} · #${x.rank}/${x.of} · ${x.job?.label} · counters: ${x.counters[0] || '—'}`);
    assert.ok(x.fit >= 0 && x.fit <= 10 && x.label && x.tags.length && x.job && x.breakdown.length === 7);
    assert.ok(Array.isArray(x.synergies) && Array.isArray(x.counters));
  }
});

if (failures) { console.log(`\n${failures} role-board test(s) failed`); process.exit(1); }
console.log('\nAll role-board tests passed');
