// Verify a draft format against a real match.
//
//   node tools/verify-format.js                                  # check stored target(s)
//   node tools/verify-format.js --target S18-GF-FLCN-RORA-G1 --format MPL_PH_S18
//   node tools/verify-format.js --sequence "Bb:esmeralda Br:masha Bb:kalea ..." [--ban-timer 30 --pick-timer 30]
//
// Sequence tokens: <B|P><b|r>:<hero>, e.g. "Bb:Esmeralda" = blue ban, "Pr:Suyou" = red pick,
// in chronological order. Hero names or ids both work. A sequence can also be stored in
// data/drafts/<dataset>.json → verificationTargets[].orderedSequence.
//
// The tool only REPORTS. It never edits data/draft-formats.json; it prints the phase
// order that the evidence implies so a change can be made deliberately.

import { readFileSync } from 'node:fs';
import { createHeroDatabase } from '../src/heroDatabase.js';
import { compileFormats } from '../src/draftState.js';

const argv = process.argv.slice(2);
const opt = (k) => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1] : null; };
const read = (p) => JSON.parse(readFileSync(new URL(`../${p}`, import.meta.url), 'utf8'));
const db = createHeroDatabase(read('data/heroes.json'));
const { formats, defaultId } = compileFormats(read('data/draft-formats.json'));
const formatId = opt('format') || defaultId;
const fmt = formats[formatId];
if (!fmt) { console.error(`unknown format ${formatId}`); process.exit(2); }
const log = read('data/drafts/mpl-ph-s18.json');
const targets = log.verificationTargets || [];
const target = opt('target') ? targets.find((t) => t.id === opt('target')) : targets[0];
if (!target) { console.error('no verification target found'); process.exit(2); }

const resolve = (name) => db.get(name) ? name : db.search(name)[0]?.id;
const name = (id) => db.get(id)?.name || id;
let problems = 0;
const bad = (msg) => { problems++; console.log(`  ✗ ${msg}`); };
const ok = (msg) => console.log(`  ✓ ${msg}`);

console.log(`Format ${formatId} (${fmt.label}) vs ${target.id}: ${target.label}, ${target.date}`);
console.log(`  ${target.blue.team} (blue) vs ${target.red.team} (red), winner ${target.winner}\n`);

// ---------------------------------------------------------------- 1. sets
console.log('1. Final pick/ban sets');
const all = [];
for (const side of ['blue', 'red']) {
  for (const type of ['picks', 'bans']) {
    const ids = target[side][type];
    const expected = type === 'picks' ? fmt.picksPerSide : fmt.bansPerSide;
    const unknown = ids.filter((id) => !db.get(id));
    if (unknown.length) bad(`${side} ${type}: unknown hero id(s) ${unknown.join(', ')}`);
    if (ids.length !== expected) bad(`${side} has ${ids.length} ${type}, format expects ${expected}`);
    else ok(`${side} ${type}: ${ids.length} (${ids.map(name).join(', ')})`);
    all.push(...ids);
  }
}
const dupes = all.filter((id, i) => all.indexOf(id) !== i);
if (dupes.length) bad(`duplicate heroes: ${dupes.join(', ')}`); else ok(`${all.length} distinct heroes, no duplicates`);

// ---------------------------------------------------------------- 2. order
console.log('\n2. Chronological action order');
let seq = target.orderedSequence;
if (opt('sequence')) {
  seq = opt('sequence').trim().split(/\s+/).map((tok) => {
    const m = tok.match(/^([BbPp])([bBrR]):(.+)$/);
    if (!m) throw new Error(`bad token "${tok}" (expected e.g. Bb:Esmeralda)`);
    return { type: m[1].toUpperCase() === 'B' ? 'ban' : 'pick', side: m[2].toLowerCase() === 'b' ? 'blue' : 'red', hero: resolve(m[3].replace(/_/g, ' ')) || m[3] };
  });
}
if (!seq) {
  console.log('  – not provided. The sets above do not establish order; supply a draft-screen screenshot or game log.');
} else {
  if (seq.length !== fmt.steps.length) bad(`sequence has ${seq.length} actions, format has ${fmt.steps.length}`);
  let matches = 0;
  const rows = fmt.steps.map((st, i) => {
    const a = seq[i];
    const same = a && a.type === st.type && a.side === st.side;
    if (same) matches++;
    const inSet = a && target[a.side][a.type === 'ban' ? 'bans' : 'picks'].includes(a.hero);
    return `  ${String(i + 1).padStart(2)}. expected ${st.type.padEnd(4)} ${st.side.padEnd(4)} | actual ${a ? `${a.type.padEnd(4)} ${a.side.padEnd(4)} ${name(a.hero).padEnd(12)}` : '(missing)'.padEnd(22)} ${same ? '✓' : '✗'}${a && !inSet ? '  (hero not in that side’s final set)' : ''}`;
  });
  console.log(rows.join('\n'));
  const setMismatch = seq.filter((a) => !target[a.side][a.type === 'ban' ? 'bans' : 'picks'].includes(a.hero));
  if (setMismatch.length) bad(`${setMismatch.length} action(s) disagree with the confirmed final sets`);
  if (matches === fmt.steps.length && seq.length === fmt.steps.length) ok(`order matches ${formatId} at all ${matches} steps`);
  else {
    bad(`order matches at ${matches}/${fmt.steps.length} steps`);
    // phase order implied by the evidence (contiguous runs of the same action type)
    const phases = [];
    for (const a of seq) {
      const last = phases[phases.length - 1];
      if (last && last.type === a.type) last.order.push(a.side[0]); else phases.push({ type: a.type, order: [a.side[0]] });
    }
    console.log('\n  Phase order implied by this game (review before editing data/draft-formats.json):');
    phases.forEach((p, i) => console.log(`    ${i + 1}. ${p.type.padEnd(4)} "${p.order.join(' ')}"`));
  }
}

// ---------------------------------------------------------------- 3. timers
console.log('\n3. Timers');
const t = { ban: Number(opt('ban-timer')) || target.timers?.ban, pick: Number(opt('pick-timer')) || target.timers?.pick };
if (!t.ban && !t.pick) console.log('  – not provided (preset values remain placeholders).');
for (const type of ['ban', 'pick']) {
  if (!t[type]) continue;
  const preset = [...new Set(fmt.phases.filter((p) => p.type === type).map((p) => p.timer))];
  if (preset.length === 1 && preset[0] === t[type]) ok(`${type} timer ${t[type]}s matches`);
  else bad(`${type} timer: evidence ${t[type]}s, preset ${preset.join('/')}s`);
}

console.log(`\nVerdict: ${problems ? `${problems} discrepancy(ies)` : 'no discrepancies'}; ${seq ? 'order checked' : 'order NOT verified (needs screenshot/log)'}; ${t.ban || t.pick ? 'timers checked' : 'timers NOT verified'}.`);
console.log('This tool never edits the format; update data/draft-formats.json only from proven differences.');
process.exitCode = problems ? 1 : 0;
