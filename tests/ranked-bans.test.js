// Ranked Draft (one blind 5+5 ban phase → picks B1 R2 B2 R2 B2 R1) vs Tournament / MPL.
//   node tests/ranked-bans.test.js
import assert from 'node:assert/strict';
import { db, makeDraft, formats } from './helpers.js';

let failures = 0;
const test = (name, fn) => {
  try { fn(); console.log(`  ✓ ${name}`); } catch (e) { failures++; console.log(`  ✗ ${name}\n      ${e.message.split('\n')[0]}`); }
};
const ranked = (side = 'blue') => makeDraft('RANKED_DRAFT', side);
const ban = (d, h) => { const ok = h === null ? d.noBan() : d.act(h); assert.ok(ok, `ban ${h ?? 'No ban'} rejected: ${h ? d.canAct(h).reason : d.canNoBan().reason}`); };
const OUR = ['freya', 'atlas', 'paquito', 'fanny', 'marcel'];
const THEIRS = ['freya', 'barats', 'uranus', 'suyou', 'saber'];

console.log('\nRanked Draft');

test('Format declarations: 1 blind ban phase, 5 per side, no second phase, pick order B1 R2 B2 R2 B2 R1', () => {
  const f = formats.RANKED_DRAFT;
  assert.equal(f.banPhaseCount, 1); assert.equal(f.bansPerSide, 5); assert.equal(f.blindBans, true);
  assert.equal(f.secondBanPhase, false); assert.deepEqual(f.pickOrder, ['B1', 'R2', 'B2', 'R2', 'B2', 'R1']);
  assert.ok(!f.steps.some((s) => /2/.test(s.phaseLabel) && s.type === 'ban'), 'no "Ban phase 2" label');
});

test('Test A — full ban phase: 10 events, then straight into Pick 1, no second ban phase', () => {
  const d = ranked();
  OUR.forEach((h) => ban(d, h));
  assert.equal(d.status().phaseLabel, 'Ban phase · enemy bans');
  THEIRS.forEach((h) => ban(d, h));
  const s = d.status();
  assert.equal(s.banEvents.length, 10);
  assert.equal(s.actionType, 'pick'); assert.equal(s.actionNumber, 1); assert.equal(s.side, 'blue');
  assert.equal(s.phaseLabel, 'Pick phase');
  assert.equal(d.format.steps.filter((x) => x.type === 'ban' && x.index > s.stepIndex).length, 0, 'no ban step after picks start');
});

test('Test B — duplicate blind ban: both accepted, both kept, Freya unavailable after reveal', () => {
  const d = ranked();
  OUR.forEach((h) => ban(d, h));
  assert.ok(d.canAct('freya').ok, 'enemy may ban Freya too (blind)');
  THEIRS.forEach((h) => ban(d, h));
  const ev = d.banEvents().filter((e) => e.hero === 'freya');
  assert.equal(ev.length, 2); assert.ok(ev.every((e) => e.result === 'double'));
  assert.deepEqual(d.status().doubleBans, ['freya']);
  assert.equal(d.canAct('freya').ok, false); assert.ok(!d.status().availableHeroes.includes('freya'));
});

test('Test C — No ban: slot consumed, nothing blocked, draft advances', () => {
  const d = ranked();
  const before = d.status().availableHeroes.length;
  ban(d, null);
  assert.deepEqual(d.state.bans.blue, [null]);
  assert.equal(d.status().actionNumber, 2);
  assert.equal(d.status().availableHeroes.length, before);
  assert.deepEqual(d.banEvents()[0], { side: 'blue', wave: 1, slot: 1, hero: null, result: 'no-ban' });
});

