// Import a verified hero-stat table into a meta dataset file.
//
//   node tools/import-hero-stats.js <stats.csv> --drafts 172 --source "MPL PH Season 18 (Liquipedia, <date>)" [--id mpl-ph-s18]
//
// CSV header (case-insensitive, any order): Hero, Picks, Bans, Wins, Losses, WinRate, Presence
// Required: Hero, Picks, Bans, and Wins or Losses. WinRate/Presence, if given, are
// cross-checked against the counts (as 55.2, 55.2% or 0.552). Nothing is estimated:
// the only derived values are exact identities (losses = picks - wins, rates from counts).
// The import fails on unknown hero names or inconsistent numbers, and lists every problem.

import { readFileSync, writeFileSync } from 'node:fs';
import { createHeroDatabase } from '../src/heroDatabase.js';

const args = process.argv.slice(2);
const opt = (name, def) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : def; };
const csvPath = args.find((a, i) => !a.startsWith('--') && !args[i - 1]?.startsWith('--'));
const drafts = Number(opt('drafts'));
const source = opt('source');
const id = opt('id', 'mpl-ph-s18');
if (!csvPath || !drafts || !source) {
  console.error('usage: node tools/import-hero-stats.js <stats.csv> --drafts 172 --source "..." [--id mpl-ph-s18]');
  process.exit(2);
}

const db = createHeroDatabase(JSON.parse(readFileSync(new URL('../data/heroes.json', import.meta.url))));
const norm = (s) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
const byKey = new Map();
for (const h of db.all) for (const k of h.keys) byKey.set(k, h);

function parseCsv(text) {
  const rows = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const cells = [];
    let cur = '', q = false;
    for (const ch of line) {
      if (ch === '"') q = !q;
      else if ((ch === ',' || ch === '\t') && !q) { cells.push(cur.trim()); cur = ''; }
      else cur += ch;
    }
    cells.push(cur.trim());
    rows.push(cells);
  }
  return rows;
}
const rate = (s) => {
  if (s == null || s === '') return null;
  const n = parseFloat(String(s).replace('%', ''));
  if (Number.isNaN(n)) return NaN;
  return String(s).includes('%') || n > 1 ? n / 100 : n;
};
const int = (s) => (s == null || s === '' ? null : /^\d+$/.test(s) ? Number(s) : NaN);

const [header, ...body] = parseCsv(readFileSync(csvPath, 'utf8'));
const col = Object.fromEntries(header.map((h, i) => [norm(h), i]));
const need = ['hero', 'picks', 'bans'];
for (const c of need) if (!(c in col)) { console.error(`missing column: ${c}`); process.exit(1); }
if (!('wins' in col) && !('losses' in col)) { console.error('need a Wins or Losses column'); process.exit(1); }
const cell = (r, c) => (c in col ? r[col[c]] : undefined);

const problems = [];
const out = [];
const seen = new Set();
const TOL = 0.006; // 0.6 percentage points (source rounding)

for (const r of body) {
  const name = cell(r, 'hero');
  const h = byKey.get(norm(name || ''));
  const where = `"${name}"`;
  if (!h) { problems.push(`${where}: not in data/heroes.json (add the hero or an alias)`); continue; }
  if (seen.has(h.id)) { problems.push(`${where}: duplicate row`); continue; }
  seen.add(h.id);
  const picks = int(cell(r, 'picks'));
  const bans = int(cell(r, 'bans'));
  let wins = int(cell(r, 'wins'));
  let losses = int(cell(r, 'losses'));
  for (const [k, v] of Object.entries({ picks, bans, wins, losses })) if (Number.isNaN(v)) problems.push(`${where}: ${k} is not a whole number`);
  if (picks == null || bans == null || Number.isNaN(picks) || Number.isNaN(bans)) continue;
  if (wins == null && losses != null) wins = picks - losses;
  if (losses == null && wins != null) losses = picks - wins;
  if (wins + losses !== picks) problems.push(`${where}: wins ${wins} + losses ${losses} ≠ picks ${picks}`);
  if (picks > drafts || bans > drafts || picks + bans > drafts) problems.push(`${where}: picks+bans ${picks + bans} exceeds ${drafts} drafts`);
  const winRate = picks ? wins / picks : null;
  const presence = (picks + bans) / drafts;
  const srcWr = rate(cell(r, 'winrate'));
  const srcPr = rate(cell(r, 'presence'));
  if (Number.isNaN(srcWr) || Number.isNaN(srcPr)) problems.push(`${where}: unreadable WinRate/Presence`);
  if (srcWr != null && winRate != null && Math.abs(srcWr - winRate) > TOL) problems.push(`${where}: source win rate ${(srcWr * 100).toFixed(1)}% ≠ ${wins}/${picks} = ${(winRate * 100).toFixed(1)}%`);
  if (srcPr != null && Math.abs(srcPr - presence) > TOL) problems.push(`${where}: source presence ${(srcPr * 100).toFixed(1)}% ≠ (${picks}+${bans})/${drafts} = ${(presence * 100).toFixed(1)}%`);
  out.push({ id: h.id, hero: h.name, picks, bans, wins, losses, winRate: winRate == null ? null : +winRate.toFixed(4), presence: +presence.toFixed(4) });
}

const totalPicks = out.reduce((s, x) => s + x.picks, 0);
const totalBans = out.reduce((s, x) => s + x.bans, 0);
const totalWins = out.reduce((s, x) => s + x.wins, 0);
if (totalPicks > drafts * 10) problems.push(`total picks ${totalPicks} exceeds ${drafts} × 10`);
if (totalBans > drafts * 10) problems.push(`total bans ${totalBans} exceeds ${drafts} × 10`);

console.log(`rows: ${out.length} heroes | picks ${totalPicks} (expected ${drafts * 10}) | bans ${totalBans} (max ${drafts * 10}) | wins ${totalWins} (expected ${drafts * 5})`);
if (totalPicks !== drafts * 10) console.log(`  note: total picks ≠ ${drafts * 10}; table may be partial or the draft count may differ`);
if (problems.length) {
  console.error(`\n${problems.length} problem(s) — nothing written:\n  ${problems.join('\n  ')}`);
  process.exit(1);
}

const complete = totalPicks === drafts * 10 && totalWins * 2 === totalPicks;
out.sort((a, b) => b.presence - a.presence || a.hero.localeCompare(b.hero));
const file = new URL(`../data/meta/${id}.json`, import.meta.url);
writeFileSync(file, JSON.stringify({
  id, source, status: complete ? 'verified' : 'verified-partial', importedAt: new Date().toISOString().slice(0, 10), drafts,
  fields: 'winRate = wins / picks; presence = (picks + bans) / drafts',
  coverage: {
    heroRows: out.length, totalPicks, expectedPicks: drafts * 10, totalBans, maxBans: drafts * 10, totalWins, totalLosses: totalPicks - totalWins,
    complete,
    note: complete ? 'Totals are consistent with the draft count.' : 'Per-hero rows check out, but the totals do not account for every draft. Rows may be missing from the source table. Missing heroes count as 0 presence; nothing was estimated.',
  },
  heroes: out,
}, null, 2) + '\n');
console.log(`wrote data/meta/${id}.json`);
