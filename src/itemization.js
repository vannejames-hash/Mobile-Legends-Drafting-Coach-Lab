// ITEMIZATION PRIORITIES: what should THIS hero adapt its items around because of THIS enemy draft?
// Not a build. Traits (★1–5) come from: hero type + role + draft job + the enemy's damage profile, CC,
// sustain and frontline + whether the enemy is hunting this hero. Items come ONLY from the separate item
// catalog (data/items.json), chosen by the problem they answer, and every item carries its evidence.
// When nothing in the draft calls for an adaptation, nothing is recommended.

import { functionProfile } from './heroFunctions.js';

const clamp = (v, lo = 0, hi = 1) => Math.max(lo, Math.min(hi, v));
const names = (xs, n = 2) => { const a = xs.slice(0, n).map((m) => m.hero.name); return a.length <= 1 ? a.join('') : `${a.slice(0, -1).join(', ')} and ${a.at(-1)}`; };
const fp = (h) => functionProfile(h);
const v = (xs, one, many) => (Math.min(xs.length, 2) > 1 ? many : one); // verb agreement for 1–2 named heroes

export const TRAITS = {
  physical: 'Physical durability',
  magic: 'Magic resistance',
  burst: 'Burst resistance',
  antiCC: 'Anti-CC',
  antiHeal: 'Anti-heal',
  penetration: 'Penetration',
};

/** Broad hero type for item purposes (from class + ratings, never from a hard-coded hero list). */
export function heroKind(h) {
  const a = h.a; const cls = h.cls || [];
  if (a.fl >= 3) return 'tank';
  if (a.ac >= 3 && a.bu >= 2 && a.fl <= 1) return 'assassin';
  if (cls.includes('Marksman')) return 'marksman';
  if (cls.includes('Mage')) return 'mage';
  if (a.pe >= 2 && a.fl < 2) return 'support';
  return 'fighter';
}
const KIND_LABEL = { tank: 'the frontline', assassin: 'an assassin', marksman: 'a marksman', mage: 'a mage', support: 'a support', fighter: 'a fighter' };
const DAMAGE_KINDS = ['assassin', 'marksman', 'mage', 'fighter'];

/**
 * @param hero   hero object · role · job (draft-context function id)
 * @param us / them   team facts from draftAnalysis (members, team: { damage, vector }, exposed, divers, pickers, carry)
 * @param catalog  { items: [...] } from data/items.json
 */
