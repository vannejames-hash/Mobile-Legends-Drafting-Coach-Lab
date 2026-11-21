// Signature hero (D–F), role matchup (G–J), itemization priorities (K–O).
//   node tests/coach-pass.test.js
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { db, meta, makeDraft, makeProfile, setup } from './helpers.js';
import { createRecommendationEngine } from '../src/recommendationEngine.js';
import { analyzeCompletedDraft } from '../src/draftAnalysis.js';

let failures = 0;
const test = (name, fn) => { try { fn(); console.log(`  ✓ ${name}`); } catch (e) { failures++; console.log(`  ✗ ${name}\n      ${e.message.split('\n')[0]}`); } };
const items = JSON.parse(readFileSync(new URL('../data/items.json', import.meta.url)));
const team = (o) => Object.entries(o).map(([role, id]) => ({ role, hero: db.get(id) }));
const run = (a, e, me = ['jungle', 'saber']) => analyzeCompletedDraft({ db, ally: team(a), enemy: team(e), myRole: me[0], myHero: me[1], items });
const POOL = { jungle: { saber: 5, suyou: 5 } };
const US = { jungle: 'saber', roam: 'tigreal', mid: 'pharsa', exp: 'paquito', gold: 'claude' };
const THEM = { jungle: 'karina', mid: 'kadita', roam: 'angela', exp: 'yuzhong', gold: 'ixia' };

console.log('\nSignature hero');

test('D — signature outside the top 5 still appears, as its own card', () => {
  const e = createRecommendationEngine({ db, meta, profile: makeProfile(POOL) });
  const b = e.roleBoard(makeDraft('FREE'), 'blue', 'jungle', { myRole: 'jungle' }).board;
  console.log(`      top 5: ${b.entries.slice(0, 5).map((x) => x.hero.name).join(', ')} · signature ${b.signature.entry.hero.name} #${b.signature.entry.rank}`);
  assert.equal(b.signature.entry.hero.id, 'saber', 'Saber is the default signature (first ★5 jungle hero)');
  assert.equal(b.signature.inTop5, false);
  assert.ok(b.signature.why.length > 20);
  assert.equal(e.roleBoard(makeDraft('FREE'), 'blue', 'gold', { myRole: 'jungle' }).board.signature, null, 'only on your own role');
});

test('E — a signature already in the top 5 is marked, not duplicated (any configured hero)', () => {
  const prof = makeProfile({ jungle: { saber: 5, barats: 4 } });
  prof.signature = (r) => (r === 'jungle' ? 'barats' : null);
  const b = createRecommendationEngine({ db, meta, profile: prof }).roleBoard(makeDraft('FREE'), 'blue', 'jungle', { myRole: 'jungle' }).board;
  assert.equal(b.signature.entry.hero.id, 'barats');
  assert.equal(b.signature.inTop5, true);
  assert.equal(b.entries.filter((x) => x.hero.id === 'barats').length, 1);
  assert.equal(b.sections[0].entries.find((x) => x.hero.id === 'barats').signature, true, 'card marked ★ Your signature');
});

test('F — a poor-fit signature says “Low draft fit / High player fit”; Draft Fit is not inflated', () => {
  const plain = createRecommendationEngine({ db, meta, profile: makeProfile() }).roleBoard(makeDraft('FREE'), 'blue', 'jungle').board;
  const b = createRecommendationEngine({ db, meta, profile: makeProfile(POOL) }).roleBoard(makeDraft('FREE'), 'blue', 'jungle', { myRole: 'jungle' }).board;
  const S = b.signature;
  console.log(`      ${S.entry.hero.name}: draft fit ${S.entry.fit} (no-pool engine: ${plain.entries.find((x) => x.hero.id === 'saber').fit}) · player fit ${S.playerFit}\n      ${S.why}`);
  assert.equal(S.entry.fit, plain.entries.find((x) => x.hero.id === 'saber').fit, 'same Draft Fit with or without the pool');
  assert.equal(S.playerFit, 10); assert.equal(S.lowFit, true);
});

console.log('\nRole matchup');

test('G — a complete draft has five role matchups with a summary', () => {
  const M = run(US, THEM).roleMatchup;
  for (const x of M.rows) console.log(`      ${x.role.padEnd(6)} ${x.us.name} vs ${x.them.name}: ${x.edge > 0 ? '+' : ''}${x.edge} ${x.label} — ${x.reason}`);
  assert.equal(M.rows.length, 5);
  assert.deepEqual(M.rows.map((x) => x.role), ['exp', 'jungle', 'mid', 'gold', 'roam']);
  assert.ok(M.sentence && M.decisive && M.enemyStrongest);
  for (const x of M.rows) {
    const want = x.edge >= 1 ? 'Strong advantage' : x.edge >= 0.3 ? 'Slight advantage' : x.edge >= -0.2 ? 'Even' : x.edge >= -0.9 ? 'Slight disadvantage' : 'Major disadvantage';
    assert.equal(x.label, want);
  }
});

