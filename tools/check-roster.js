// Hero roster reconciliation: compares the CURRENT MLBB roster with data/heroes.json.
//
//   node tools/check-roster.js            # report
//   node tools/check-roster.js --json     # machine-readable report
//   node tools/check-roster.js --snapshot # also store the roster in data/roster.json (used by tests)
//
// Source: the Mobile Legends Fandom wiki (MediaWiki API, Category:Heroes), with
// data/roster.json → "exclude" for category members that are not playable heroes and
// "aliases" for name differences. The hero roster is independent of any meta dataset:
// a hero exists here whether or not it appeared in MPL PH S18.

import { readFileSync, existsSync } from 'node:fs';
import { createHeroDatabase } from '../src/heroDatabase.js';

const API = 'https://mobile-legends.fandom.com/api.php';
const UA = 'MLDraftLab-roster-check/0.1 (personal draft tool)';
const read = (p) => JSON.parse(readFileSync(new URL(`../${p}`, import.meta.url)));
const norm = (s) => s.toLowerCase().replace(/[^a-z0-9]/g, '');

export async function fetchRoster() {
  const cfg = existsSync(new URL('../data/roster.json', import.meta.url)) ? read('data/roster.json') : { exclude: [], aliases: {} };
  const titles = [];
  let cont = null;
  do {
    const q = new URLSearchParams({ action: 'query', list: 'categorymembers', cmtitle: 'Category:Heroes', cmnamespace: '0', cmlimit: '500', format: 'json', ...(cont ? { cmcontinue: cont } : {}) });
    const res = await fetch(`${API}?${q}`, { headers: { 'User-Agent': UA } });
    if (!res.ok) throw new Error(`wiki API ${res.status}`);
    const d = await res.json();
    titles.push(...d.query.categorymembers.map((m) => m.title));
    cont = d.continue?.cmcontinue || null;
  } while (cont);
  // exact page titles: normalizing would make "S.A.B.E.R." (a faction page) also exclude "Saber"
  const excluded = new Set(cfg.exclude || []);
  return { titles: titles.filter((t) => !excluded.has(t) && !t.includes('/')), cfg };
}

export function reconcile(rosterTitles, db, cfg = {}) {
  const alias = Object.fromEntries(Object.entries(cfg.aliases || {}).map(([k, v]) => [norm(k), v]));
  const dbKeys = new Map();
  for (const h of db.all) { dbKeys.set(norm(h.name), h.id); dbKeys.set(h.id, h.id); }
  const missing = [];
  const matched = new Set();
  for (const t of rosterTitles) {
    const id = alias[norm(t)] || dbKeys.get(norm(t));
    if (id && db.get(id)) matched.add(id); else missing.push(t);
  }
  const extra = db.all.filter((h) => !matched.has(h.id)).map((h) => h.name);
  return { roster: rosterTitles.length, database: db.all.length, missing, extra };
}

if (import.meta.url === `file:///${process.argv[1].replace(/\\/g, '/')}` || process.argv[1]?.endsWith('check-roster.js')) {
  const db = createHeroDatabase(read('data/heroes.json'));
  const { titles, cfg } = await fetchRoster();
  const r = reconcile(titles, db, cfg);
  if (process.argv.includes('--snapshot')) {
    // store the roster offline so tests don't depend on the network
    const { writeFileSync } = await import('node:fs');
    const path = new URL('../data/roster.json', import.meta.url);
    const json = read('data/roster.json');
    json.snapshot = { takenAt: new Date().toISOString().slice(0, 10), titles: [...titles].sort() };
    writeFileSync(path, `${JSON.stringify(json, null, 2)}\n`);
    console.log(`snapshot: ${titles.length} heroes`);
  }
  if (process.argv.includes('--json')) console.log(JSON.stringify(r, null, 2));
  else {
    console.log(`Current roster: ${r.roster}\nDatabase heroes: ${r.database}\nMissing: ${r.missing.length}`);
    if (r.missing.length) console.log(`\nMissing heroes:\n${r.missing.map((m) => `- ${m}`).join('\n')}`);
    if (r.extra.length) console.log(`\nIn database but not matched to the roster (check names/aliases):\n${r.extra.map((m) => `- ${m}`).join('\n')}`);
  }
}
