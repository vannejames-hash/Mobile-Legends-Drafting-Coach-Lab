// Post-draft analysis must CHANGE with the draft (evidence-first, not templated).
//   node tests/draft-analysis.test.js
import assert from 'node:assert/strict';
import { db, meta, makeDraft, makeProfile, setup } from './helpers.js';
import { analyzeCompletedDraft } from '../src/draftAnalysis.js';
import { createRecommendationEngine } from '../src/recommendationEngine.js';

let failures = 0;
const test = (name, fn) => {
  try { fn(); console.log(`  ✓ ${name}`); } catch (e) { failures++; console.log(`  ✗ ${name}\n      ${e.message.split('\n')[0]}`); }
};
const team = (o) => Object.entries(o).map(([role, id]) => ({ role, hero: db.get(id) }));
const run = (ally, enemy, me = null) => analyzeCompletedDraft({ db, ally: team(ally), enemy: team(enemy), myRole: me?.[0], myHero: me?.[1] });
const all = (r) => JSON.stringify([r.clash, r.win, r.strengths, r.weaknesses, r.compensate, r.power.implication, r.objectives]).toLowerCase();

// fixtures
const PICK_US = { jungle: 'saber', roam: 'tigreal', mid: 'eudora', exp: 'paquito', gold: 'brody' };
const SOFT_BACKLINE = { gold: 'layla', mid: 'cecilion', roam: 'estes', exp: 'aulus', jungle: 'balmond' };
const SABER_NO_FRONT = { jungle: 'saber', roam: 'diggie', mid: 'vexana', exp: 'sun', gold: 'miya' };
const HEAVY_DIVE = { jungle: 'ling', exp: 'yuzhong', mid: 'gusion', roam: 'chou', gold: 'claude' };
const PROTECT = { roam: 'floryn', mid: 'valir', gold: 'melissa', exp: 'ruby', jungle: 'fredrinn' };
const PICK_THEM = { jungle: 'lancelot', mid: 'kagura', roam: 'franco', exp: 'paquito', gold: 'brody' };
const POKE = { mid: 'xavier', gold: 'layla', roam: 'lolita', exp: 'bane', jungle: 'yisunshin' };
const ENGAGE = { roam: 'atlas', exp: 'lapulapu', jungle: 'barats', mid: 'luoyi', gold: 'brody' };
const SCALE = { gold: 'miya', mid: 'lunox', exp: 'esmeralda', jungle: 'hanzo', roam: 'estes' };
const EARLY = { jungle: 'balmond', exp: 'paquito', mid: 'eudora', gold: 'brody', roam: 'franco' };

console.log('\nDraft analysis (post-draft report)');

test('A — Saber + Tigreal + burst vs a vulnerable backline → pickoff-focused analysis', () => {
  const r = run(PICK_US, SOFT_BACKLINE, ['jungle', 'saber']);
  console.log(`      ${r.identity.ally.primary} · ${r.clash.decider}\n      first target: ${r.targets.first.hero.name} · Saber: ${r.personal.function} — ${r.personal.job}`);
  assert.equal(r.identity.ally.primaryId, 'pickoff');
  assert.match(r.win.primary.text, /Catch/);
  assert.ok(['layla', 'cecilion'].includes(r.targets.first.hero.id), 'first target is the soft, immobile backline');
  assert.ok(['backline-removal', 'pickoff', 'initiator'].includes(r.personal.functionId));
  assert.ok(r.strengths.some((s) => /pickoff|burst/i.test(s.text)));
  assert.ok(r.verdict.evidence.length && r.clash.evidence.length && r.win.primary.evidence.length, 'conclusions carry evidence');
});

test('B — Saber + weak frontline vs heavy dive → lacks frontline / protection', () => {
  const r = run(SABER_NO_FRONT, HEAVY_DIVE, ['jungle', 'saber']);
  console.log(`      weaknesses: ${r.weaknesses.map((w) => w.text).join(' · ')}\n      ${r.clash.decider}`);
  assert.ok(r.weaknesses.some((w) => /frontline|dive|peel|protection/i.test(w.text)));
  assert.equal(r.clash.id, 'protect-backline');
  assert.match(r.win.enemy.text, /Ling|Gusion|Chou/);
  assert.match(r.counterfactual.lead, /frontline|initiation|dive|peel/);
});

test('C — Protect / UBE composition → protection, formation and sustained teamfight are central', () => {
  const r = run(PROTECT, PICK_THEM);
  console.log(`      ${r.identity.ally.primary} · ${r.win.primary.text}\n      points: ${r.clash.points.join(' / ')}`);
  assert.equal(r.identity.ally.primaryId, 'protect');
  assert.match(r.win.primary.text, /extended fights|alive/);
  assert.ok(r.strengths.some((s) => /protection|peel/i.test(s.text)));
  assert.ok(r.clash.points.some((p) => /formation/i.test(p)) && r.clash.points.some((p) => /protection/i.test(p)));
});