test('H — changing our Jungle hero changes the Jungle matchup', () => {
  const a = run(US, THEM).roleMatchup.rows.find((x) => x.role === 'jungle');
  const b = run({ ...US, jungle: 'barats' }, THEM, ['jungle', 'barats']).roleMatchup.rows.find((x) => x.role === 'jungle');
  console.log(`      Saber ${a.edge} (${a.reason}) → Barats ${b.edge} (${b.reason})`);
  assert.notEqual(a.edge, b.edge);
});

test('I — changing the enemy Gold changes the Gold matchup', () => {
  const a = run(US, THEM).roleMatchup.rows.find((x) => x.role === 'gold');
  const b = run(US, { ...THEM, gold: 'brody' }).roleMatchup.rows.find((x) => x.role === 'gold');
  console.log(`      vs Ixia ${a.edge} → vs Brody ${b.edge}`);
  assert.notEqual(a.edge, b.edge);
});

test('J — role matchup is not the Draft Fit difference', () => {
  const d = setup(makeDraft('FREE'), { blue: US, red: THEM });
  const e = createRecommendationEngine({ db, meta, profile: makeProfile() });
  const M = run(US, THEM).roleMatchup;
  // related signals, so some roles agree; but the role matchup must be its own measure, not a copy
  const gaps = M.rows.map((x) => ({ role: x.role, edge: x.edge, gap: Math.round((e.inspectPick(d, 'blue', x.us.id).fit - e.inspectPick(d, 'red', x.them.id).fit) * 10) / 10 }));
  console.log(`      ${gaps.map((g) => `${g.role} ${g.edge} vs fit gap ${g.gap}`).join(' · ')}`);
  assert.ok(gaps.some((g) => Math.abs(g.edge - g.gap) >= 0.8), 'at least one role diverges clearly from the Draft Fit gap');
  assert.ok(!gaps.every((g) => Math.abs(g.edge - g.gap) <= 0.1), 'not identical to the Draft Fit gap');
});

console.log('\nItemization priorities');
const ENEMY = {
  physical: { jungle: 'lancelot', exp: 'paquito', gold: 'brody', mid: 'yisunshin', roam: 'chou' },
  magic: { mid: 'kagura', jungle: 'harley', roam: 'vale', exp: 'alice', gold: 'kimmy' },
  heal: { roam: 'estes', mid: 'valir', gold: 'karrie', exp: 'esmeralda', jungle: 'alucard' },
  mixed: { gold: 'miya', mid: 'lylia', exp: 'cici', jungle: 'harley', roam: 'diggie' },
};
const I = (e, me) => run(US, ENEMY[e], me).personal.items;
const stars = (x, id) => x.traits.find((t) => t.id === id)?.stars || 0;

test('K — physical-heavy enemy → physical durability rises', () => {
  const a = I('physical', ['roam', 'tigreal']); const b = I('magic', ['roam', 'tigreal']);
  assert.ok(stars(a, 'physical') >= 4 && stars(a, 'physical') > stars(b, 'physical'));
  assert.equal(a.items[0].item.name, 'Antique Cuirass');
});

test('L — magic-heavy enemy → magic resistance rises', () => {
  const a = I('magic', ['roam', 'tigreal']); const b = I('physical', ['roam', 'tigreal']);
  assert.ok(stars(a, 'magic') >= 4 && stars(a, 'magic') > stars(b, 'magic'));
  assert.ok(a.items.some((x) => x.trait === 'magic'));
});

test('M — heavy healing / shields → anti-heal rises', () => {
  const a = I('heal', ['jungle', 'saber']);
  assert.ok(stars(a, 'antiHeal') >= 4);
  assert.equal(a.items[0].trait, 'antiHeal');
  assert.match(a.items[0].why, /Estes/);
});

test('N — no major adaptation needed → nothing is invented', () => {
  for (const me of [['jungle', 'saber'], ['gold', 'claude']]) {
    const a = I('mixed', me);
    assert.equal(a.items.length, 0, `${me[1]}: no items`);
    assert.match(a.none, /No major adaptation required/);
  }
});

test('O — same enemy, different hero / job → different item and reasoning', () => {
  const saber = I('heal', ['jungle', 'saber']); const tig = I('heal', ['roam', 'tigreal']);
  console.log(`      Saber: ${saber.items.map((x) => x.item.name).join(', ')} · Tigreal: ${tig.items.map((x) => x.item.name).join(', ')}`);
  assert.notEqual(saber.items[0].item.id, tig.items[0].item.id);
  const phys = I('physical', ['jungle', 'saber']); const physC = I('physical', ['gold', 'claude']);
  assert.notDeepEqual(phys.items.map((x) => x.item.id), physC.items.map((x) => x.item.id));
  for (const x of [...saber.items, ...tig.items, ...phys.items]) assert.ok(items.items.some((c) => c.id === x.item.id), `${x.item.name} comes from the catalog`);
});

test('Evidence gate — every strength names its heroes; items never cite an unnamed threat', () => {
  for (const e of Object.values(ENEMY)) {
    const r = run(US, e);
    assert.ok(r.strengths.every((s) => /from |[A-Z][a-z]/.test(s.detail || '')), 'strength without a source');
    assert.ok(r.personal.items.traits.every((t) => t.evidence && /[A-Z]/.test(t.evidence)));
  }
});

if (failures) { console.log(`\n${failures} coach-pass test(s) failed`); process.exit(1); }
console.log('\nAll coach-pass tests passed');