export function itemizationPriorities({ hero, role, jobId = null, us, them, catalog }) {
  const kind = heroKind(hero);
  const a = hero.a;
  const T = them.team;
  const dmg = T.damage;
  const self = us.members.find((m) => m.hero.id === hero.id);
  const hunters = them.divers.length ? them.divers : them.pickers;
  const targeted = !!self && (us.exposed.includes(self) || us.carry === self) && hunters.length > 0;
  const by = (pred) => them.members.filter((m) => pred(m.hero, fp(m.hero)));
  const physDealers = by((h) => h.dmg === 'p' && h.a.bu + h.a.dps >= 3);
  const magicDealers = by((h) => h.dmg === 'm' && h.a.bu + h.a.dps + h.a.po >= 3);
  const marksmen = physDealers.filter((m) => (m.hero.cls || []).includes('Marksman'));
  const burstHeroes = by((h) => h.a.bu >= 3);
  const ccHeroes = by((h) => h.a.cc >= 3);
  const healers = by((h, p) => p.sustain >= 0.9 || p.protection >= 0.8);
  const front = by((h) => h.a.fl >= 3);
  const exposure = { tank: 1, fighter: 0.9, support: 0.8, marksman: targeted ? 1 : 0.75, mage: targeted ? 1 : 0.75, assassin: 0.6 }[kind];

  const t = {
    physical: clamp(dmg.physicalShare * clamp(physDealers.length / 3) * 1.25) * exposure,
    magic: clamp(dmg.magicShare * clamp(magicDealers.length / 3) * 1.25) * exposure,
    burst: clamp(dmg.burstShare * 1.4) * (kind === 'tank' ? 0.4 : targeted ? 1 : burstHeroes.length >= 2 ? 0.75 : 0.5),
    antiCC: clamp((T.vector.disruption - 2.0) / 2.5) * (['marksman', 'mage', 'assassin'].includes(kind) ? 1 : 0.7),
    antiHeal: clamp((T.vector.sustain + 0.6 * T.vector.protection - 1.6) / 2) * (DAMAGE_KINDS.includes(kind) ? 1 : kind === 'tank' ? 0.8 : 0.5),
    penetration: DAMAGE_KINDS.includes(kind) ? clamp((T.vector.frontline - 1.2) / 2) : 0,
  };
  const stars = (v) => (v < 0.12 ? 1 : clamp(Math.round(v * 5), 1, 5));
  const EVIDENCE = {
    physical: physDealers.length ? `${names(physDealers, 3)} · ${Math.round(dmg.physicalShare * 100)}% of enemy damage is physical` : null,
    magic: magicDealers.length ? `${names(magicDealers, 3)} · ${Math.round(dmg.magicShare * 100)}% of enemy damage is magic` : null,
    burst: burstHeroes.length ? `${names(burstHeroes, 3)}${targeted ? ` · you are their target (${names(hunters, 2)})` : ''}` : null,
    antiCC: ccHeroes.length ? `${names(ccHeroes, 3)} · heavy crowd control` : null,
    antiHeal: healers.length ? `${names(healers, 3)} · healing / shielding` : null,
    penetration: front.length ? `${names(front, 3)} · durable frontline` : null,
  };
  // a trait without a named source in the enemy draft is not shown (no generic advice)
  const traits = Object.keys(TRAITS).filter((k) => EVIDENCE[k]).map((k) => ({ id: k, label: TRAITS[k], value: Math.round(t[k] * 100) / 100, stars: stars(t[k]), evidence: EVIDENCE[k] }))
    .sort((x, y) => y.value - x.value);

  // ---- items: only from the catalog, only for traits rated ★3+, matched to hero type and damage type
  const items = [];
  const cat = catalog?.items || [];
  const fits = (it) => (!it.for || it.for.includes(kind)) && (!it.damage || it.damage === hero.dmg) && !items.some((x) => x.item.id === it.id);
  const pick = (tags) => { for (const tag of tags) { const it = cat.find((x) => x.answers?.includes(tag) && fits(x)); if (it) return it; } return null; };
  const basicHeavy = marksmen.length >= 1 && marksmen.length >= physDealers.length / 2;
  const TAGS = {
    physical: basicHeavy ? ['physical-basic', 'physical'] : ['physical-skill', 'physical'],
    magic: magicDealers.some((m) => m.hero.a.bu >= 3) ? ['magic-burst', 'magic'] : ['magic-sustained', 'magic'],
    burst: ['burst'], antiCC: ['anti-cc'], antiHeal: ['anti-heal'], penetration: ['penetration'],
  };
  const top = (xs) => names(xs, 2);
  const WHY = {
    physical: () => `${top(physDealers)} ${v(physDealers, 'deals', 'deal')} most of the enemy damage as physical ${basicHeavy ? 'basic attacks' : 'skill damage'}; ${kind === 'tank' ? 'you absorb it first' : 'you are within their reach'}.`,
    magic: () => `${top(magicDealers)} ${v(magicDealers, 'brings', 'bring')} the enemy's magic damage${magicDealers.some((m) => m.hero.a.bu >= 3) ? ' in burst windows' : ''}; it decides whether you survive the first commit.`,
    burst: () => `${targeted ? `You are the target ${top(hunters)} ${v(hunters, 'is', 'are')} drafted to remove` : `${top(burstHeroes)} can delete a target in one rotation`}; surviving that window keeps you in the fight.`,
    antiCC: () => `${top(ccHeroes)} ${v(ccHeroes, 'chains', 'chain')} crowd control; ${kind === 'assassin' || kind === 'marksman' || kind === 'mage' ? 'being locked down means you deal no damage' : 'you must stay active through it'}.`,
    antiHeal: () => `${top(healers)} ${v(healers, 'heals or shields', 'heal or shield')} through your damage; cutting it is how ${kind === 'tank' ? "your team's damage" : 'your damage'} actually lands.`,
    penetration: () => `${top(front)} ${v(front, 'gives', 'give')} the enemy a durable frontline; without penetration your damage stops on them.`,
  };
  const WHEN = {
    physical: () => `Their physical damage (${top(physDealers)}) becomes the main threat to you.`,
    magic: () => `${top(magicDealers)} ${v(magicDealers, 'bursts', 'burst')} you before you can act.`,
    burst: () => kind === 'assassin' ? 'You are dying before finishing your combo.' : 'You are dying in the first seconds of fights.',
    antiCC: () => 'You are locked down before you can use your skills.',
    antiHeal: () => `${top(healers)} ${v(healers, 'keeps', 'keep')} winning extended fights.`,
    penetration: () => `Your damage stops getting through ${top(front)}.`,
  };
  for (const tr of traits.filter((x) => x.stars >= 3)) {
    if (items.length >= 3) break;
    const it = pick(TAGS[tr.id]);
    if (!it) continue;
    items.push({ item: it, trait: tr.id, label: tr.label, priority: tr.stars >= 4 ? 'High' : 'Medium', why: WHY[tr.id](), when: WHEN[tr.id](), evidence: tr.evidence });
  }
  const defensive = items.filter((x) => ['physical', 'magic', 'burst', 'antiCC'].includes(x.trait)).length;
  let warning = null;
  if (['assassin', 'marksman', 'mage'].includes(kind) && defensive >= 2) {
    warning = `Don't stack defense at the expense of ${hero.name}'s damage: ${jobId === 'backline-removal' || jobId === 'pickoff' || kind === 'assassin' ? 'your job still needs enough burst to remove the target' : 'your team still needs your damage to win fights'}. Take one defensive answer, then return to damage.`;
  } else if (kind === 'tank' && items.length && items.every((x) => x.trait === 'antiHeal')) {
    warning = 'Anti-heal on the frontline only helps if you still survive the engage: keep at least one durability item first.';
  }
  return {
    hero: hero.id, role, kind,
    traits: traits.filter((x) => x.stars >= 2),
    items,
    warning,
    none: items.length ? null : 'No major adaptation required: this enemy draft does not demand a specific defensive or anti-heal item from you.',
    catalogVersion: catalog?.version || null,
  };
}