test('D — Poke / Siege vs Engage → spacing, entry and objective setup', () => {
  const r = run(POKE, ENGAGE);
  const rev = run(ENGAGE, POKE);
  console.log(`      poke side: ${r.clash.decider}\n      engage side: ${rev.clash.decider}`);
  assert.equal(r.clash.id, 'spacing-vs-engage');
  assert.equal(rev.clash.id, 'entry-vs-poke');
  assert.ok(r.clash.points.some((p) => /spacing/i.test(p)));
  assert.ok(rev.clash.points.some((p) => /entry/i.test(p)));
  assert.ok(r.objectives.some((o) => o.name === 'Towers'), 'siege composition plays for towers');
});

test('E — Scaling vs early pressure → survive the early window, delay decisive fights', () => {
  const r = run(SCALE, EARLY);
  console.log(`      ${r.clash.decider}\n      ${r.power.implication.text}`);
  assert.equal(r.clash.id, 'survive-early');
  assert.match(r.power.implication.text, /preserve map stability|early fights/);
  assert.ok(r.clash.points.some((p) => /Survive their first power window/.test(p)));
  assert.equal(r.objectives[0].name, 'Lord');
  assert.equal(r.objectives.find((o) => o.name === 'Turtle').priority, 'Low');
});

test('F — same Saber, different teammates → Saber’s personal job changes', () => {
  const withEngage = run(PICK_US, SOFT_BACKLINE, ['jungle', 'saber']).personal;
  const noEngage = run(SABER_NO_FRONT, SOFT_BACKLINE, ['jungle', 'saber']).personal;
  console.log(`      with Tigreal: ${withEngage.function} — ${withEngage.job}\n      no engage:    ${noEngage.function} — ${noEngage.job}`);
  assert.notEqual(withEngage.functionId, noEngage.functionId);
  assert.notEqual(withEngage.job, noEngage.job);
  assert.ok(withEngage.enables.some((e) => /Tigreal/.test(e)), 'Tigreal enables Saber');
});

test('G — same enemy heroes, different allied composition → enemy threat analysis changes', () => {
  const a = run(PICK_US, HEAVY_DIVE);
  const b = run(PROTECT, HEAVY_DIVE);
  console.log(`      vs pickoff team: ${a.win.enemy.text}\n      vs protect team: ${b.win.enemy.text}`);
  assert.notEqual(a.win.enemy.text, b.win.enemy.text);
  assert.notEqual(a.clash.decider, b.clash.decider);
  assert.notDeepEqual(a.weaknesses.map((w) => w.id), b.weaknesses.map((w) => w.id));
});

test('H — different Gold picks against the same draft → rankings and role need change', () => {
  const engine = createRecommendationEngine({ db, meta, profile: makeProfile() });
  const base = { jungle: 'saber', roam: 'tigreal' };
  const red = { jungle: 'ling', exp: 'yuzhong', mid: 'gusion' };
  const d1 = setup(makeDraft('FREE'), { blue: { ...base, gold: 'claude' }, red });
  const d2 = setup(makeDraft('FREE'), { blue: { ...base, gold: 'layla' }, red });
  const b1 = engine.roleBoard(d1, 'blue', 'mid').board;
  const b2 = engine.roleBoard(d2, 'blue', 'mid').board;
  const t = (b) => b.entries.slice(0, 5).map((e) => `${e.hero.name} ${e.fit}`).join(', ');
  console.log(`      Mid after Claude: ${t(b1)}\n      Mid after Layla:  ${t(b2)}`);
  assert.notDeepEqual(b1.entries.slice(0, 5).map((e) => e.hero.id), b2.entries.slice(0, 5).map((e) => e.hero.id), 'Mid top 5 changes');
  const moved = b1.entries.filter((e) => Math.abs(e.fit - (b2.entries.find((x) => x.hero.id === e.hero.id)?.fit ?? e.fit)) >= 0.2);
  assert.ok(moved.length >= 2, 'several Mid heroes move');
  // and the finished-draft analysis of the two Gold choices differs too
  const r1 = run({ ...base, gold: 'claude', mid: 'pharsa', exp: 'yuzhong' }, { ...red, roam: 'atlas', gold: 'brody', exp: 'paquito' });
  const r2 = run({ ...base, gold: 'layla', mid: 'pharsa', exp: 'yuzhong' }, { ...red, roam: 'atlas', gold: 'brody', exp: 'paquito' });
  assert.notEqual(all(r1), all(r2));
});

test('No templated output: five different drafts produce five different key clashes and plans', () => {
  const rs = [run(PICK_US, SOFT_BACKLINE), run(SABER_NO_FRONT, HEAVY_DIVE), run(PROTECT, PICK_THEM), run(POKE, ENGAGE), run(SCALE, EARLY)];
  assert.equal(new Set(rs.map((r) => r.clash.decider)).size, 5);
  assert.equal(new Set(rs.map((r) => r.win.primary.text)).size, 5);
  assert.equal(new Set(rs.map((r) => r.win.failure.text)).size, 5);
  assert.equal(new Set(rs.map((r) => r.verdict.text)).size, 5);
  for (const r of rs) {
    assert.equal(r.roles.length, 5);
    for (const x of r.roles) assert.ok(x.function && x.job, `${x.hero.name} has a function and job`);
  }
});


