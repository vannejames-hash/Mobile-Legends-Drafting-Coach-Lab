// PERSONAL GUIDE: "How should I play MY role and MY hero inside this composition?"
//
// The same hero can have a different job in a different team. The guide first decides the
// hero's FUNCTION from its attributes and the teammates around it (e.g. Tigreal is the primary
// engager unless someone else already is, then he becomes secondary engage / peel), then builds
// role-specific advice from both compositions. Pure, rule-based and inspectable.

import { analyzeDraft } from './compositionEngine.js';
import { functionProfile } from './heroFunctions.js';

const ROLE_NAME = { exp: 'EXP', jungle: 'Jungle', mid: 'Mid', gold: 'Gold', roam: 'Roam' };
const engageScore = (a) => a.en * 2 + a.cc;
const names = (ms) => ms.map((m) => m.hero.name).join(', ');

/**
 * @param {object} p
 * @param {object} p.db           hero database
 * @param {Array}  p.ally         ally members [{ role, hero }]
 * @param {Array}  p.enemy        enemy members [{ role, hero }]
 * @param {string|null} p.role    my role
 * @param {string|null} p.heroId  my hero (null = undecided)
 */
export function buildPersonalGuide({ db, ally, enemy, role, heroId }) {
  if (!role) return { status: 'no-role', title: 'Set your role', message: 'Choose the role you are playing to get a personal guide.' };
  const hero = heroId ? db.get(heroId) : null;
  const A = analyzeDraft(ally, enemy, db);
  const roleBlocksOnly = (job) => ({
    status: 'no-hero', title: `${ROLE_NAME[role]} · Choose your hero`, role, hero: null,
    message: 'Choose your hero', job,
    roleBlocks: roleBlocks(role, null, null, A, ally, enemy),
  });
  if (!hero) return roleBlocksOnly(`Your team needs from ${ROLE_NAME[role]}: ${roleNeed(role, A.ally) || 'the best available hero'}.`);

  // Place my hero in the composition (hypothetically if not picked yet).
  const inTeam = ally.some((m) => m.hero.id === hero.id);
  const allyWith = inTeam ? ally : [...ally.filter((m) => m.role !== role), { role, hero }];
  const others = allyWith.filter((m) => m.hero.id !== hero.id);
  const W = analyzeDraft(allyWith, enemy, db);
  const fn = heroFunction(hero, role, others, W);
  const enemyCarry = W.enemy.carry;
  const a = hero.a;

  const synergies = synergyNotes(hero, fn, others);
  const watch = watchNotes(hero, fn, W.enemy);
  const fit = fitCheck(hero, fn, W, role);

  return {
    status: 'ready', role, hero: hero.id, inTeam,
    title: `${ROLE_NAME[role]} · ${hero.name}`,
    functionLabel: fn.labels.slice(0, 2).join(' + '),
    function: fn.primary,
    job: jobText(fn, enemyCarry),
    todo: todoText(fn, role, W),
    watch,
    synergies,
    avoid: avoidText(fn, others, W.enemy),
    priorities: priorities(fn, role, W),
    fit,
    roleBlocks: roleBlocks(role, hero, fn, W, allyWith, enemy),
    attributes: { engage: a.en, frontline: a.fl, peel: a.pe, burst: a.bu, damage: a.dps, access: a.ac },
  };
}

// ------------------------------------------------------------ function in this composition

export function heroFunction(h, role, others, W) {
  const a = h.a;
  const labels = [];
  const otherEngagers = others.filter((m) => m.hero.a.en >= 3 && engageScore(m.hero.a) >= engageScore(a));
  const carryOthers = others.filter((m) => m.hero.a.dps >= 3 && m.hero.a.la >= 3);
  let primary;
  let primaryEngager = null;
  if (a.en >= 2 && !otherEngagers.length) { primary = 'primary-engage'; labels.push('Primary engage'); }
  else if (a.en >= 2) { primary = 'secondary-engage'; primaryEngager = otherEngagers[0]; labels.push('Secondary engage / peel'); }
  else if (W.ally.carry?.hero.id === h.id) { primary = 'carry'; labels.push('Primary damage'); }
  else if (a.ac >= 3 && a.bu >= 2) { primary = W.ally.primary?.id === 'dive' ? 'dive' : 'pickoff'; labels.push(primary === 'dive' ? 'Backline dive' : 'Pickoff'); }
  else if (a.pe >= 2 && carryOthers.length) { primary = 'peel'; labels.push(`Peel for ${carryOthers[0].hero.name}`); }
  else if (a.fl >= 3) { primary = 'frontline'; labels.push('Frontline'); }
  else if (a.po >= 2) { primary = 'zone'; labels.push('Poke / zone control'); }
  else { primary = 'damage'; labels.push('Damage'); }
  // Composition decides the job: against heavy dive, a hero who can peel protects first.
  const dive = (W.enemy.threats || []).find((t) => t.id === 'dive');
  const p = functionProfile(h);
  if (dive && dive.level >= 0.6 && dive.heroes.length >= 2 && p.peel >= 0.6 && ['primary-engage', 'secondary-engage', 'frontline', 'peel'].includes(primary)) {
    primary = 'anti-dive';
    labels.unshift('Anti-dive protection');
  }
  if (role === 'jungle' || a.ob >= 3) labels.push('Objective pressure');
  if (primary !== 'frontline' && a.fl >= 3 && !labels.includes('Frontline')) labels.push('Frontline');
  if (primary === 'secondary-engage' && a.pe >= 1) labels.push('Backline protection');
  return { primary, labels, primaryEngager, carry: carryOthers[0] || null };
}

