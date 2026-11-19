// Headless smoke test for the draft engines: node tests/engine.test.js
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { createHeroDatabase } from '../src/heroDatabase.js';
import { createMetaData } from '../src/metaData.js';
import { createPlayerProfile } from '../src/playerProfile.js';
import { createDraftState } from '../src/draftState.js';
import { analyzeDraft, postDraftReport } from '../src/compositionEngine.js';
import { createRecommendationEngine } from '../src/recommendationEngine.js';
import { createDraftLog, validateGame } from '../src/draftLog.js';
import { makeDraft } from './helpers.js';

const db = createHeroDatabase(JSON.parse(readFileSync(new URL('../data/heroes.json', import.meta.url))));
const manifest = JSON.parse(readFileSync(new URL('../data/meta/index.json', import.meta.url)));
const ds = manifest.datasets[manifest.active];
const meta = createMetaData(JSON.parse(readFileSync(new URL('../' + ds.heroStats, import.meta.url))), ds);
console.log('meta:', meta.source, '| status:', meta.status, '| heroes with data:', meta.hasData);
const profile = createPlayerProfile();
const draft = makeDraft('MPL_PH_S18');
const engine = createRecommendationEngine({ db, meta, profile });

assert.equal(db.search('Suy')[0].id, 'suyou');
assert.equal(db.search('yss')[0].id, 'yisunshin');

const show = (label) => {
  const step = draft.currentStep();
  const r = engine.forStep(draft, step);
  const top = (list) => list.slice(0, 4).map((x) => `${x.hero.name} ${x.score} [${x.tag}] ${x.reasons[0]}`).join(' | ');
  console.log(`\n${label} -> ${step.label} ${step.side}`);
  console.log('  theoretical:', top(r.theoretical));
  if (r.forYou.length) console.log('  for you:    ', top(r.forYou));
  const a = r.analysis.ally;
  console.log('  comp:', a.compLabel, '| needs:', a.needs.filter((n) => n.pressure >= 0.3).map((n) => `${n.short}:${n.pressure.toFixed(2)}`).join(', '));
};

for (const id of ['suyou', 'fredrinn', 'valentina', 'arlott', 'yuzhong', 'joy']) { show('ban'); assert.ok(draft.act(id)); }
assert.equal(draft.act('suyou'), false, 'duplicate prevented');
show('pick1');
draft.act('tigreal');           // blue roam
draft.act('ling'); draft.act('pharsa'); // red
show('blue pick 2');
draft.act('lapulapu'); draft.act('claude');
draft.act('khufra');            // red pick 3
for (const id of ['chou', 'grock', 'atlas', 'zhuxin']) draft.act(id); // bans phase 2
show('red pick 4');
draft.act('esmeralda');
show('blue pick 4');
draft.act('saber'); draft.act('yve'); draft.act('brody');
assert.ok(draft.isComplete(), 'draft complete');
console.log('\nblue:', draft.team('blue').map((m) => `${m.role}:${m.id}`).join(' '));
console.log('red: ', draft.team('red').map((m) => `${m.role}:${m.id}`).join(' '));
const A = analyzeDraft(engine.members(draft, 'blue'), engine.members(draft, 'red'), db);
console.log(JSON.stringify(postDraftReport(A), null, 1));
draft.undo();
assert.ok(!draft.isComplete());
// --- v0.2 hero schema rules
const lukas = db.get('lukas');
assert.equal(lukas.primaryLane, 'exp');
assert.ok(lukas.laneWeights.jungle < 1, 'Lukas jungle is a lower-weight flex lane');
assert.equal(db.get('marcel').cls.includes('Tank'), false, 'Marcel is not labelled Tank');
assert.equal(db.get('hirara').a.en, 0, 'Hirara is not an engage hero');
assert.equal(db.get('sora').forms.length, 2);

