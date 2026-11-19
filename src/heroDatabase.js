// GAME DATA layer: official/current hero identity — lanes, class, draft functions,
// archetypes, ratings, counters. No meta, no competitive usage, no player data.

// Internal short keys used by the engines, mapped to the named ratings in heroes.json.
export const ATTRS = ['fl', 'en', 'cc', 'bu', 'dps', 'po', 'mob', 'pe', 'su', 'ob', 'ac', 'ea', 'la'];
export const RATING_KEY = {
  fl: 'frontline', en: 'engage', cc: 'cc', bu: 'burst', dps: 'damage', po: 'poke', mob: 'mobility',
  pe: 'peel', su: 'sustain', ob: 'objective', ac: 'dive', ea: 'early', la: 'scaling',
};
export const ATTR_LABEL = {
  fl: 'Frontline', en: 'Engage', cc: 'CC', bu: 'Burst', dps: 'Sustained damage', po: 'Poke',
  mob: 'Mobility', pe: 'Peel', su: 'Sustain', ob: 'Objective', ac: 'Dive', ea: 'Early game', la: 'Scaling',
};
const DMG = { physical: 'p', magic: 'm' };
const toAttrs = (ratings, base = null) =>
  Object.freeze(Object.fromEntries(ATTRS.map((k) => [k, ratings[RATING_KEY[k]] ?? base?.[k] ?? 0])));

export const DEFAULT_PORTRAIT_PATH = '/assets/heroes/{id}.webp';

export async function loadHeroDatabase(url, portraitManifestUrl = null) {
  const res = await fetch(url, { cache: 'no-store' });
  if (!res.ok) throw new Error(`Hero data failed to load (${res.status})`);
  let portraits = null;
  if (portraitManifestUrl) {
    try {
      const p = await fetch(portraitManifestUrl, { cache: 'no-store' });
      if (p.ok) portraits = await p.json();
    } catch { /* portraits are optional */ }
  }
  return createHeroDatabase(await res.json(), portraits);
}

const norm = (s) => s.toLowerCase().replace(/[^a-z0-9]/g, '');

/**
 * @param raw        heroes.json (intelligence data)
 * @param portraits  hero-portraits.json (asset data, optional): { basePath, overrides: { heroId: url } }
 */
export function createHeroDatabase(raw, portraits = null) {
  const basePath = portraits?.basePath || DEFAULT_PORTRAIT_PATH;
  const overrides = portraits?.overrides || {};
  const remote = portraits?.remote || {};
  const counters = raw.counters || {};
  const aliases = raw.aliases || {};
  const all = raw.heroes.map((h) => {
    const { id, name } = h;
    const flex = Object.entries(h.lanes.flex || {}).sort((x, y) => y[1] - x[1]);
    const laneWeights = Object.freeze({ [h.lanes.primary]: 1, ...Object.fromEntries(flex) });
    const a = toAttrs(h.ratings);
    return Object.freeze({
      id, name,
      cls: h.class,
      dmg: DMG[h.damageType] || 'p',
      primaryLane: h.lanes.primary,
      lanes: [h.lanes.primary, ...flex.map(([l]) => l)], // ordered by weight
      laneWeights,
      functions: h.functions || [],
      a,
      forms: (h.forms || []).map((f) => Object.freeze({ id: f.id, label: f.label, functions: f.functions || [], a: toAttrs(f.ratings, a) })),
      tags: h.archetypes || [],
      flags: h.flags || [],
      counters: counters[id] || [],
      profile: h.profile || 'baseline',
      provisional: h.profile === 'provisional',
      notes: h.notes || '',
      functionStrength: h.functionStrength || null, // optional per-hero tuning of the function layer
      synergies: (raw.synergies || {})[id] || [],     // optional curated 'direct synergy' pairs
      // Asset layer: resolved here so UI code never builds image URLs itself.
      // order: manual override → remote link (written by tools/download-hero-portraits.js
      // until the file is cached) → local file. The UI still falls back to the local file, then a placeholder.
      portraitUrl: overrides[id] || remote[id] || basePath.replace('{id}', id),
      portraitFallbackUrl: DEFAULT_PORTRAIT_PATH.replace('{id}', id),
      keys: [norm(name), id, ...(aliases[id] || []).map(norm)],
      words: name.toLowerCase().split(/[\s\-.']+/).map(norm).filter(Boolean),
    });
  });
  all.sort((a, b) => a.name.localeCompare(b.name));
  const byId = new Map(all.map((h) => [h.id, h]));

  function search(q) {
    const n = norm(q || '');
    if (!n) return all;
    const hits = [];
    for (const h of all) {
      let s = 0;
      if (h.keys.some((k) => k.startsWith(n))) s = 3;
      else if (h.words.some((w) => w.startsWith(n))) s = 2;
      else if (h.keys.some((k) => k.includes(n))) s = 1;
      if (s) hits.push([s, h]);
    }
    hits.sort((a, b) => b[0] - a[0] || a[1].name.localeCompare(b[1].name));
    return hits.map((x) => x[1]);
  }

  // Mean value of any per-hero function, optionally restricted to a lane.
  const meanCache = new Map();
  function mean(key, fn, lane = null) {
    const ck = `${key}|${lane}`;
    if (!meanCache.has(ck)) {
      const pool = lane ? all.filter((h) => h.lanes.includes(lane)) : all;
      meanCache.set(ck, pool.reduce((s, h) => s + fn(h), 0) / Math.max(1, pool.length));
    }
    return meanCache.get(ck);
  }

  return { all, get: (id) => byId.get(id), search, mean, version: raw.version };
}