export function jobText(fn, enemyCarry) {
  switch (fn.primary) {
    case 'primary-engage': return 'Create the first favorable teamfight.';
    case 'secondary-engage': return `Follow up ${fn.primaryEngager ? `${fn.primaryEngager.hero.name}'s` : 'the first'} engage and protect the backline.`;
    case 'carry': return 'Reach your item spikes and deal damage from safe positions.';
    case 'dive': return `Reach ${enemyCarry ? enemyCarry.hero.name : 'the enemy carry'} once their peel is used.`;
    case 'pickoff': return 'Catch isolated targets and turn each pick into an objective.';
    case 'peel': return `Keep ${fn.carry ? fn.carry.hero.name : 'your carry'} alive through the enemy's first dive.`;
    case 'anti-dive': return 'Protect your Gold and Mid from the enemy dive before looking for initiation.';
    case 'frontline': return 'Absorb the first rotation of enemy skills and hold space.';
    case 'zone': return 'Control space and chip targets before objectives.';
    default: return 'Add damage where the fight is decided.';
  }
}

function todoText(fn, role, W) {
  const base = {
    'primary-engage': 'Find multi-target openings around Turtle and Lord.',
    'secondary-engage': 'Counter enemy dive and hold your key skill for the second wave.',
    carry: `Farm safely, then fight behind ${W.ally.members.find((m) => m.hero.a.fl >= 3 && m.hero.id !== W.ally.carry?.hero.id)?.hero.name || 'your frontline'}.`,
    dive: 'Track enemy peel cooldowns and enter on the second wave.',
    pickoff: 'Ward flanks and punish face-checks before objective timers.',
    peel: 'Stay next to your carry; save crowd control for whoever dives them.',
    'anti-dive': 'Hold your crowd control for the divers; start fights only after their entry is answered.',
    frontline: 'Stand between the enemy and your damage dealers.',
    zone: 'Push waves first, then hold choke points before objectives spawn.',
    damage: 'Hit the closest safe target and stay with your team.',
  }[fn.primary];
  return role === 'jungle' && fn.primary !== 'carry' ? `Accelerate tempo around Turtle/Lord. ${base}` : base;
}

export function avoidText(fn, others, enemy) {
  const accessThreat = enemy.members.filter((m) => m.hero.a.ac >= 3);
  switch (fn.primary) {
    case 'primary-engage': return 'Using your engage before your damage dealers are in range.';
    case 'secondary-engage': return `Engaging first while ${fn.primaryEngager ? fn.primaryEngager.hero.name : 'your main engager'} still has their engage.`;
    case 'carry': return accessThreat.length ? `Face-checking or farming alone while ${names(accessThreat)} is unaccounted for.` : 'Overextending before your items are complete.';
    case 'dive': case 'pickoff': return 'Entering first without follow-up.';
    case 'peel': case 'anti-dive': return 'Chasing kills or engaging first while the enemy divers are still waiting.';
    case 'frontline': return 'Chasing low targets and leaving your backline open.';
    default: return 'Fighting outside your team’s formation.';
  }
}

