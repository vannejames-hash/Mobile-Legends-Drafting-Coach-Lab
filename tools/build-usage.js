// Builds data/meta/<id>-usage.json: OBSERVED competitive usage for a dataset,
// kept separate from official hero identity in data/heroes.json.
//
//   node tools/build-usage.js [--id mpl-ph-s18]
//
// Lane usage is recorded only from evidence. Without a game-by-game draft log that
// carries a role per pick, no hero's competitive lane is filled in. Heroes that were
// played and have more than one lane are flagged so the next dataset can verify them.

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { createHeroDatabase } from '../src/heroDatabase.js';
import { createDraftLog } from '../src/draftLog.js';

const args = process.argv.slice(2);
const id = args.includes('--id') ? args[args.indexOf('--id') + 1] : 'mpl-ph-s18';
const read = (p) => JSON.parse(readFileSync(new URL(`../${p}`, import.meta.url)));
const db = createHeroDatabase(read('data/heroes.json'));
const stats = read(`data/meta/${id}.json`);
const logPath = `data/drafts/${id}.json`;
const log = createDraftLog(existsSync(new URL(`../${logPath}`, import.meta.url)) ? read(logPath) : null);
const laneEvidence = log.laneUsage(); // Map heroId -> { lane: count } (empty without role data)

const heroes = {};
const flagged = [];
for (const row of stats.heroes) {
  const h = db.get(row.id);
  const lanes = laneEvidence.get(row.id) || null;
  const entry = { picks: row.picks, observedLanes: lanes, laneStatus: lanes ? 'observed' : 'unverified' };
  if (!lanes && row.picks > 0 && h.lanes.length > 1) {
    entry.verify = `Lane split unknown: official lanes ${h.lanes.join(' / ')}; needs draft-slot data`;
    flagged.push(row.id);
  }
  heroes[row.id] = entry;
}

const out = {
  id: `${id}-usage`,
  dataset: id,
  about: 'Observed competitive usage only. Official hero identity lives in data/heroes.json. observedLanes stays null until the game-by-game draft log provides a role for each pick.',
  laneEvidence: laneEvidence.size ? `draft log (${log.games.length} games)` : 'none: hero-stat table has no draft-slot data',
  flaggedForVerification: flagged,
  heroes,
};
writeFileSync(new URL(`../data/meta/${id}-usage.json`, import.meta.url), JSON.stringify(out, null, 2) + '\n');
console.log(`wrote data/meta/${id}-usage.json | ${Object.keys(heroes).length} heroes | flagged ${flagged.length}: ${flagged.join(', ')}`);
