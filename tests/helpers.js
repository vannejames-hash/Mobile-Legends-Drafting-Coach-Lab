// Shared fixtures for the headless tests.
import { readFileSync } from 'node:fs';
import { createHeroDatabase } from '../src/heroDatabase.js';
import { createMetaData } from '../src/metaData.js';
import { createDraftState, compileFormats } from '../src/draftState.js';

const read = (p) => JSON.parse(readFileSync(new URL(`../${p}`, import.meta.url)));

export const db = createHeroDatabase(read('data/heroes.json'));
const manifest = read('data/meta/index.json');
const ds = manifest.datasets[manifest.active];
export const meta = createMetaData(read(ds.heroStats), ds);
export const { formats, defaultId } = compileFormats(read('data/draft-formats.json'));

export function makeDraft(format = 'FREE', userSide = 'blue') {
  return createDraftState({ lanesOf: (id) => db.get(id)?.lanes, formats, format, userSide, heroIds: db.all.map((h) => h.id) });
}

/** In-memory player profile (no localStorage) with a given pool: { role: { heroId: stars } }. */
export function makeProfile(pool = {}) {
  const p = { exp: {}, jungle: {}, mid: {}, gold: {}, roam: {} };
  for (const [r, hs] of Object.entries(pool)) for (const [id, stars] of Object.entries(hs)) p[r][id] = { stars };
  const roles = Object.keys(p);
  return {
    rolesFor: (id) => roles.filter((r) => p[r][id]),
    inPool: (id, role = null) => (role ? !!p[role][id] : roles.some((r) => p[r][id])),
    stars: (id, role = null) => (role ? p[role][id]?.stars || 0 : Math.max(0, ...roles.map((r) => p[r][id]?.stars || 0))),
    entries: (role) => Object.entries(p[role]).map(([id, e]) => ({ id, ...e })),
  };
}

/** Put heroes into explicit slots in Free Draft: { blue: { exp: 'freya' }, red: {...} }, bans: { blue: [...], red: [...] }. */
export function setup(d, { blue = {}, red = {}, bans = {} } = {}) {
  for (const [side, slots] of Object.entries({ blue, red })) {
    for (const [role, id] of Object.entries(slots)) { d.setTarget({ side, type: 'pick', key: role }); if (!d.act(id)) throw new Error(`could not place ${id}`); }
  }
  for (const [side, ids] of Object.entries(bans)) for (const id of ids) { d.setTarget({ side, type: 'ban' }); if (!d.act(id)) throw new Error(`could not ban ${id}`); }
  return d;
}