console.log('\nCoaching lab signals + personal context');

test('L — different enemy archetypes produce different analysis for the same team', () => {
  const vs = [SOFT_BACKLINE, HEAVY_DIVE, ENGAGE].map((e) => run(PICK_US, e, ['jungle', 'saber']));
  console.log(`      ${vs.map((r) => `${r.identity.enemy.primary}: “${r.clash.question}” / threat ${r.plan.threat}`).join('\n      ')}`);
  assert.equal(new Set(vs.map((r) => r.identity.enemy.primaryId)).size, 3);
  assert.equal(new Set(vs.map((r) => r.win.enemy.text)).size, 3);
  assert.equal(new Set(vs.map((r) => r.plan.threat)).size, 3);
});

test('M — different allied archetypes produce different analysis against the same enemy', () => {
  const vs = [PICK_US, PROTECT, POKE, SCALE].map((a) => run(a, ENGAGE));
  assert.equal(new Set(vs.map((r) => r.identity.ally.primaryId)).size, 4);
  assert.equal(new Set(vs.map((r) => r.plan.win)).size, 4);
  assert.equal(new Set(vs.map((r) => r.clash.decisive)).size >= 3, true);
});

test('N — the power curve and window change with the draft', () => {
  const a = run(SCALE, EARLY);
  const b = run(EARLY, SCALE);
  console.log(`      scaling side: window ${a.window.ours} vs ${a.window.theirs} · early side: window ${b.window.ours} vs ${b.window.theirs}`);
  assert.equal(a.window.ours, b.window.theirs);
  assert.equal(a.window.theirs, b.window.ours);
  assert.ok(a.power.ally.late > a.power.enemy.late && a.power.ally.early < a.power.enemy.early);
  assert.notEqual(a.power.implication.text, b.power.implication.text);
});

test('O — target priorities change with the enemy draft', () => {
  const t = [SOFT_BACKLINE, HEAVY_DIVE, ENGAGE, PICK_THEM].map((e) => run(PICK_US, e).targets.first.hero.id);
  console.log(`      first targets: ${t.join(', ')}`);
  assert.ok(new Set(t).size >= 3);
});

test('P — the 30-second plan reflects the actual draft', () => {
  const r = run(PICK_US, SOFT_BACKLINE, ['jungle', 'saber']);
  const p = r.plan;
  console.log(`      win “${p.win}” · threat “${p.threat}” · job ${p.job.hero.name}: ${p.job.function} · target ${p.target.hero.name} · ${p.objective.name} · don't “${p.dont}”`);
  assert.equal(p.target.hero.id, r.targets.first.hero.id);
  assert.equal(p.objective.name, r.objectives[0].name);
  assert.equal(p.job.hero.id, 'saber');
  assert.equal(p.job.function, r.personal.function);
  for (const k of ['win', 'threat', 'dont']) assert.ok(p[k] && p[k].length <= 60, `${k} is a short signal, not prose`);
  const other = run(SCALE, EARLY, ['gold', 'miya']).plan;
  assert.notEqual(other.win, p.win); assert.notEqual(other.target.hero.id, p.target.hero.id); assert.notEqual(other.dont, p.dont);
});

test('Q — Deep Analysis has the full reasoning behind every conclusion', () => {
  const r = run(PICK_US, SOFT_BACKLINE, ['jungle', 'saber']);
  for (const [name, list] of [['verdict', r.verdict.evidence], ['clash', r.clash.evidence], ['win', r.win.primary.evidence], ['failure', r.win.failure.evidence], ['power', r.power.implication.evidence], ['targets', r.targets.evidence], ['personal', r.personal.evidence]]) {
    assert.ok(list.length >= 1, `${name} evidence`);
  }
  assert.ok(r.strengths.every((x) => x.evidence.length) && r.weaknesses.every((x) => x.evidence.length));
  assert.ok(r.roles.every((x) => x.evidence.length));
  assert.ok(Object.keys(r.analysis.ally.vector).length >= 14, 'composition vectors');
  assert.ok(r.interactions.length >= 1 && r.swings.length === 3);
});

test('H/I — auto-detected hero, and a manual choice that always wins', async () => {
  const { createPlayerContext } = await import('../src/playerContext.js');
  const { memoryStorage } = await import('../src/matchState.js');
  const me = createPlayerContext({ lanesOf: (id) => db.get(id)?.lanes, storage: memoryStorage() });
  me.setRole('jungle');
  const d = setup(makeDraft('FREE'), { blue: { jungle: 'suyou' } });
  me.sync(d);
  assert.equal(me.hero, 'suyou'); assert.equal(me.heroSource, 'auto');
  me.setHero('saber');
  me.sync(d);
  assert.equal(me.hero, 'saber'); assert.equal(me.heroSource, 'manual', 'manual overrides auto-detection');
  me.setRole('gold'); // a hero that cannot play the new role is cleared
  assert.equal(me.hero, null);
});
await new Promise((r) => setTimeout(r, 20));
if (failures) { console.log(`\n${failures} draft-analysis test(s) failed`); process.exit(1); }
console.log('\nAll draft-analysis tests passed');
