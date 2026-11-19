// HERO FUNCTION LAYER: what a hero DOES in a composition, as many simultaneous
// functions with a 0–1 strength each (not one role label, not booleans).
//
// Strengths are DERIVED by reusable formulas from the hero's draft ratings, archetype tags and
// flags, so every hero (including ones never hand-tuned) gets a profile. A hero can override
// any strength in data/heroes.json → "functionStrength": { "engage": 0.95, ... } for tuning.
// Forms (e.g. Sora) are hero variants with their own ratings, so they get their own profile.

export const FUNCTIONS = [
  'frontline', 'engage', 'secondaryEngage', 'peel', 'sustain', 'burst', 'sustainedDamage', 'poke', 'siege',
  'dive', 'pickoff', 'disruption', 'zoneControl', 'objectiveControl', 'scaling', 'earlyPressure',
  'sidePressure', 'antiDive', 'backlineAccess', 'protection',
];

export const FUNCTION_LABEL = {
  frontline: 'Frontline', engage: 'Engage', secondaryEngage: 'Secondary engage', peel: 'Peel', sustain: 'Sustain',
  burst: 'Burst', sustainedDamage: 'Sustained damage', poke: 'Poke', siege: 'Siege', dive: 'Dive', pickoff: 'Pickoff',
  disruption: 'Disruption', zoneControl: 'Zone control', objectiveControl: 'Objective control', scaling: 'Scaling',
  earlyPressure: 'Early pressure', sidePressure: 'Side-lane pressure', antiDive: 'Anti-dive', backlineAccess: 'Backline access',
  protection: 'Protection',
};

const c01 = (v) => Math.max(0, Math.min(1, v));
const r2 = (v) => Math.round(v * 100) / 100;

/**
 * Function profile for a hero (or hero variant with its own `a` ratings).
 * Ratings a.* are 0–3: fl frontline, en engage, cc control, bu burst, dps sustained damage,
 * po poke, mob mobility, pe peel, su sustain, ob objective, ac backline access, ea early, la late.
 */
export function functionProfile(h) {
  const cacheKey = h.form ? `${h.id}#${h.form.id}` : h.id;
  if (h.id && cache.has(cacheKey) && !h.__nocache) return cache.get(cacheKey);
  const a = h.a;
  const n = (k) => (a[k] || 0) / 3;
  const tag = (t) => (h.tags || []).includes(t);
  const flag = (f) => (h.flags || []).includes(f);
  const sideLaner = (h.lanes || []).some((l) => l === 'exp' || l === 'jungle');
  const p = {
    frontline: n('fl'),
    engage: c01(0.7 * n('en') + 0.3 * n('cc') + (tag('engage') ? 0.05 : 0)),
    secondaryEngage: c01(0.4 * n('en') + 0.35 * n('cc') + 0.25 * n('mob')),
    // crowd control only counts as peel in proportion to the hero's protective kit (Saber's CC catches, it doesn't protect)
    peel: c01(0.75 * n('pe') + 0.25 * n('cc') * Math.min(1, n('pe') + 0.3) + (flag('antiDive') ? 0.15 : 0)),
    sustain: n('su'),
    burst: n('bu'),
    sustainedDamage: n('dps'),
    poke: n('po'),
    siege: c01(0.6 * n('po') + 0.4 * n('ob')),
    dive: c01(0.6 * n('ac') + 0.4 * n('mob')),
    pickoff: c01(0.5 * n('bu') + 0.25 * n('cc') + 0.25 * n('mob') + (tag('pickoff') ? 0.1 : 0)),
    disruption: c01(0.6 * n('cc') + 0.2 * n('en') + 0.2 * n('mob')),
    zoneControl: c01(0.4 * n('cc') + 0.4 * n('po') + 0.2 * n('pe')),
    objectiveControl: n('ob'),
    scaling: n('la'),
    earlyPressure: n('ea'),
    sidePressure: c01((0.4 * n('ob') + 0.3 * n('mob') + 0.3 * n('dps')) * (sideLaner ? 1 : 0.6)),
    antiDive: c01(0.6 * n('pe') + 0.2 * n('cc') + (flag('antiDive') ? 0.4 : 0) + (flag('antiDash') ? 0.2 : 0)),
    backlineAccess: n('ac'),
    protection: c01(0.6 * n('pe') + 0.4 * n('su')),
  };
  // Explicit per-hero tuning wins over the derived value.
  for (const [k, v] of Object.entries(h.functionStrength || {})) if (k in p) p[k] = c01(v);
  const out = Object.freeze(Object.fromEntries(FUNCTIONS.map((k) => [k, r2(p[k])])));
  if (h.id && !h.__nocache) cache.set(cacheKey, out);
  return out;
}
const cache = new Map();

/** The hero's strongest functions, e.g. [['engage', 1], ['frontline', 1], ['peel', 0.77]]. */
export function topFunctions(h, min = 0.6, max = 5) {
  return Object.entries(functionProfile(h)).filter(([, v]) => v >= min).sort((x, y) => y[1] - x[1]).slice(0, max);
}

/** Damage profile of a hero: output weight and how it is dealt. */
export function damageProfile(h) {
  const a = h.a;
  const output = (a.bu + a.dps + 0.5 * a.po) / 3;
  return { type: h.dmg === 'm' ? 'magic' : 'physical', output: r2(output), burst: a.bu / 3, sustained: a.dps / 3, poke: a.po / 3 };
}