function synergyNotes(h, fn, others) {
  if (!others.length) return 'Depends on your teammates; picks will refine this.';
  const dmg = others.filter((m) => m.hero.a.bu + m.hero.a.dps >= 4);
  const cc = others.filter((m) => m.hero.a.cc >= 3 || m.hero.a.en >= 3);
  const peel = others.filter((m) => m.hero.a.pe >= 2 || m.hero.a.fl >= 3);
  switch (fn.primary) {
    case 'primary-engage': case 'secondary-engage': case 'frontline':
      return dmg.length ? `Follow-up damage from ${names(dmg)}.` : 'Your team lacks follow-up damage; engage only on clear numbers advantages.';
    case 'dive': case 'pickoff':
      return cc.length ? `Lockdown and setup from ${names(cc)}.` : 'No reliable setup on your team; look for targets that are already isolated.';
    case 'anti-dive': return fn.carry ? `${fn.carry.hero.name} is your priority to protect.` : 'Protect whoever deals the most damage.';
    case 'carry': case 'zone': case 'damage':
      return peel.length ? `Protection from ${names(peel)}.` : 'Little peel on your team; position further back than usual.';
    case 'peel':
      return fn.carry ? `${fn.carry.hero.name} is your priority to protect.` : 'Protect whoever deals the most damage.';
    default: return '';
  }
}

function watchNotes(h, fn, enemy) {
  if (!enemy.n) return 'Enemy picks not known yet.';
  const access = enemy.members.filter((m) => m.hero.a.ac >= 3);
  const peel = enemy.members.filter((m) => m.hero.a.pe >= 2 || m.hero.flags.includes('antiDive') || m.hero.flags.includes('antiDash'));
  const cc = enemy.members.filter((m) => m.hero.a.cc >= 3);
  if (['dive', 'pickoff', 'primary-engage'].includes(fn.primary) && peel.length) return `Enemy peel and disengage: ${names(peel)}.`;
  if (['carry', 'zone', 'damage', 'peel', 'anti-dive'].includes(fn.primary) && access.length) return `Enemy backline access: ${names(access)}.`;
  if (cc.length) return `Enemy crowd control: ${names(cc)}.`;
  return enemy.threat ? `${enemy.threat.label}: ${enemy.threat.heroes.join(', ')}.` : 'No standout threat yet.';
}

/** Is my hero a good fit for this composition? Explains when it is not (Scenario F). */
function fitCheck(h, fn, W, role) {
  const needs = W.ally.needs.filter((n) => n.pressure >= 0.3);
  const unaddressed = needs.filter((n) => n.contrib(h) < 0.5 * n.cap);
  const labels = unaddressed.slice(0, 2).map((n) => n.short);
  const JOB = { 'anti-dive': 'protection against the enemy dive', pickoff: 'a way to remove a vulnerable target', dive: 'backline access', carry: 'reliable damage', 'primary-engage': 'reliable initiation', 'secondary-engage': 'follow-up engage', frontline: 'frontline durability', peel: 'protection for the carry', zone: 'zone control', damage: 'damage' }[fn.primary] || 'useful pressure';
  if (!labels.length) {
    return { level: 'good', label: 'Strong', note: `${h.name} fits your ${W.ally.compLabel || 'composition'} identity and gives your team ${JOB}.` };
  }
  const strong = h.a.bu + h.a.dps >= 4 || h.a.ac >= 3 || h.a.en >= 3;
  const lacks = labels.join(' and ');
  const instead = { 'anti-dive': 'initiating', pickoff: 'initiating a 5v5', dive: 'fighting front-to-back', carry: 'taking early skirmishes', 'primary-engage': 'waiting for the enemy to engage', 'secondary-engage': 'starting fights', frontline: 'dealing damage', peel: 'diving', zone: 'forcing close-range fights', damage: 'leading engages' }[fn.primary];
  const responsibility = { 'anti-dive': 'protecting your backline', pickoff: 'pickoff', dive: 'backline dive', carry: 'scaling safely', 'primary-engage': 'starting fights on your terms', 'secondary-engage': 'peel and follow-up', frontline: 'holding space', peel: 'protecting your carry', zone: 'zone control', damage: 'safe damage' }[fn.primary];
  return {
    level: unaddressed.length >= 2 ? 'poor' : 'ok',
    label: unaddressed.length >= 2 ? 'Awkward' : 'Workable',
    note: `${h.name} is ${strong ? 'strong individually' : 'playable'}, but your composition currently lacks ${lacks}. Your primary responsibility becomes ${responsibility} rather than ${instead}.`,
    lacks: labels,
  };
}

function roleNeed(role, team) {
  const top = team.needs.filter((n) => n.pressure >= 0.3).slice(0, 2).map((n) => n.short);
  return top.length ? top.join(' + ') : null;
}