test('Test D — pick order: B1 · R1 R2 · B2 B3 · R3 R4 · B4 B5 · R5', () => {
  const d = ranked();
  [...OUR, ...THEIRS].forEach((h) => ban(d, h));
  const order = [];
  const pool = db.all.map((h) => h.id);
  while (!d.status().complete) {
    const s = d.status();
    const id = pool.find((h) => d.canAct(h).ok);
    assert.ok(d.act(id));
    const p = d.picks(s.side).find((x) => x.hero === id);
    order.push(`${s.side === 'blue' ? 'Blue' : 'Red'} ${p.order}`);
  }
  assert.deepEqual(order, ['Blue 1', 'Red 1', 'Red 2', 'Blue 2', 'Blue 3', 'Red 3', 'Red 4', 'Blue 4', 'Blue 5', 'Red 5']);
});

test('Test E — once picks begin, Ranked never returns to a ban phase', () => {
  const d = ranked();
  [...OUR, ...THEIRS].forEach((h) => ban(d, h));
  for (let i = 0; i < 10; i++) {
    const s = d.status();
    assert.notEqual(s.actionType, 'ban', `step ${i + 1} is a pick`);
    d.act(db.all.map((h) => h.id).find((h) => d.canAct(h).ok));
  }
  assert.equal(d.status().phase, 'complete');
  assert.equal(d.canNoBan().ok, false, 'no ban slot exists after the ban phase');
});

test('Your real game reproduces exactly (Freya · Atlas · No ban …), then picks', () => {
  const d = ranked();
  ['freya', 'atlas', null, 'fanny', 'marcel'].forEach((h) => ban(d, h));
  ['freya', 'paquito', 'uranus', 'suyou', 'saber'].forEach((h) => ban(d, h));
  assert.deepEqual(d.state.bans.blue, ['freya', 'atlas', null, 'fanny', 'marcel']);
  assert.deepEqual(d.status().doubleBans, ['freya']);
  assert.ok(d.act('hirara')); assert.equal(d.state.picks.blue.jungle, 'hirara');
  assert.equal(d.canAct('paquito').ok, false);
});

test('Duplicate within the blind phase allowed; a side cannot ban the same hero twice', () => {
  const d = ranked();
  OUR.forEach((h) => ban(d, h));
  ban(d, 'atlas');
  assert.equal(d.canAct('atlas').ok, false, 'red already banned Atlas');
});

test('Brackets: Mythic 5 · Legend 4 · Epic 3, always one ban phase', () => {
  const d = ranked();
  for (const [b, n] of [['legend', 4], ['epic', 3], ['mythic', 5]]) {
    assert.ok(d.setBracket(b).ok); assert.equal(d.format.bansPerSide, n);
    const steps = d.format.steps;
    const lastBan = Math.max(...steps.filter((x) => x.type === 'ban').map((x) => x.index));
    assert.ok(steps.filter((x) => x.type === 'pick').every((x) => x.index > lastBan), `${b}: all bans before picks`);
  }
});

console.log('\nTournament / MPL regression');

test('Test F — Tournament still runs 3 bans → picks → 2 bans → final picks (sequential, unique, no No ban)', () => {
  const f = formats.MPL_PH_S18;
  assert.equal(f.banPhaseCount, 2); assert.equal(f.firstBanPerSide, 3); assert.equal(f.secondBanPerSide, 2);
  assert.equal(f.blindBans, false); assert.equal(f.secondBanPhase, true);
  assert.equal(f.steps.map((s) => (s.type === 'ban' ? 'B' : 'P') + s.side[0]).join(' '),
    'Bb Br Bb Br Bb Br Pb Pr Pr Pb Pb Pr Br Bb Br Bb Pr Pb Pb Pr');
  const d = makeDraft('MPL_PH_S18');
  assert.ok(d.act('freya'));
  assert.equal(d.canAct('freya').ok, false, 'no duplicate bans');
  assert.equal(d.noBan(), false, 'no No ban');
});

test('Free Draft unchanged: No ban, removal and undo allowed', () => {
  const d = makeDraft('FREE');
  assert.ok(d.noBan()); assert.ok(d.act('freya'));
  assert.ok(d.remove('blue', 'ban', 0)); assert.ok(d.undo());
});

console.log(failures ? `\n${failures} test(s) failed` : '\nAll ranked-ban tests passed');
process.exitCode = failures ? 1 : 0;