// Sora: the form chosen depends on what the comp needs.
const formFor = (allyIds, enemyIds) => {
  const d = makeDraft('FREE');
  allyIds.forEach(([id, key]) => { d.setTarget({ side: 'blue', type: 'pick', key }); d.act(id); });
  enemyIds.forEach((id) => { d.setTarget({ side: 'red', type: 'pick' }); d.act(id); });
  return engine.scorePicks(d, 'blue').find((r) => r.hero.id === 'sora')?.form?.id;
};
const needsEngage = formFor([['hirara', 'jungle'], ['zetian', 'mid'], ['obsidia', 'gold']], ['ling', 'pharsa']);   // no starter
const needsDamage = formFor([['atlas', 'roam'], ['barats', 'jungle'], ['faramis', 'mid']], ['ling', 'pharsa']);    // tanky, low damage
console.log('Sora form | squishy comp ->', needsEngage, '| tank comp ->', needsDamage);
assert.equal(needsEngage, 'torrent');
assert.equal(needsDamage, 'thunder');

// Lukas: recommended at EXP when open; only as a lower-scored flex option at Jungle.
{
  const d = makeDraft('FREE');
  d.setTarget({ side: 'blue', type: 'pick', key: 'exp' }); d.act('freya');
  const r = engine.scorePicks(d, 'blue').find((x) => x.hero.id === 'lukas');
  assert.equal(r.role, 'jungle');
  assert.ok(r.scores.roleFit < 1);
  assert.ok(r.reasons.some((x) => x.includes('flex lane')));
}

// Draft log: lane usage only from picks that carry a role.
const g = {
  id: 'G1', winner: 'blue',
  blue: { team: 'A', picks: [{ hero: 'lukas', role: 'jungle' }, { hero: 'freya', role: 'exp' }, { hero: 'zetian', role: 'mid' }, { hero: 'obsidia', role: 'gold' }, { hero: 'marcel', role: 'roam' }], bans: ['atlas'] },
  red: { team: 'B', picks: ['hirara', 'sora', 'yve', 'claude', 'kalea'], bans: ['paquito'] },
};
assert.deepEqual(validateGame(g, new Set(db.all.map((h) => h.id))), []);
const lu = createDraftLog({ games: [g] }).laneUsage();
assert.deepEqual(lu.get('lukas'), { jungle: 1 });
assert.equal(lu.get('sora'), undefined, 'no role given -> no lane evidence');

// --- Live draft flow: BAN → BAN → BAN → PICK → PICK → BAN → PICK, reversible log, undo, reset
{
  const d = makeDraft('FREE');
  const seq = [['ban', 'blue', 'freya'], ['ban', 'red', 'atlas'], ['ban', 'blue', 'paquito'],
    ['pick', 'blue', 'suyou'], ['pick', 'red', 'hirara'], ['ban', 'red', 'marcel'], ['pick', 'blue', 'carmilla']];
  for (const [type, side, id] of seq) {
    const t = d.previewTarget(id);
    d.setTarget({ side, type });
    assert.ok(d.act(id), `${type} ${id}`);
    assert.equal(d.act(id), false, `${id} cannot be used twice`);
    void t;
  }
  assert.deepEqual(d.state.bans.blue, ['freya', 'paquito']);
  assert.deepEqual(d.state.bans.red, ['atlas', 'marcel']);
  assert.equal(d.state.picks.blue.jungle, 'suyou');
  assert.equal(d.state.picks.blue.roam, 'carmilla');
  assert.equal(d.state.picks.red.jungle, 'hirara');
  assert.deepEqual(d.log().map((a) => `${a.kind}:${a.heroId}`), seq.map(([t, , id]) => `${t}:${id}`));
  const before = JSON.stringify(d.state);
  d.setTarget({ side: 'red', type: 'pick' }); d.act('valentina');
  d.undo();
  assert.equal(JSON.stringify({ ...d.state, target: null }), JSON.stringify({ ...JSON.parse(before), target: null }), 'undo restores exact previous state');
  assert.equal(d.lastAction().heroId, 'carmilla');
  // preview: next ban for red goes to index 2; Lukas would land in EXP
  d.setTarget(null);
  assert.equal(d.previewTarget('freya'), null, 'used hero has no target');
  d.reset();
  assert.equal(d.team('blue').length + d.team('red').length + d.state.bans.blue.length + d.state.bans.red.length, 0, 'reset clears the draft');
  assert.equal(d.canUndo(), false, 'start over clears history too');
  assert.equal(d.status().phaseIndex, 0, 'back to the first phase');
}

console.log('\nOK');