/** Three concrete priorities: role duty → function duty → composition-specific detail. */
function priorities(fn, role, W) {
  const ROLE = {
    jungle: 'Secure objective tempo: be first to Turtle and Lord timers.',
    exp: 'Hold the side wave, then rotate before objectives.',
    mid: 'Win wave priority and rotate first.',
    gold: 'Farm safely to your item spikes.',
    roam: 'Control vision around the next objective.',
  };
  const FN = {
    'primary-engage': 'Start fights on objectives when your damage is in range.',
    'secondary-engage': `Follow ${fn.primaryEngager ? fn.primaryEngager.hero.name : 'the primary engager'} instead of entering blindly.`,
    'anti-dive': 'Protect your Gold and Mid from the first dive.',
    peel: `Stay with ${fn.carry ? fn.carry.hero.name : 'your carry'} and save crowd control for divers.`,
    carry: 'Fight from behind your frontline and hit the closest target.',
    dive: 'Look for second-wave backline access.',
    pickoff: 'Catch isolated targets before objectives spawn.',
    frontline: 'Hold space so your damage dealers can play safely.',
    zone: 'Control choke points before objectives.',
    damage: 'Add damage where the fight is decided.',
  };
  const third = W.enemy.carry && ['dive', 'pickoff', 'primary-engage'].includes(fn.primary)
    ? `Track ${W.enemy.carry.hero.name}: they are your priority target.`
    : (W.enemy.threats || [])[0] ? `Play around their threat: ${W.enemy.threats[0].label.toLowerCase()}.` : 'Stay with your team for objective fights.';
  return [ROLE[role], FN[fn.primary], third].filter(Boolean);
}

// ------------------------------------------------------------ role-specific blocks

function roleBlocks(role, h, fn, W, allyMembers, enemyMembers) {
  const ea = W.ally.sum.ea - W.enemy.sum.ea;
  const la = W.ally.sum.la - W.enemy.sum.la;
  const enemyCarry = W.enemy.carry;
  const target = enemyCarry ? `${enemyCarry.hero.name} (${ROLE_NAME[enemyCarry.role]})` : 'their main damage dealer';
  const byRole = (ms, r) => ms.find((m) => m.role === r)?.hero;
  const allyCarry = W.ally.carry?.hero;
  const access = W.enemy.members.filter((m) => m.hero.a.ac >= 3).map((m) => m.hero.name);
  const peelers = W.ally.members.filter((m) => m.hero.id !== h?.id && (m.hero.a.pe >= 2 || m.hero.a.fl >= 3)).map((m) => m.hero.name);
  const a = h?.a || { fl: 0, en: 0, cc: 0, bu: 0, dps: 0, po: 0, mob: 0, pe: 0, ob: 0, ac: 0, la: 0, ea: 0 };
  const name = h?.name || `Your ${ROLE_NAME[role]}`;

  switch (role) {
    case 'jungle': {
      const ej = byRole(enemyMembers, 'jungle');
      const roam = byRole(allyMembers, 'roam');
      const mid = byRole(allyMembers, 'mid');
      return [
        { label: 'Tempo objective', text: ea >= 2 ? 'Your early game is stronger: path toward the side you can contest and take the first Turtle.' : ea <= -2 ? 'Your early game is weaker: full clear, protect your buffs and trade cross-map.' : 'Even early: clear efficiently and arrive first at the Turtle spawn.' },
        { label: 'First Turtle', text: ['engage', 'dive', 'pickoff'].includes(W.ally.primary?.id) && ea >= 0 ? 'High priority: your composition wins early skirmishes around it.' : 'Contest only with your roam and mid present; otherwise trade for a tower.' },
        { label: 'When to invade', text: ej ? (ej.a.ea >= 3 || ej.a.fl >= 3 ? `Avoid early invades into ${ej.name}; punish only after they show on the far side.` : `Invade when your mid and roam have wave priority; ${ej.name} is vulnerable early.`) : 'Invade only with lane priority.' },
        { label: 'Target priority', text: `${target}. ${a.ac >= 3 ? 'You have the access to reach them.' : 'Reach them after the frontline is broken.'}` },
        { label: 'With roam & mid', text: roam && roam.a.en >= 2 ? `Follow ${roam.name}'s engage; arrive with them, not after.` : mid && mid.a.cc >= 2 ? `Set up ganks off ${mid.name}'s crowd control.` : 'Path toward the lane with the most crowd control for ganks.' },
      ];
    }
    case 'exp': {
      const ee = byRole(enemyMembers, 'exp');
      const frontCount = W.ally.members.filter((m) => m.hero.a.fl >= 3).length;
      const isFront = a.fl >= 2 && frontCount <= 2;
      return [
        { label: 'Side lane', text: ee ? `Hold the side wave against ${ee.name}${ee.a.ea > a.ea ? '; they are stronger early, so trade carefully' : '; you can press early'}.` : 'Hold the side wave and keep it from crashing into your tower.' },
        { label: 'Frontline or damage', text: isFront ? `You are a frontline here: take space first so ${allyCarry ? allyCarry.name : 'your carries'} can deal damage.` : 'You are a damage source here: let your frontline start and hit whoever commits.' },
        { label: 'When to rotate', text: 'Push your wave before Turtle/Lord timers, then rotate so you arrive before the fight starts.' },
        { label: 'Split pressure', text: a.mob >= 2 && W.ally.primary?.id !== 'engage' ? 'Split-push to pull rotations, but join for Lord.' : 'Group: your composition needs you in the five-man fights.' },
        { label: 'Teamfight entry', text: fn?.primary === 'primary-engage' ? 'You start the fight; pick the angle that catches the most targets.' : a.ac >= 3 ? `Flank toward ${target} once their crowd control is used.` : 'Enter second, right behind your engage.' },
      ];
    }
    case 'mid': {
      const jungler = byRole(allyMembers, 'jungle');
      return [
        { label: 'Wave priority', text: a.po >= 2 || a.dps >= 3 ? 'Clear the wave fast: your priority lets your jungler and roam move first.' : 'You clear slowly; ask your roam to help secure mid priority.' },
        { label: 'Rotation timing', text: `Rotate right after clearing a wave${jungler ? `, toward ${jungler.name}'s side` : ''}, before objectives spawn.` },
        { label: 'Zone / control', text: a.cc >= 2 || a.po >= 2 ? 'Use your control to deny the objective area and split the enemy formation.' : 'Your job is damage; let your frontline zone and hit what they lock down.' },
        { label: 'Objective setup', text: W.ally.primary?.id === 'poke' ? 'Chip enemies before Turtle/Lord so your team can start ahead.' : 'Be in position before your engage; your follow-up decides the fight.' },
      ];
    }
    case 'gold': {
      return [
        { label: 'Farm priority', text: a.la >= 3 ? 'High: you are a scaling carry, so take safe farm and avoid trading HP.' : 'Moderate: you peak earlier, so join early skirmishes when nearby.' },
        { label: 'Scaling', text: la >= 2 ? 'Your team out-scales: avoid coin-flip fights before your core items.' : la <= -2 ? 'The enemy out-scales: use your early timing and close the game.' : 'Even scaling: objectives decide it, so be present for Lord.' },
        { label: 'Positioning', text: access.length ? `Stay out of reach of ${access.join(', ')}; keep vision on their flank.` : 'You can play forward safely; enemy backline access is low.' },
        { label: 'Survival', text: peelers.length ? `Stay close to ${peelers.slice(0, 2).join(' and ')}.` : 'Nobody peels for you: play at max range and keep an escape spell.' },
        { label: 'When to join', text: 'Join after your frontline engages and the enemy has used their key crowd control.' },
      ];
    }
    case 'roam': {
      const engageJob = fn?.primary === 'anti-dive' ? 'Peel first: the enemy dive decides fights, so protect Gold/Mid, then engage on the second wave.' : fn?.primary === 'primary-engage' ? 'You are the main engage: start fights on your terms.' : fn?.primary === 'secondary-engage' ? 'Secondary engage / peel: follow up and stay near your backline.' : a.pe >= 2 ? 'Peel first: protect your carries from the enemy dive.' : 'Support with crowd control where the fight starts.';
      const jungler = byRole(allyMembers, 'jungle');
      return [
        { label: 'Engage or peel', text: engageJob },
        { label: 'Vision', text: 'Ward jungle entrances 30s before Turtle and Lord; check brushes for your carry.' },
        { label: 'Frontline', text: a.fl >= 3 ? 'You are a primary frontline: absorb the first enemy rotation.' : 'You are not tanky: fight from behind your frontline.' },
        { label: 'Who to protect', text: allyCarry ? `${allyCarry.name}${access.length ? ` from ${access.join(', ')}` : ''}.` : 'Your highest-damage teammate.' },
        { label: 'When to rotate', text: jungler ? `Move with ${jungler.name} toward the objective side; rotate after the first wave in each lane.` : 'Rotate with your jungler toward objectives.' },
      ];
    }
    default: return [];
  }
}
