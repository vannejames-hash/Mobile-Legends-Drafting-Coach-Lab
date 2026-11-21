// UI layer for Match Mode. Reads state/engines, renders, and forwards input.
// Visual hierarchy: 1) the draft  2) turn + timer  3) what the team needs
// 4) best picks  5) hero selection. Everything else is secondary.
import { CONFIG } from '../config.js';
import { loadHeroDatabase } from '../heroDatabase.js';
import { loadMetaData } from '../metaData.js';
import { createPlayerProfile, STAR_LABEL } from '../playerProfile.js';
import { createDraftState, compileFormats, ROLES, opp } from '../draftState.js';
import { roleFunction, postDraftReport, itemization } from '../compositionEngine.js';
import { createRecommendationEngine, COMPONENT_LABEL, COMPONENTS } from '../recommendationEngine.js';
import { analyzeCompletedDraft } from '../draftAnalysis.js';
import { esc, portrait, roleIcon, starStr, toast, ROLE_NAME } from './components.js';
import { openPoolEditor } from './poolEditor.js';
import { createPlayerContext } from '../playerContext.js';
import { buildPersonalGuide } from '../personalGuide.js';
import { buildMatchState, applyMatchState, encodeShare, decodeShare, sharedProfile, memoryStorage, CODE_RE, isNewer } from '../matchState.js';
import { connectTransport, log as roomLog } from '../realtime.js';

const $ = (id) => document.getElementById(id);

let db;
try {
  db = await loadHeroDatabase(CONFIG.heroDataUrl, CONFIG.portraitManifestUrl);
} catch (err) {
  document.body.innerHTML = `<p class="fatal">Could not load hero data (${esc(err.message)}). Run <code>node server.js</code> and open http://localhost:5173.</p>`;
  throw err;
}
const meta = await loadMetaData(CONFIG.metaManifestUrl);

// ---------------------------------------------------------------- modes
//   local      my own drafting desk (default)
//   host       /match/<code> with this browser's host token: full desk, changes published to the room
//   spectator  /match/<code> without the token: read-only, follows the host live
//   share      /#share=<payload>: read-only completed draft
const route = (() => {
  const h = location.hash.match(/^#share=([A-Za-z0-9_-]+)$/);
  if (h) return { kind: 'share', payload: h[1] };
  const m = location.pathname.match(/^\/match\/([^/]+)\/?$/);
  if (m) return { kind: 'match', code: m[1].toUpperCase() };
  return { kind: 'local' };
})();
const storedToken = (code) => { try { return localStorage.getItem(`mldl.host.${code}`); } catch { return null; } };
const storedViewKey = (code) => { try { return localStorage.getItem(`mldl.view.${code}`); } catch { return null; } };
// spectator key: the #k=… part of a match link (never sent to any server log); the host keeps its own copy
const viewKey = route.kind === 'match' ? (location.hash.match(/(?:^#|&)k=([A-Za-z0-9_-]+)/)?.[1] || storedViewKey(route.code)) : null;
// ?spectate=1 opens a room read-only even in the host's own browser (test what spectators see)
const hostToken = route.kind === 'match' && !new URLSearchParams(location.search).has('spectate') ? storedToken(route.code) : null;
const MODE = route.kind === 'share' ? 'share' : route.kind === 'match' ? (hostToken ? 'host' : 'spectator') : 'local';
const VIEWER = MODE === 'share' || MODE === 'spectator';
// viewers never touch their own saved pool / role: the host's arrive with the shared state
const profile = VIEWER ? sharedProfile({}) : createPlayerProfile();
const formatData = compileFormats(await (await fetch(CONFIG.draftFormatsUrl, { cache: 'no-store' })).json());
const itemCatalog = await fetch(CONFIG.itemsUrl, { cache: 'no-store' }).then((r) => (r.ok ? r.json() : null)).catch(() => null);
const me = createPlayerContext({ lanesOf: (id) => db.get(id)?.lanes, storage: VIEWER ? memoryStorage() : globalThis.localStorage });
const draft = createDraftState({
  lanesOf: (id) => db.get(id)?.lanes, formats: formatData.formats, format: formatData.defaultId, heroIds: db.all.map((h) => h.id),
  // "I am playing <role> <hero>" is a fact: role inference flexes teammates around it.
  roleLock: (side, heroId) => (side === draft.userSide && me.role && me.hero === heroId ? me.role : null),
});
const stepTimer = () => draft.status().timer ?? CONFIG.stepSeconds;
const engine = createRecommendationEngine({ db, meta, profile });

const ui = {
  role: 'all', poolOnly: false, q: '', recTab: 'you', deep: false, showGrid: false, coachOpen: false,
  recRole: null, // recommendationRole: the TEAM role being inspected (independent of myRole)
  boardFilter: 'all', boardSort: 'fit', fitHist: {}, moves: {}, compare: [], // role board: filter, sort, Draft Fit history per role (movement arrows)
  timerLeft: CONFIG.stepSeconds, paused: false, stepKey: null,
  lastSeenAction: 0, justUsed: null, justFilled: null, roleMenu: null, confirmReset: false,
  mode: MODE, readonly: VIEWER, heroPicker: false, shareUrl: null,
  room: {
    code: route.kind === 'match' ? route.code : null, token: hostToken, viewKey, status: null, watching: 0, transport: null, error: null,
    initialFetch: null, write: null,
    // sync diagnostics (debug panel: add ?debug=1 to the URL)
    revision: null, updatedAt: null, lastSync: null, channel: 'idle', lastError: null, applied: 0, ignored: 0,
  },
};
let applying = false; // true while a shared state is being loaded (never re-published)
let ctx = null;

const TAGS = {
  'PICK NOW': ['Pick now', 'good'], FLEX: ['Flex', 'accent'], COUNTER: ['Counter', 'warn'],
  HOLD: ['Hold', 'quiet'], DENY: ['Deny', 'bad'], BAN: ['Ban', 'bad'],
};
const tagPill = (t) => (t && TAGS[t] ? `<span class="pill ${TAGS[t][1]}">${TAGS[t][0]}</span>` : '');
const roleDot = (r) => `<i class="rdot r-${r}" aria-hidden="true"></i>`;
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
const sideName = (s) => (s === 'blue' ? 'Blue side' : 'Red side');

// ------------------------------------------------------------------ context

function effectiveStep() {
  const t = draft.state.target;
  if (t) return { side: t.side, type: t.type, manual: true, phaseLabel: 'Editing a slot' };
  return draft.currentStep();
}

function buildContext() {
  const step = effectiveStep();
  const complete = draft.isComplete();
  const allySide = draft.userSide;
  const recs = step && !(complete && !step.manual) ? engine.forStep(draft, step) : null;
  const A = engine.analysisFor(draft, allySide);
  let list = [];
  let forYouEmpty = false; // eslint-disable-line prefer-const
  if (recs) {
    if (recs.kind === 'pick' && recs.isAlly && ui.recTab === 'you') {
      list = recs.forYou;
      if (!list.length) { forYouEmpty = true; list = recs.theoretical; }
    } else list = recs.theoretical;
  }
  // Personal layer: my role / my hero (auto-detected from my team's pick in my role; manual wins).
  if (me.sync(draft)) draft.refreshRoles();
  const allyM = engine.members(draft, allySide);
  const enemyM = engine.members(draft, opp(allySide));
  const guide = buildPersonalGuide({ db, ally: allyM, enemy: enemyM, role: me.role, heroId: me.hero });
  let mySuggestion = null;
  // (computed after the role board below, so it uses the same visible Draft Fit)
  const contrast = recs?.kind === 'pick' && recs.isAlly && recs.forYou[0] && recs.theoretical[0]
    ? engine.contrastPicks(recs.forYou[0], recs.theoretical[0]) : null;
  const rating = complete ? engine.rateDraft(draft, allySide, { myHero: me.hero }) : null;
  const analysis = complete ? analyzeCompletedDraft({ db, ally: allyM, enemy: enemyM, rating, myRole: me.role, myHero: me.hero, isAvailable: (id) => !draft.usedBy(id), items: itemCatalog }) : null;
  // Role-first picking: on our pick turn, recommend for one team role (selected, or the suggested next role).
  let roleRec = null;
  let suggested = [];
  if (recs?.kind === 'pick' && recs.side === allySide && !complete) {
    const open = draft.openRoles(allySide);
    suggested = engine.suggestRoles(draft, allySide);
    if (ui.recRole && !open.includes(ui.recRole)) ui.recRole = null; // filled → back to the suggestion
    const role = ui.recRole || suggested[0] || open[0];
    if (role) {
      roleRec = engine.roleBoard(draft, allySide, role, { myRole: me.role });
      trackFits(roleRec.board);
      // the board's visible Draft Fit is what every card, shortcut and coach line shows
      list = roleRec.board.entries.slice(0, 5).map((e) => ({ ...e.row, score: e.fit }));
    }
  }
  if (me.role && !me.hero && !complete && draft.openRoles(allySide).includes(me.role)) {
    const b = roleRec?.role === me.role ? roleRec.board : engine.roleBoard(draft, allySide, me.role, { myRole: me.role }).board;
    const e = b.bestForYou;
    mySuggestion = e ? { hero: e.hero, score: e.fit, stars: e.stars } : null;
  }
  const roleContrast = roleRec?.personal && roleRec.best && roleRec.overall && roleRec.best.hero.id !== roleRec.overall.hero.id
    ? engine.contrastPicks(roleRec.best, roleRec.overall) : null;
  return {
    step, complete, allySide, enemySide: opp(allySide), recs,
    full: roleRec ? roleRec.board.entries.map((e) => e.row) : list, list: list.slice(0, CONFIG.recommendationCount),
    forYouEmpty, A, guide, mySuggestion, contrast: roleRec ? roleContrast : contrast, rating, roleRec, suggested, analysis,
  };
}

/**
 * Remember each role board per draft state, so cards show how a hero moved and the desk can say WHY
 * (the sub-score whose weighted contribution changed most).
 */
function trackFits(board) {
  const key = JSON.stringify([draft.state.picks, draft.state.bans]);
  const h = ui.fitHist[board.role] || (ui.fitHist[board.role] = { key: null, now: new Map(), prev: null });
  if (h.key !== key) { h.prev = h.key ? h.now : null; h.now = new Map(); h.key = key; }
  for (const e of board.entries) {
    h.now.set(e.hero.id, { fit: e.fit, scores: e.scores, weights: e.weights });
    const was = h.prev?.get(e.hero.id);
    e.delta = was == null ? null : Math.round((e.fit - was.fit) * 10) / 10;
  }
  const movers = board.entries.filter((e) => e.delta != null && Math.abs(e.delta) >= 0.3 && e.rank <= 12)
    .sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta)).slice(0, 3);
  ui.moves[board.role] = movers.map((e) => ({ name: e.hero.name, d: e.delta, why: moveWhy(e, h.prev.get(e.hero.id), board) }));
}

function moveWhy(e, prev, board) {
  const up = e.delta > 0;
  const R = ROLE_NAME[board.role];
  const d = COMPONENTS.filter((k) => k !== 'playerFit')
    .map((k) => ({ k, d: e.weights[k] * e.scores[k] - prev.weights[k] * prev.scores[k] }))
    .filter((x) => (up ? x.d > 0 : x.d < 0)).sort((a, b) => Math.abs(b.d) - Math.abs(a.d))[0];
  const low = (x) => x.charAt(0).toLowerCase() + x.slice(1);
  const r = e.row;
  const T = up ? {
    counterScore: r.ctr.reasons[0] ? (/^can /i.test(r.ctr.reasons[0]) ? `it can now ${low(r.ctr.reasons[0]).slice(4)}` : `it now ${low(r.ctr.reasons[0])}`) : 'it answers the new enemy picks',
    compositionFit: `your ${R} now needs ${board.need.primary ? low(board.need.primary) : 'what it brings'}`,
    synergyScore: r.syn.notes[0] ? `it now offers ${r.syn.notes[0]}` : 'it pairs better with your latest pick',
    winConditionFit: 'it fits the win condition your picks now point to',
    metaScore: 'it is more contested now', draftPriority: 'it became more urgent to secure', roleFit: 'its lane opened up',
  } : {
    counterScore: r.risks[0] ? low(r.risks[0]) : 'it answers the enemy draft less well',
    compositionFit: 'your team already covers what it brings',
    synergyScore: r.syn.penalties[0] ? `it would be ${r.syn.penalties[0]}` : 'it pairs worse with your picks',
    winConditionFit: 'it no longer fits your win condition',
    metaScore: 'other heroes became more relevant', draftPriority: 'it became less urgent', roleFit: 'its lane is less natural now',
  };
  return `${up ? 'rises' : 'falls'} because ${d ? T[d.k] : 'the draft context changed'}.`;
}

/** Short "Engage · Objective · Frontline" style highlight for a recommendation. */
function highlights(r) {
  const fromNeeds = (r.need?.gains || []).slice(0, 3).map((g) => cap(g.nd.short));
  if (fromNeeds.length >= 2) return fromNeeds;
  const fns = (r.form?.functions || r.hero.functions).slice(0, 3).map(cap);
  return [...new Set([...fromNeeds, ...fns])].slice(0, 3);
}

// ------------------------------------------------------------------ header

function renderHeader() {
  const brand = `<div class="brand">
      <svg class="mark" viewBox="0 0 32 32" aria-hidden="true"><rect width="32" height="32" rx="8" class="m-bg"/><path d="M9 22V10l7 7 7-7v12" class="m-ln"/><circle cx="16" cy="24.5" r="1.9" class="m-dot"/></svg>
      <div><h1>ML Draft Lab</h1><p>${ui.mode === 'spectator' ? 'Live match · spectator' : ui.mode === 'share' ? 'Shared draft' : 'Competitive Draft Assistant'}</p></div>
    </div>`;
  const R = ui.room;
  const status = R.status || (ctx.complete ? 'COMPLETE' : 'LIVE');
  const watching = `<span class="watching" title="Spectators connected">👁 ${R.watching} watching</span>`;
  const shareBtn = ctx.complete ? '<button class="btn" data-act="share-final">Share final draft</button>' : '';
  if (ui.mode === 'spectator' || ui.mode === 'share') {
    $('header').innerHTML = `${brand}
      <div class="spec-bar">
        ${ui.mode === 'spectator'
          ? `<span class="room-badge s-${status.toLowerCase()}"><i class="live-dot"></i>${status === 'COMPLETE' ? 'Match complete' : status === 'WAITING' ? 'Waiting for the host' : 'Live match'}</span><b class="room-code">${esc(R.code || '')}</b>${watching}`
          : '<span class="room-badge s-complete">Read-only</span><b class="room-code">Final draft</b>'}
        <span class="ro-note">${R.error ? esc(R.error) : 'Read-only: only the host can change this draft'}</span>
        ${shareBtn}
        <a class="btn quiet" href="/">Open my own lab</a>
      </div>`;
    return;
  }
  const room = ui.mode === 'host'
    ? `<div class="room-chip">
        <span class="room-badge s-${status.toLowerCase()}"><i class="live-dot"></i>${status === 'COMPLETE' ? 'Complete' : status === 'WAITING' ? 'Waiting' : 'Live'}</span>
        <span class="snap-l">Match room</span><b class="room-code">${esc(R.code)}</b>
        <button class="btn sm" data-act="copy-link">Copy link</button>${watching}
        <button class="btn sm quiet" data-act="end-match" ${status === 'COMPLETE' ? 'disabled' : ''}>End match</button>
      </div>`
    : '<button class="btn" data-act="create-match" title="Open a live room: friends watch this draft in real time">Create match</button>';
  $('header').innerHTML = `
    ${brand}
    <nav class="tabs" aria-label="Mode">
      <button aria-current="page">Match</button>
      <button disabled title="Lab Mode arrives in a later chapter">Lab</button>
    </nav>
    <div class="controls">
      ${room}
      <div class="seg" role="group" aria-label="Your side">
        <button data-act="side" data-side="blue" aria-pressed="${ctx.allySide === 'blue'}">Blue side</button>
        <button data-act="side" data-side="red" aria-pressed="${ctx.allySide === 'red'}">Red side</button>
      </div>
      <select id="format" class="select" aria-label="Draft format">${Object.values(draft.formats).map((f) => `<option value="${f.id}" ${f.id === draft.state.formatId ? 'selected' : ''}>${f.label}</option>`).join('')}</select>
      ${draft.format.def.brackets ? `<select id="bracket" class="select" aria-label="Rank bracket">${Object.entries(draft.format.def.brackets).map(([id, b]) => `<option value="${id}" ${id === draft.bracket ? 'selected' : ''}>${b.label} · ${b.bansPerSide} bans</option>`).join('')}</select>` : ''}
      <span class="sep" aria-hidden="true"></span>
      <button class="btn quiet" data-act="undo" ${draft.canUndo() ? '' : 'disabled'} title="${draft.lastAction() ? `Undo: ${esc(actionLabel(draft.lastAction()))} (Ctrl+Z)` : 'Nothing to undo'}">Undo</button>
      <button class="btn ${ui.confirmReset ? 'danger' : ''}" data-act="start-over" title="Clear everything and restart the draft from ban 1">${ui.confirmReset ? 'Tap again to clear' : '↺ Start over'}</button>
      <button class="btn" data-act="pool"><span class="star" aria-hidden="true">★</span> My pool</button>
      ${shareBtn}
    </div>`;
}

// ------------------------------------------------------------------ draft stage

function teamBlock(side, isAlly) {
  const st = draft.state;
  const t = st.target;
  const step = ctx.step;
  const live = !ctx.complete && step && !step.manual && step.side === side;
  const A = isAlly ? ctx.A.ally : ctx.A.enemy;
  const picks = draft.picks(side);
  const nextIdx = picks.length;
  const pickTurn = live && step.type === 'pick';
  const slots = Array.from({ length: 5 }, (_, i) => {
    const p = picks[i];
    const h = p && db.get(p.hero);
    const isT = !h && t && t.type === 'pick' && t.side === side && i === nextIdx;
    const isNext = !h && i === nextIdx && pickTurn;
    const open = ui.roleMenu && ui.roleMenu.side === side && ui.roleMenu.hero === p?.hero;
    const removable = h && draft.canRemove().ok;
    return `<div class="slot ${h ? 'filled' : 'empty'} ${isT ? 'target' : ''} ${isNext ? 'next' : ''}" data-side="${side}" data-index="${i}">
      <span class="slot-order">Pick ${i + 1}</span>
      ${h
        ? `<span class="slot-pt inspectable" data-act="inspect" data-side="${side}" data-id="${p.hero}" role="button" tabindex="0" title="Inspect ${esc(h.name)}: draft fit, functions, synergies, counters">${portrait(h, 'pt-slot')}${removable ? `<span class="x" data-act="remove" data-side="${side}" data-type="pick" data-key="${p.hero}" role="button" aria-label="Remove ${esc(h.name)}">×</span>` : ''}</span>`
        : `<button class="slot-pt slot-open" data-act="slot" data-side="${side}" title="Log the next ${isAlly ? 'ally' : 'enemy'} pick here"><span class="slot-empty">${i === nextIdx ? '+' : ''}</span></button>`}
      <span class="slot-name">${h ? esc(h.name) : ''}</span>
      ${h && p.assignedRole
        ? `<button class="role-btn ${p.roleSource}" data-act="role-menu" data-side="${side}" data-hero="${p.hero}" aria-haspopup="menu" aria-expanded="${!!open}"
             title="${p.roleSource === 'manual' ? 'Role set by you' : 'Auto-assigned role'}: click to switch">${roleDot(p.assignedRole)}${ROLE_NAME[p.assignedRole]}<span class="caret" aria-hidden="true">▾</span></button>`
        : '<span class="slot-role"></span>'}
      ${open ? roleMenu(side, p) : ''}
    </div>`;
  }).join('');
  const lanes = ROLES.map((r) => {
    const hid = st.picks[side][r];
    return `<span class="lane ${hid ? '' : 'open'}">${roleDot(r)}${ROLE_NAME[r]} <b>${hid ? esc(db.get(hid).name) : 'open'}</b></span>`;
  }).join('');
  const nextBan = live && step.type === 'ban' ? st.bans[side].length : -1;
  const other = st.bans[opp(side)];
  const bans = Array.from({ length: draft.format.bansPerSide }, (_, i) => {
    const entered = i < st.bans[side].length;
    const id = st.bans[side][i];
    const h = id && db.get(id);
    const skipped = entered && !id;
    const dbl = h && other.includes(id);
    const isT = t && t.type === 'ban' && t.side === side && t.key === i;
    const title = h ? `${h.name}${dbl ? ' — banned by both teams' : ' (banned)'}` : skipped ? 'No ban' : 'Ban slot';
    const x = entered && draft.canRemove().ok ? `<span class="x" data-act="remove" data-side="${side}" data-type="ban" data-key="${i}" role="button" aria-label="Remove ban">×</span>` : '';
    return `<button class="ban ${h ? 'filled' : ''} ${skipped ? 'skipped' : ''} ${dbl ? 'double' : ''} ${i === nextBan ? 'next' : ''} ${isT ? 'target' : ''}" data-act="ban-slot" data-side="${side}" data-index="${i}" title="${esc(title)}">
      ${h ? portrait(h, 'pt-ban') : skipped ? '<span class="noban" aria-label="No ban">—</span>' : ''}${dbl ? '<span class="dbl" aria-hidden="true">×2</span>' : ''}${x}
    </button>`;
  }).join('');
  return `<div class="team ${isAlly ? 'ally' : 'enemy'} ${live ? 'live' : ''}">
    <div class="team-head">
      <h2>${isAlly ? 'Your team' : 'Enemy team'}</h2>
      <span class="side-lbl">${sideName(side)}</span>
      ${live ? `<span class="pill ${isAlly ? 'accent' : 'bad'}">${step.type === 'ban' ? 'Banning' : 'Picking'}</span>` : ''}
    </div>
    <div class="comp">${A.compLabel ? esc(A.compLabel) : '<span class="faint">No composition yet</span>'}</div>
    <div class="slots">${slots}</div>
    ${picks.length ? `<div class="lanes" aria-label="Current roles">${lanes}</div>` : ''}
    <div class="bans"><span class="bans-lbl">Bans</span>${bans}</div>
  </div>`;
}

function roleMenu(side, p) {
  return `<div class="role-menu" role="menu" aria-label="Switch role for ${esc(db.get(p.hero).name)}">
    <span class="rm-head">${p.roleSource === 'manual' ? 'Set by you' : 'Auto-assigned'}</span>
    ${ROLES.map((r) => {
      const holder = draft.state.picks[side][r];
      const other = holder && holder !== p.hero ? db.get(holder).name : '';
      return `<button role="menuitemradio" aria-checked="${p.assignedRole === r}" data-act="set-role" data-side="${side}" data-hero="${p.hero}" data-role="${r}">${roleDot(r)}${ROLE_NAME[r]}${other ? `<em>swap with ${esc(other)}</em>` : ''}</button>`;
    }).join('')}
    ${p.roleSource === 'manual' ? `<button class="rm-auto" data-act="auto-role" data-side="${side}" data-hero="${p.hero}">Back to auto</button>` : ''}
  </div>`;
}

function statusBlock() {
  const { step, complete } = ctx;
  if (complete && !step?.manual) {
    return `<div class="status done"><span class="st-phase">Draft complete</span><span class="st-turn">Game plan ready</span><span class="st-timer static">10<small>/10</small></span><span class="st-step">picks locked</span>${pips()}</div>`;
  }
  if (!step) return '<div class="status"></div>';
  const mine = step.side === ctx.allySide;
  const totals = draft.format.steps.filter((s) => s.type === step.type).length;
  const stepLine = step.manual ? 'Choose a hero for the selected slot' : `${cap(step.type)} ${step.number} of ${totals}`;
  const turn = step.manual ? 'Manual edit' : mine ? 'Your turn' : 'Enemy turn';
  return `<div class="status ${step.manual ? 'manual' : mine ? 'mine' : 'theirs'}">
    <span class="st-phase">${esc(step.phaseLabel)}</span>
    <span class="st-turn"><i class="dot" aria-hidden="true"></i>${turn}</span>
    <button class="st-timer ${ui.timerLeft <= 10 ? 'low' : ''} ${ui.paused ? 'paused' : ''}" id="timer" data-act="timer" title="Click to pause or resume">${ui.timerLeft}<small>s</small></button>
    <span class="st-step">${stepLine}${ui.paused ? ' · paused' : ''}</span>
    ${pips()}
  </div>`;
}

function pips() {
  const ally = ctx.allySide;
  return `<div class="pips" aria-label="Draft sequence">${draft.stepStatus().map((s) =>
    `<i class="pip ${s.type} ${s.side === ally ? 'ally' : 'enemy'} ${s.done ? 'done' : ''} ${s.current && !draft.state.target ? 'cur' : ''}" title="${cap(s.type)} ${s.number} · ${sideName(s.side)}"></i>`).join('')}</div>`;
}

function renderBoard() {
  $('board').innerHTML = `${teamBlock(ctx.allySide, true)}${statusBlock()}${teamBlock(ctx.enemySide, false)}`;
}

// ------------------------------------------------------------------ best picks

const BOARD_FILTERS = {
  all: ['All', () => true],
  pool: ['My pool', (e) => e.stars >= 2],
  best: ['Best fit', (e) => e.rank <= 5 || e.fit >= 8],
  counter: ['Counter', (e) => e.flags.counter],
  safe: ['Safe', (e) => e.flags.safe],
  situational: ['Situational', (e) => e.section === 'situational' || (e.flags.situational && e.rank > 5 && e.fit >= 5)],
};
const BOARD_SORTS = {
  fit: ['Draft fit', (e) => e.fitRaw],
  meta: ['Meta', (e) => e.scores.metaScore * 10 + e.fitRaw / 100],
  comp: ['Comp', (e) => e.scores.compositionFit * 10 + e.fitRaw / 100],
  counter: ['Counter', (e) => e.scores.counterScore * 10 + e.fitRaw / 100],
  synergy: ['Synergy', (e) => e.scores.synergyScore * 10 + e.fitRaw / 100],
  player: ['Player', (e) => e.stars * 100 + e.fitRaw],
};

function poolBadge(e, personal) {
  if (e.pool === 'comfort') return '<span class="pb comfort">Comfort</span>';
  if (e.pool === 'pool') return '<span class="pb inpool">In your pool</span>';
  if (e.pool === 'avoid') return '<span class="pb avoid">Avoid (your rating)</span>';
  return personal ? '<span class="pb off">Off pool</span>' : '';
}
const ten = (v) => (v * 10).toFixed(1);
const cmpBtn = (id) => `<button class="cmp-btn" data-act="cmp" data-id="${id}" aria-pressed="${ui.compare.includes(id)}" title="${ui.compare.includes(id) ? 'Remove from comparison' : 'Add to comparison (up to 3)'}">${ui.compare.includes(id) ? '✓' : '+'}</button>`;
const deltaTag = (e) => (e.delta && Math.abs(e.delta) >= 0.2 ? `<span class="bc-delta ${e.delta > 0 ? 'up' : 'down'}" title="Change since the last draft action">${e.delta > 0 ? '▲' : '▼'}${Math.abs(e.delta).toFixed(1)}</span>` : '');

/** Hero card. Big cards (Best fit) carry the why line and the four stats that explain the rank. */
function boardCard(e, personal, big = false) {
  return `<div class="bcard t-${e.tone} ${big ? 'big' : ''}" role="button" tabindex="0" data-act="role-pick" data-role="${e.role}" data-id="${e.hero.id}" data-key="${e.hero.id}" aria-label="${esc(`${e.hero.name}, draft fit ${e.fit.toFixed(1)}, ${e.label}. ${e.why}`)}">
    <span class="bc-rank">${e.rank}</span>
    ${portrait(e.hero, big ? 'pt-bcb' : 'pt-bc')}
    <span class="bc-main">
      <b class="bc-name">${esc(e.hero.name)}${e.form ? ` <small>${esc(e.form.label)}</small>` : ''}</b>
      <span class="bc-tags">${e.tags.map(esc).join(' · ')}</span>
      ${e.signature ? '<span class="sig-badge">★ Your signature</span>' : ''}
      ${e.stars || (personal && big) || e.confidence.level === 'Provisional' ? `<span class="bc-sub">${e.stars ? `<span class="stars">${'★'.repeat(e.stars)}</span>` : ''}${poolBadge(e, personal)}${e.confidence.level === 'Provisional' ? '<span class="pb prov">Provisional data</span>' : ''}</span>` : ''}
    </span>
    <span class="bc-fit"><b>${e.fit.toFixed(1)}</b><small>${e.label}</small>${deltaTag(e)}</span>
    ${big ? `<span class="bc-stats"><span>Meta <b>${ten(e.scores.metaScore)}</b></span><span>Comp <b>${ten(e.scores.compositionFit)}</b></span><span>Counter <b>${ten(e.scores.counterScore)}</b></span><span>Player <b>${ten(e.scores.playerFit)}</b></span></span>
    <span class="bc-why">${esc(e.why)}</span>` : ''}
    ${cmpBtn(e.hero.id)}
    ${big && e.rank <= 5 ? `<kbd>${e.rank}</kbd>` : ''}
  </div>`;
}

/** YOUR SIGNATURE: shown on your own role even outside the top 5; its Draft Fit is never boosted. */
function signatureHTML(B) {
  const S = B.signature;
  if (!S || S.inTop5) return '';
  if (S.unavailable) return `<p class="sig-off hint">★ Your signature ${esc(db.get(S.heroId)?.name || '')} is ${esc(S.unavailable)}.</p>`;
  const e = S.entry;
  return `<div class="sig-row">
    <div class="sig-card t-${e.tone}" role="button" tabindex="0" data-act="role-pick" data-role="${e.role}" data-id="${e.hero.id}" data-key="${e.hero.id}">
      <span class="snap-l">★ Your signature</span>
      ${portrait(e.hero, 'pt-bcb')}
      <span class="sig-main"><b>${esc(e.hero.name)}</b><span class="stars">${'★'.repeat(S.stars)}</span> <small>${esc(STAR_LABEL[S.stars] || '')}</small>
        ${S.lowFit ? '<span class="pb prov">Low draft fit · High player fit</span>' : ''}</span>
      <span class="sig-nums"><span><small>Draft fit</small><b class="df">${e.fit.toFixed(1)}</b></span><span><small>Player fit</small><b>${S.playerFit.toFixed(1)}</b></span><span><small>Rank</small><b>#${e.rank}</b></span></span>
    </div>
    <div class="sig-why"><span class="snap-l">Why consider your signature?</span><p>${esc(S.why)}</p></div>
  </div>`;
}

/** YOUR DRAFT ROLE: role buttons + the selected hero with its portrait, pool stars and source. */
function identityHTML({ compact = false } = {}) {
  const role = me.role;
  const h = me.hero ? db.get(me.hero) : null;
  const stars = h && role ? profile.stars(h.id, role) : 0;
  const ro = ui.readonly;
  const roles = ROLES.map((r) => `<button class="id-r ${role === r ? 'on' : ''}" data-act="my-role" data-role="${r}" aria-pressed="${role === r}" ${ro ? 'disabled' : ''} title="${ro ? "Host's role" : `I am playing ${ROLE_NAME[r]}`}">${roleIcon(r)}<span>${ROLE_NAME[r]}</span></button>`).join('');
  return `<div class="ident ${compact ? 'compact' : ''}" aria-label="${ro ? "Host's draft role" : 'Your draft role'}">
    <span class="snap-l">${ro ? "Host's draft role" : 'Your draft role'}</span>
    <div class="id-roles" role="group">${roles}</div>
    <div class="id-hero">
      ${h ? portrait(h, 'pt-id') : `<span class="pt pt-id id-empty" aria-hidden="true">${role ? roleIcon(role) : '?'}</span>`}
      <div class="id-hero-t">
        <span class="snap-l">${ro ? 'Hero' : 'Your hero'}</span>
        <b>${h ? esc(h.name) : role ? 'Not chosen yet' : 'Choose your role'}</b>
        <span class="id-sub">${stars ? `<span class="stars">${'★'.repeat(stars)}</span> ${esc(STAR_LABEL[stars])}` : h && role ? 'Not in pool' : ''}${h ? `<span class="pb ${me.heroSource === 'manual' ? 'inpool' : 'off'}">${me.heroSource === 'manual' ? 'Manual' : 'Auto-detected'}</span>` : ''}</span>
      </div>
      ${ro ? '' : `<button class="btn sm" data-act="hero-picker" ${role ? '' : 'disabled'} aria-expanded="${ui.heroPicker}">${h ? 'Change hero' : 'Choose hero'}</button>`}
    </div>
    ${(() => {
      if (!role) return '';
      const sig = (profile.signature && profile.signature(role)) || profile.entries(role).filter((x) => x.stars >= 4).sort((x, y) => y.stars - x.stars)[0]?.id;
      const sh = sig && db.get(sig);
      const canSet = !ro && h && profile.stars(h.id, role) >= 1 && h.id !== sig && profile.setSignature;
      return sh || canSet ? `<p class="id-sig">${sh ? `★ Signature ${esc(ROLE_NAME[role])}: <b>${esc(sh.name)}</b>` : ''}${canSet ? ` <button class="link" data-act="set-signature" data-role="${role}" data-id="${h.id}">Make ${esc(h.name)} my signature</button>` : ''}</p>` : '';
    })()}
    ${ui.heroPicker && !ro && role ? heroPickerHTML(role) : ''}
  </div>`;
}

/** Visual hero picker: my pool for the role first, then every other hero of that role. */
function heroPickerHTML(role) {
  const pool = profile.entries(role).filter((e) => e.stars >= 1).sort((a, b) => b.stars - a.stars).map((e) => db.get(e.id)).filter(Boolean);
  const others = db.all.filter((h) => h.lanes.includes(role) && !pool.includes(h));
  const tile = (h) => {
    const st = profile.stars(h.id, role);
    return `<button class="hp-t ${me.hero === h.id ? 'on' : ''}" data-act="my-hero" data-id="${h.id}" title="${esc(h.name)}${st ? ` · ${STAR_LABEL[st]}` : ''}">${portrait(h, 'pt-hp')}<span>${esc(h.name)}</span>${st ? `<small class="stars">${'★'.repeat(st)}</small>` : ''}</button>`;
  };
  return `<div class="hpick" aria-label="Choose your hero">
    <div class="hp-sec"><span class="snap-l">Your ${ROLE_NAME[role]} pool</span><div class="hp-grid">${pool.map(tile).join('') || `<p class="hint">No ${ROLE_NAME[role]} heroes in your pool. <button class="link" data-act="pool">Edit My pool</button></p>`}</div></div>
    <div class="hp-sec"><span class="snap-l">Other ${ROLE_NAME[role]} heroes</span><div class="hp-grid">${others.map(tile).join('')}</div></div>
    <div class="hp-foot"><button class="link" data-act="my-hero" data-id="">Undecided: detect it from my team's pick</button><button class="btn sm" data-act="hero-picker">Done</button></div>
  </div>`;
}

/** The current-draft snapshot: one flat strip above the desk, in every live phase. */
function snapshotHTML() {
  const { A, roleRec, recs, step } = ctx;
  const ally = A.ally;
  const enemy = A.enemy;
  const fill = roleRec ? ROLE_NAME[roleRec.role] : recs?.kind === 'ban' ? (recs.isAlly ? 'Your ban' : 'Enemy ban') : recs && !recs.isAlly ? 'Enemy pick' : '—';
  const needs = ally.needs.filter((n) => n.pressure >= 0.3).slice(0, 2).map((n) => n.short);
  const th = enemy.threats?.[0];
  const cell = (label, value, sub = '') => `<div class="snap-c"><span class="snap-l">${label}</span><b>${value}</b>${sub ? `<small>${sub}</small>` : ''}</div>`;
  return `<div class="desk-top"><div class="snap" aria-label="Current draft snapshot">
    ${cell(roleRec ? 'Role to fill' : 'Now', esc(fill), step && !step.manual ? esc(step.phaseLabel) : '')}
    ${cell('Team need', ally.n ? (needs.length ? esc(cap(needs.join(' + '))) : 'No major gaps') : '<span class="faint">Open</span>')}
    ${cell('Enemy threat', th ? esc(th.label) : '<span class="faint">Not known yet</span>', th ? esc(th.heroes.join(', ')) : '')}
    ${cell('Draft identity', ally.compLabel ? esc(ally.compLabel) : '<span class="faint">Forms with your picks</span>', enemy.compLabel ? `vs ${esc(enemy.compLabel)}` : '')}
    <button class="btn quiet sm snap-coach" data-act="coach-open">Draft coach →</button>
  </div>${identityHTML()}</div>`;
}

function compareHTML(c) {
  const winCls = (r, v) => (v === r.best && r.values.filter((x) => x === r.best).length < r.values.length ? 'win' : '');
  return `<section class="desk-sec cmp" aria-label="Hero comparison">
    <div class="desk-h"><h2>Compare</h2><span class="hint">${c.heroes.map((h) => esc(h.hero.name)).join(' vs ')}</span><button class="link" data-act="cmp-clear">Clear</button></div>
    <div class="cmp-wrap">
      <table class="cmp-t"><thead><tr><th>Dimension</th>${c.heroes.map((h) => `<th><span class="cmp-h">${portrait(h.hero, 'pt-bc')}${esc(h.hero.name)}</span></th>`).join('')}</tr></thead>
      <tbody>${c.rows.map((r) => `<tr class="${r.key === 'fit' ? 'fit' : ''}"><td>${esc(r.label)}</td>${r.values.map((v) => `<td class="${winCls(r, v)}">${v.toFixed(1)}</td>`).join('')}</tr>`).join('')}</tbody></table>
      <div class="cmp-dec"><span class="snap-l">Decision</span>${c.decision.map((d) => `<p>${esc(d)}</p>`).join('')}</div>
    </div>
  </section>`;
}

function poolTable(B) {
  const [, fn] = BOARD_FILTERS[ui.boardFilter];
  const [, key] = BOARD_SORTS[ui.boardSort];
  const list = B.entries.filter(fn).sort((a, b) => key(b) - key(a));
  const R = ROLE_NAME[B.role];
  if (!list.length) return `<p class="empty-msg">${ui.boardFilter === 'pool' ? `No ${R} heroes in your pool are available. <button class="link" data-act="pool">Edit My pool</button>` : `No ${R} heroes match this filter in the current draft.`}</p>`;
  const head = (k, label) => `<button class="ph-sort" data-act="board-sort" data-s="${k}" aria-pressed="${ui.boardSort === k}">${label}${ui.boardSort === k ? ' ↓' : ''}</button>`;
  return `<div class="ptable" role="table" aria-label="Full ${esc(R)} hero pool">
    <div class="prow phead" role="row"><span>#</span><span>Hero</span><span>Functions</span>${head('fit', 'Draft fit')}${head('meta', 'Meta')}${head('comp', 'Comp')}${head('counter', 'Counter')}${head('synergy', 'Synergy')}${head('player', 'Player')}<span></span></div>
    ${list.map((e) => `<div class="prow t-${e.tone}" role="row button" tabindex="0" data-act="role-pick" data-role="${e.role}" data-id="${e.hero.id}" data-key="${e.hero.id}">
      <span class="p-rank">${e.rank}</span>
      <span class="p-hero">${portrait(e.hero, 'pt-row')}<b>${esc(e.hero.name)}</b>${e.stars ? `<span class="stars">${'★'.repeat(e.stars)}</span>` : ''}${e.confidence.level === 'Provisional' ? '<span class="pb prov">Prov.</span>' : ''}</span>
      <span class="p-tags">${e.tags.map(esc).join(' · ')}</span>
      <span class="p-fit"><b>${e.fit.toFixed(1)}</b><small>${e.label}</small>${deltaTag(e)}</span>
      <span class="p-n">${ten(e.scores.metaScore)}</span><span class="p-n">${ten(e.scores.compositionFit)}</span><span class="p-n">${ten(e.scores.counterScore)}</span><span class="p-n">${ten(e.scores.synergyScore)}</span><span class="p-n">${e.stars ? ten(e.scores.playerFit) : '—'}</span>
      ${cmpBtn(e.hero.id)}
    </div>`).join('')}
  </div>`;
}

/** THE DRAFT DESK (our pick turn): role → need → best 5 → compare → decision board → full role pool. */
function renderRoleRecs(el) {
  const rr = ctx.roleRec;
  const B = rr.board;
  const R = ROLE_NAME[rr.role];
  const lane = ['gold', 'exp', 'mid'].includes(rr.role) ? `${R} lane` : R;
  const filled = (r) => draft.state.picks[ctx.allySide][r];
  const tabs = ROLES.map((r) => {
    const f = filled(r);
    const sug = ctx.suggested.includes(r);
    return `<button class="rtab ${sug ? 'sug' : ''}" data-act="rec-role" data-role="${r}" aria-pressed="${rr.role === r}" ${f ? 'disabled' : ''} title="${f ? `${esc(db.get(f).name)} already plays ${ROLE_NAME[r]}` : `Analyze what our ${ROLE_NAME[r]} needs`}">${roleDot(r)}<b>${ROLE_NAME[r]}</b><small>${f ? esc(db.get(f).name) : sug ? 'Suggested next' : 'Open'}</small></button>`;
  }).join('');
  const n = B.need;
  const moves = ui.moves[rr.role] || [];
  ui.compare = ui.compare.filter((id) => B.entries.some((e) => e.hero.id === id));
  const cmp = ui.compare.length >= 2 ? B.compare(ui.compare) : null;
  const best = B.sections.find((x) => x.key === 'best')?.entries || [];
  const decision = B.sections.filter((x) => !['best', 'low'].includes(x.key));
  const poolEmpty = !profile.entries(rr.role).some((x) => x.stars >= 2);
  const pickLine = (label, e, extra = '') => (e ? `<button class="fy-pick t-${e.tone}" data-act="role-pick" data-role="${e.role}" data-id="${e.hero.id}">${portrait(e.hero, 'pt-bc')}<span><small>${label}</small><b>${esc(e.hero.name)}</b></span><em>${e.fit.toFixed(1)}</em>${extra}</button>` : '');
  const chips = Object.entries(BOARD_FILTERS).map(([k, [label, fn]]) => `<button class="chip" data-act="board-filter" data-f="${k}" aria-pressed="${ui.boardFilter === k}">${label}<span class="n">${B.entries.filter(fn).length}</span></button>`).join('');

  el.innerHTML = `
    ${snapshotHTML()}
    <section class="desk-sec pickfor">
      <div class="desk-h"><h2>Pick for</h2><span class="hint">Choose the role we are filling; everything below is analyzed for it.</span></div>
      <div class="rtabs" role="group" aria-label="Pick for role">${tabs}</div>
    </section>
    <section class="desk-sec need" aria-label="${esc(lane)} need">
      <div class="need-grid">
        <div><span class="snap-l">${esc(lane)} need · primary</span><b class="need-big">${esc(n.primary || 'Best available')}</b></div>
        <div><span class="snap-l">Secondary</span><b>${n.secondary ? esc(n.secondary) : '<span class="faint">None</span>'}</b></div>
        <div class="risk"><span class="snap-l">Risk</span><b>${n.risk ? esc(n.risk) : '<span class="faint">Not known yet</span>'}</b></div>
      </div>
      <p class="need-why"><span class="snap-l">Why this matters</span>${esc(n.why)}</p>
      ${moves.length ? `<ul class="moves" aria-label="What changed since the last pick">${moves.map((m) => `<li class="${m.d > 0 ? 'up' : 'down'}"><b>${m.d > 0 ? '▲' : '▼'} ${esc(m.name)} ${m.d > 0 ? '+' : ''}${m.d.toFixed(1)}</b> ${esc(m.why)}</li>`).join('')}</ul>` : ''}
    </section>
    <section class="desk-sec best">
      <div class="desk-h"><h2>Best fit for ${esc(R)}</h2><span class="hint">Hover a hero for the full reasoning · 1–5 to pick · + to compare</span></div>
      <div class="rb-grid big">${best.map((e) => boardCard(e, B.personal, true)).join('')}</div>
      ${signatureHTML(B)}
      <div class="foryou">
        ${pickLine('Best overall', B.bestOverall)}
        ${B.bestForYou ? pickLine('Best for you', B.bestForYou, `<span class="stars">${'★'.repeat(B.bestForYou.stars)}</span>`) : `<span class="hint">${poolEmpty ? `No ${esc(R)} heroes in your pool. <button class="link" data-act="pool">Add some in My pool</button>` : `None of your ${esc(R)} pool heroes is available.`}</span>`}
        ${B.forYouNote ? `<p class="fy-note">${esc(B.forYouNote)}</p>` : ''}
        ${B.compelling ? `<p class="fy-note compelling"><b>Compelling off-pool pick: ${esc(B.compelling.hero.name)}</b> (+${B.compelling.gap.toFixed(1)} draft fit). ${esc(B.compelling.why)}</p>` : ''}
      </div>
    </section>
    ${ui.readonly ? '' : cmp ? compareHTML(cmp) : ui.compare.length === 1 ? `<p class="hint cmp-hint">Comparing ${esc(db.get(ui.compare[0]).name)}: add one or two more heroes with +.</p>` : ''}
    ${!ui.readonly && decision.length ? `<section class="desk-sec decision">
      <div class="desk-h"><h2>Decision board</h2><span class="hint">Other answers, grouped by why they work</span></div>
      ${decision.map((sec) => `<div class="rb-sec s-${sec.key}"><h3>${esc(sec.label)} <span class="n">${sec.entries.length}</span><span class="hint">${esc(sec.hint)}</span></h3>
        <div class="rb-grid">${sec.entries.map((e) => boardCard(e, B.personal)).join('')}</div></div>`).join('')}
    </section>` : ''}
    ${ui.readonly ? '' : `<section class="desk-sec pool">
      <div class="desk-h"><h2>Full ${esc(R)} hero pool</h2><span class="hint">${B.entries.length} available · ranked, not hidden</span></div>
      <div class="rb-tools"><div class="chips" role="group" aria-label="Filter the ${esc(R)} pool">${chips}</div></div>
      ${poolTable(B)}
    </section>`}`;
}

// ------------------------------------------------------------------ hover card (deep data) + pick inspector

const hc = document.createElement('div');
hc.id = 'hovercard';
hc.className = 'hc';
hc.hidden = true;
hc.setAttribute('role', 'tooltip');
document.body.appendChild(hc);
let hcAnchor = null;
const detailCache = new Map();

function breakdownHTML(rows) {
  return `<div class="hc-bd">${rows.map((b) => `<div><span>${esc(b.label)}</span><i><b style="width:${Math.round(b.value * 10)}%"></b></i><em>${b.value.toFixed(1)}</em></div>`).join('')}</div>`;
}

function hoverHTML(d) {
  return `<div class="hc-head">
      ${portrait(d.hero, 'pt-bc')}
      <div><b class="hc-name">${esc(d.hero.name)}</b><span class="hc-sub">${ROLE_NAME[d.role]} · #${d.rank} of ${d.of}${d.stars ? ` · <span class="stars">${'★'.repeat(d.stars)}</span>` : ''}</span></div>
      <span class="hc-fit t-${d.tone}"><b>${d.fit.toFixed(1)}</b><small>/ 10 · ${esc(d.tier)}</small></span>
    </div>
    <p class="hc-tags">${d.tags.map((t) => `<span class="ftag">${esc(t)}</span>`).join('')}</p>
    <div class="hc-sec"><span class="clabel">Why it fits</span><p class="hc-why">${esc(d.why)}</p>${d.reasons.length ? `<ul class="plus">${d.reasons.map((r) => `<li>${esc(r)}</li>`).join('')}</ul>` : ''}</div>
    <div class="hc-sec"><span class="clabel">Score breakdown</span>${breakdownHTML(d.breakdown)}</div>
    ${d.job ? `<div class="hc-sec"><span class="clabel">Draft job</span><p><b>${esc(d.job.label)}</b> · ${esc(d.job.text)}</p></div>` : ''}
    ${d.watch ? `<div class="hc-sec"><span class="clabel">Risk</span><p>${esc(d.watch)}</p></div>` : ''}
    ${d.whyNotTop ? `<div class="hc-sec"><span class="clabel">${d.rank > 5 ? 'Why not top 5?' : 'Why not #1?'}</span><p>${esc(d.whyNotTop)}</p></div>` : ''}
    <p class="hc-conf c-${d.confidence.level.toLowerCase()}" title="${esc(d.confidence.reasons.join(' · '))}">Analysis confidence: <b>${esc(d.confidence.level)}</b><span>${esc(d.confidence.reasons.join(' · '))}</span></p>`;
}

function inspectHTML(d) {
  // notes are phrased from the inspected team's side: "your plan" → "their plan" for enemy heroes
  const pov = (x) => (d.side === ctx.allySide ? x : x.replace(/\byour\b/g, 'their').replace(/\bYour\b/g, 'Their'));
  const list = (xs, empty) => (xs.length ? `<ul>${xs.slice(0, 3).map((x) => `<li>${esc(pov(x))}</li>`).join('')}</ul>` : `<p class="faint">${empty}</p>`);
  return `<button class="hc-close" data-act="inspect-close" aria-label="Close">✕</button>
    <div class="hc-head">
      ${portrait(d.hero, 'pt-bc')}
      <div><b class="hc-name">${esc(d.hero.name)}</b><span class="hc-sub">${d.side === ctx.allySide ? 'Your team' : 'Enemy team'} · ${ROLE_NAME[d.role]} · #${d.rank} of ${d.of} ${ROLE_NAME[d.role]} options</span></div>
      <span class="hc-fit t-${d.tone}"><b>${d.fit.toFixed(1)}</b><small>/ 10 · ${esc(d.label)}</small></span>
    </div>
    <p class="hc-tags">${d.tags.map((t) => `<span class="ftag">${esc(t)}</span>`).join('')}</p>
    ${d.job ? `<div class="hc-sec"><span class="clabel">Job in the composition</span><p><b>${esc(d.job.label)}</b> · ${esc(d.job.text)}</p></div>` : ''}
    <div class="hc-sec hc-2"><div><span class="clabel">Synergies</span>${list(d.synergies, 'No standout pairing.')}</div><div><span class="clabel">Counters</span>${list(d.counters, 'No direct counter edge.')}</div></div>
    ${d.counteredBy.length || d.synergyConcerns.length ? `<div class="hc-sec"><span class="clabel">Watch out</span>${list([...d.counteredBy, ...d.synergyConcerns], '')}</div>` : ''}
    <div class="hc-sec"><span class="clabel">Score breakdown (final draft context)</span>${breakdownHTML(d.breakdown)}</div>
    <p class="hc-conf c-${d.confidence.level.toLowerCase()}">Analysis confidence: <b>${esc(d.confidence.level)}</b><span>${esc(d.confidence.reasons.join(' · '))}</span></p>`;
}

/** Position a fixed card next to an anchor, inside the viewport (the page itself is zoomed). */
function placeCard(pop, anchor) {
  const z = parseFloat(getComputedStyle(document.documentElement).zoom) || 1;
  const r = anchor.getBoundingClientRect();
  const f = anchor.offsetWidth ? r.width / anchor.offsetWidth : 1; // rect units per CSS px
  const vw = window.innerWidth / z;
  const vh = window.innerHeight / z;
  const L = r.left / f; const T = r.top / f; const W = r.width / f;
  const pw = pop.offsetWidth; const ph = pop.offsetHeight;
  let left = L + W + 10;
  if (left + pw > vw - 8) left = L - pw - 10;
  if (left < 8) left = Math.max(8, Math.min(vw - pw - 8, L));
  const top = Math.max(8, Math.min(T - 8, vh - ph - 8));
  pop.style.left = `${left}px`;
  pop.style.top = `${top}px`;
}

function showHover(card) {
  const B = ctx?.roleRec?.board;
  const id = card.dataset.id;
  if (!B || !id || hc.classList.contains('pinned')) return;
  const key = `${ctx.roleRec.role}|${id}|${B.entries.length}|${JSON.stringify(draft.state.picks)}`;
  if (!detailCache.has(key)) { if (detailCache.size > 200) detailCache.clear(); detailCache.set(key, B.detail(id)); }
  const d = detailCache.get(key);
  if (!d) return;
  hc.innerHTML = hoverHTML(d);
  hc.hidden = false;
  hcAnchor = card;
  placeCard(hc, card);
}
function hideHover(force = false) {
  if (hc.classList.contains('pinned') && !force) return;
  hc.hidden = true; hc.classList.remove('pinned'); hcAnchor = null;
}
function inspectPick(side, id, anchor) {
  const d = engine.inspectPick(draft, side, id);
  if (!d) return;
  hc.innerHTML = inspectHTML(d);
  hc.classList.add('pinned');
  hc.hidden = false;
  hcAnchor = anchor;
  placeCard(hc, anchor);
  hc.querySelector('.hc-close')?.focus({ preventScroll: true });
}
$('recs').addEventListener('mouseover', (e) => {
  const card = e.target.closest('.bcard, .prow:not(.phead), .fy-pick');
  if (card && card !== hcAnchor) showHover(card);
});
$('recs').addEventListener('mouseout', (e) => {
  const card = e.target.closest('.bcard, .prow:not(.phead), .fy-pick');
  if (card && !card.contains(e.relatedTarget)) hideHover();
});
$('recs').addEventListener('focusin', (e) => { const c = e.target.closest('.bcard, .prow:not(.phead), .fy-pick'); if (c) showHover(c); });
$('recs').addEventListener('focusout', () => hideHover());
document.addEventListener('scroll', () => hideHover(), true);

function renderRecs() {
  const { recs, list } = ctx;
  const el = $('recs');
  if (!recs || (ctx.complete && !ctx.step?.manual)) { el.innerHTML = ''; el.hidden = true; return; }
  el.hidden = false;
  if (ctx.roleRec) { renderRoleRecs(el); return; }
  const ban = recs.kind === 'ban';
  const title = ban ? (recs.isAlly ? 'Priority bans' : 'Likely enemy bans') : recs.isAlly ? 'Best picks for this draft' : 'Likely enemy picks';
  const hint = !recs.isAlly ? 'Click one to record the enemy’s choice'
    : ctx.forYouEmpty && ui.recTab === 'you' ? `No pool heroes for ${draft.openRoles(recs.side).map((r) => ROLE_NAME[r]).join(', ')}. Showing all heroes.`
      : ban ? 'Contested meta heroes and answers to your picks' : 'Ranked by draft fit · press a card’s number to pick it';
  const tabs = !ban && recs.isAlly
    ? `<div class="seg sm" role="group" aria-label="Recommendation scope">
        <button data-act="rec-tab" data-tab="you" aria-pressed="${ui.recTab === 'you'}">Your pool</button>
        <button data-act="rec-tab" data-tab="theory" aria-pressed="${ui.recTab === 'theory'}">All heroes</button>
      </div>` : '';
  const cards = list.map((r, i) => {
    const hl = ban ? [r.reasons[0]] : highlights(r);
    const s = r.score >= 7 ? 's-hi' : r.score >= 5 ? 's-mid' : 's-lo';
    return `<button class="rec ${i === 0 ? 'first' : ''} ${ban ? 'is-ban' : ''}" data-act="hero" data-key="${r.hero.id}" data-id="${r.hero.id}" title="${esc(r.reasons.join(' · '))}">
      ${portrait(r.hero, 'pt-rec')}
      <span class="rec-main">
        <b class="rec-name">${esc(r.hero.name)}</b>
        <span class="rec-sub">${roleDot(r.role)}${ROLE_NAME[r.role]}${r.form ? ` · ${esc(r.form.label)}` : ''}${r.stars ? `<span class="stars">${'★'.repeat(r.stars)}</span>` : ''}</span>
      </span>
      <span class="score ${ban ? 's-ban' : s}"><b>${r.score.toFixed(1)}</b><small>${ban ? 'Priority' : 'Draft fit'}</small></span>
      <span class="rec-foot">${tagPill(ban ? null : r.tag)}<span class="rec-hl">${hl.map(esc).join(' · ')}</span><span class="rec-act">${!recs.isAlly ? 'Record' : ban ? 'Ban' : 'Pick'}</span></span>
      <kbd>${i + 1}</kbd>
    </button>`;
  }).join('');
  el.innerHTML = `
    ${snapshotHTML()}
    <div class="sec-head">
      <div><h2>${title}</h2><p class="hint">${esc(hint)}</p></div>
      <div class="sec-tools">${tabs}${ban && draft.canNoBan().ok ? `<button class="btn sm" data-act="no-ban" title="Record this ban slot as empty and move on">No ban</button>` : ''}</div>
    </div>
    <div class="rec-row">${cards || '<p class="hint">No candidates for the open roles.</p>'}</div>`;
}

// ------------------------------------------------------------------ hero grid

function recommendedIds() {
  return new Set(ctx.full.slice(0, 12).map((r) => r.hero.id));
}

/** Role the draft is asking for right now: a targeted slot, else the top recommendation's role. */
function focusRole() {
  const t = draft.state.target;
  if (t && t.type === 'pick' && t.side === ctx.allySide && ROLES.includes(t.key)) return t.key;
  if (ctx.recs?.kind === 'pick' && ctx.recs.isAlly && ctx.list[0]) return ctx.list[0].role;
  return null;
}

/** My Pool grouped by role: the role being drafted first, then other open roles, then filled roles. */
function poolGroups() {
  const open = draft.openRoles(ctx.allySide);
  const focus = focusRole();
  const roles = ROLES.includes(ui.role) ? [ui.role]
    : [...new Set([focus, ...open, ...ROLES].filter(Boolean))];
  return roles.map((r) => ({
    role: r, open: open.includes(r), focus: r === focus,
    heroes: profile.entries(r).map((e) => db.get(e.id)).filter(Boolean)
      .sort((a, b) => profile.stars(b.id, r) - profile.stars(a.id, r) || a.name.localeCompare(b.name)),
  })).filter((g) => g.heroes.length || g.focus);
}

function visibleHeroes() {
  if (ui.poolOnly && !ui.q && ui.role !== 'rec') {
    const seen = new Set();
    return poolGroups().flatMap((g) => g.heroes).filter((h) => !seen.has(h.id) && seen.add(h.id));
  }
  let list = ui.q ? db.search(ui.q) : db.all;
  if (ui.role === 'rec') {
    const order = ctx.full.slice(0, 12).map((r) => r.hero.id);
    list = order.map((id) => db.get(id)).filter((h) => list.includes(h));
  } else if (ui.role !== 'all') {
    list = list.filter((h) => h.lanes.includes(ui.role) || (ui.poolOnly && profile.inPool(h.id, ui.role)));
  }
  if (ui.poolOnly) list = list.filter((h) => profile.inPool(h.id, ['all', 'rec'].includes(ui.role) ? null : ui.role));
  return list;
}

function usageNote(h) {
  const u = meta.usage(h.id);
  if (!u) return '';
  if (u.laneStatus === 'observed') return ` · ${meta.source.split(' —')[0]}: ${Object.entries(u.observedLanes).map(([l, n]) => `${ROLE_NAME[l]} ${n}`).join(', ')}`;
  return u.verify ? ' · competitive lane split unverified' : '';
}

function renderFilters() {
  const avail = (fn) => db.all.filter((h) => fn(h) && !draft.usedBy(h.id)).length;
  const chip = (role, label, n) => `<button class="chip" data-act="role" data-role="${role}" aria-pressed="${ui.role === role}">${label}${n != null ? `<span class="n">${n}</span>` : ''}</button>`;
  $('roleFilters').innerHTML = [
    ctx.full.length ? chip('rec', 'Recommended') : '',
    chip('all', 'All', avail(() => true)),
    ...ROLES.map((r) => chip(r, ROLE_NAME[r], avail((h) => h.lanes.includes(r)))),
  ].join('');
  $('poolFilter').setAttribute('aria-pressed', String(ui.poolOnly));
  if (ui.role === 'rec' && !ctx.full.length) ui.role = 'all';
}

function renderGrid() {
  renderFilters();
  const recIds = recommendedIds();
  const list = visibleHeroes();
  const nextId = ui.q ? list.find((h) => !draft.usedBy(h.id))?.id : null; // what Enter would select
  const just = ui.justUsed;
  const tile = (h) => {
    const usage = draft.usedBy(h.id);
    const selectable = usage && usage.type === 'ban' && draft.canAct(h.id).ok; // blind wave: double ban still possible
    const used = selectable ? null : usage;
    const st = profile.stars(h.id);
    const m = meta.get(h.id);
    const tip = `${h.name} · ${h.lanes.map((l) => ROLE_NAME[l]).join(' / ')}${m ? ` · ${Math.round(m.presence * 100)}% presence` : ''}${st ? ` · ${starStr(st)}` : ''}${h.provisional ? ' · provisional profile' : ''}${usageNote(h)} — right-click to add/remove from pool`;
    const isDouble = used && used.type === 'ban' && draft.state.bans.blue.includes(h.id) && draft.state.bans.red.includes(h.id);
    const usedLbl = used ? (used.type === 'ban' ? (isDouble ? 'Double ban' : 'Banned') : used.side === ctx.allySide ? 'Your pick' : 'Enemy pick') : '';
    const usedCls = used ? (used.type === 'ban' ? 'u-ban' : used.side === ctx.allySide ? 'u-ally' : 'u-enemy') : '';
    return `<button role="listitem" class="tile ${used ? 'used ' + usedCls : ''} ${used && h.id === just ? 'just-used' : ''} ${!used && recIds.has(h.id) ? 'is-rec' : ''} ${h.id === nextId ? 'is-next' : ''}" data-act="hero" data-id="${h.id}" title="${esc(tip)}" ${used ? 'aria-disabled="true"' : ''}>
      <span class="tile-pt">${portrait(h, 'pt-tile')}${st ? '<span class="pool-star" aria-label="In your pool">★</span>' : ''}${used ? `<span class="used-tag">${usedLbl}</span>` : selectable ? `<span class="used-tag blind">${usage.side === ctx.allySide ? 'Your ban' : 'Their ban'} · hidden</span>` : ''}</span>
      <span class="tile-name">${esc(h.name)}</span>
      <span class="tile-meta">${roleDot(h.primaryLane)}${h.lanes.map((l) => ROLE_NAME[l]).join(' · ')}${m && m.presence >= 0.05 ? `<em>${Math.round(m.presence * 100)}%</em>` : ''}</span>
    </button>`;
  };
  const empty = `<p class="empty-msg">No heroes match${ui.q ? ` “${esc(ui.q)}”` : ''}${ui.poolOnly ? ' in your pool' : ''}.</p>`;
  if (ui.poolOnly && !ui.q && ui.role !== 'rec') {
    const groups = poolGroups();
    $('grid').innerHTML = groups.map((g) => `
      <div class="pool-group-head ${g.focus ? 'focus' : ''} ${g.open ? '' : 'filled'}">
        ${roleDot(g.role)}<b>${ROLE_NAME[g.role]}</b>
        <span>${g.focus ? 'Drafting now' : g.open ? 'Open' : 'Filled'}</span>
      </div>${g.heroes.length ? g.heroes.map(tile).join('') : `<p class="pool-empty">No ${ROLE_NAME[g.role]} heroes in your pool yet. Right-click a hero to add one.</p>`}`).join('') || `<p class="empty-msg">Your pool is empty${ROLES.includes(ui.role) ? ` for ${ROLE_NAME[ui.role]}` : ''}. Right-click any hero or use My pool to add some.</p>`;
  } else {
    $('grid').innerHTML = list.map(tile).join('') || empty;
  }
  ui.justUsed = null;
}

// ------------------------------------------------------------------ coach

function needList(needs, max = 3) {
  const shown = needs.filter((n) => n.pressure >= 0.3).slice(0, max);
  return shown.length ? `<ol class="nlist">${shown.map((n) => `<li>${esc(n.label)}</li>`).join('')}</ol>` : '<span class="faint">No major gaps</span>';
}

function threatList(team, max = 3) {
  const th = (team.threats || []).slice(0, max);
  if (!th.length) return team.n ? '<span class="faint">No standout threat yet</span>' : '<span class="faint">Unknown until the enemy picks</span>';
  return `<ol class="nlist">${th.map((t) => `<li>${esc(t.label)}<span class="sub">${esc(t.heroes.join(', '))}</span></li>`).join('')}</ol><span class="sub">Response: ${esc(th[0].response)}</span>`;
}

function compRows(ally) {
  if (!ally.n) return '';
  let out = row('Our composition', ally.primary ? `${esc(ally.primary.label)}${ally.secondary ? `<span class="sub">Secondary: ${esc(ally.secondary.label)}</span>` : ''}` : '—');
  if (ally.win) {
    out += row('Win condition', `${esc(ally.win.primary)}<span class="sub">Required: ${esc(ally.win.required)}</span>`);
    out += row('Failure condition', esc(ally.win.failure));
  }
  return out;
}

function needText(needs, max = 2) {
  const shown = needs.filter((n) => n.pressure >= 0.3).slice(0, max);
  return shown.length ? shown.map((n) => esc(n.label)).join('<span class="and"> · </span>') : '<span class="faint">No major gaps</span>';
}

function needBars(team) {
  if (!team.n) return '<p class="hint">No picks yet.</p>';
  const rows = team.needs.slice(0, 6);
  if (!rows.length) return '<p class="hint">Structurally complete.</p>';
  return `<div class="bars">${rows.map((n) => `<div class="bar"><span>${esc(n.label)}</span><i><b style="width:${Math.round(n.pressure * 100)}%"></b></i></div>`).join('')}</div>`;
}

const row = (label, html, cls = '') => `<div class="crow ${cls}"><span class="clabel">${label}</span><div class="cval">${html}</div></div>`;

function identityLine(h, form) {
  const lanes = [`${ROLE_NAME[h.primaryLane]} primary`, ...h.lanes.slice(1).map((l) => `${ROLE_NAME[l]} flex`)].join(', ');
  const fns = (form?.functions || h.functions).slice(0, 4).join(' · ');
  return `${esc(h.cls.join(' / '))} · ${lanes}${fns ? `<br>${esc(fns)}` : ''}`;
}

function myDraftCard() {
  const g = ctx.guide;
  const role = me.role;
  const pool = role ? profile.entries(role).map((e) => db.get(e.id)).filter(Boolean).sort((a, b) => profile.stars(b.id, role) - profile.stars(a.id, role)) : [];
  const others = role ? db.all.filter((h) => h.lanes.includes(role) && !pool.includes(h)) : db.all;
  const opt = (h) => `<option value="${h.id}" ${me.hero === h.id ? 'selected' : ''}>${esc(h.name)}${role && profile.stars(h.id, role) ? ` ${'★'.repeat(profile.stars(h.id, role))}` : ''}</option>`;
  const job = g.status === 'ready' ? esc(g.functionLabel) : g.status === 'no-hero' ? 'Choose your hero' : 'Set your role';
  const sug = ctx.mySuggestion;
  return `<div class="mycard">
    <div class="my-head"><span class="clabel">My draft</span>${me.heroSource === 'auto' ? '<span class="pill quiet">auto-detected</span>' : ''}</div>
    <div class="my-row">
      <label><span>Role</span><select data-my="role" class="select sm" aria-label="My role">
        <option value="">Not set</option>${ROLES.map((r) => `<option value="${r}" ${role === r ? 'selected' : ''}>${ROLE_NAME[r]}</option>`).join('')}
      </select></label>
      <label><span>Hero</span><select data-my="hero" class="select sm" aria-label="My hero">
        <option value="">Undecided</option>
        ${pool.length ? `<optgroup label="My ${role ? ROLE_NAME[role] : ''} pool">${pool.map(opt).join('')}</optgroup>` : ''}
        <optgroup label="${role ? `Other ${ROLE_NAME[role]} heroes` : 'All heroes'}">${others.map(opt).join('')}</optgroup>
      </select></label>
    </div>
    <div class="my-job"><span class="clabel">Draft job</span><b>${job}</b></div>
    ${sug ? `<p class="hint">Suggested for you: <button class="inline-hero" data-act="hero" data-id="${sug.hero.id}">${esc(sug.hero.name)}</button> · ${sug.score.toFixed(1)} draft fit${sug.stars ? ` · ${'★'.repeat(sug.stars)}` : ''}</p>` : ''}
    ${g.status !== 'no-role' ? `<button class="link" data-act="personal" aria-expanded="${!!ui.personal}">${ui.personal ? 'Hide personal guide' : 'View personal guide'} <span aria-hidden="true">${ui.personal ? '↑' : '→'}</span></button>` : ''}
    ${ui.personal ? personalGuideHTML(g) : ''}
  </div>`;
}

function personalGuideHTML(g, { full = false } = {}) {
  if (g.status === 'no-role') return `<p class="hint">${esc(g.message)}</p>`;
  const blocks = (full ? g.roleBlocks : g.roleBlocks.slice(0, 5)).map((b) => `<div class="pg-row"><span>${esc(b.label)}</span><p>${esc(b.text)}</p></div>`).join('');
  if (g.status === 'no-hero') {
    return `<div class="pguide"><p class="pg-title">${esc(g.title)}</p><p class="hint">${esc(g.job)}</p>${blocks}</div>`;
  }
  return `<div class="pguide">
    <p class="pg-title">${esc(g.title)}${g.inTeam ? '' : ' <span class="pill quiet">not picked yet</span>'}</p>
    ${g.fit.level !== 'good' ? `<p class="pg-fit ${g.fit.level}">${esc(g.fit.note)}</p>` : ''}
    <div class="pg-row"><span>Your job</span><p>${esc(g.job)}</p></div>
    <div class="pg-row"><span>What to do</span><p>${esc(g.todo)}</p></div>
    <div class="pg-row"><span>What to watch</span><p>${esc(g.watch)}</p></div>
    <div class="pg-row"><span>Key synergies</span><p>${esc(g.synergies)}</p></div>
    <div class="pg-row"><span>Avoid</span><p>${esc(g.avoid)}</p></div>
    <p class="pg-sub">${esc(ROLE_NAME[g.role])} plan</p>
    ${blocks}
  </div>`;
}

function ratingHTML(r, cls = '') {
  if (!r) return '';
  return `<div class="rating t-${r.tone} ${cls}">
    <span class="clabel">Draft rating</span>
    <b>${r.rating.toFixed(1)}<small> / 10</small></b>
    <span class="r-label">${esc(r.label)}</span>
  </div>`;
}

function renderCoach() {
  const el = $('coach');
  const { A, recs, step, complete } = ctx;
  const ally = A.ally;
  const enemy = A.enemy;
  const close = '<button class="btn quiet icon coach-close" data-act="coach-close" aria-label="Close draft coach">✕</button>';

  if (complete && !step?.manual && !ui.showGrid) { el.innerHTML = ''; return; } // the report owns this screen
  if (complete && !step?.manual) {
    const rep = postDraftReport(A);
    el.innerHTML = `<div class="coach-head"><h2>Draft coach</h2>${close}</div>
      <p class="hint">Draft complete. The full game plan is in the main panel.</p>
      ${ratingHTML(ctx.rating, 'compact')}
      ${row('Your role', ctx.guide.status === 'ready' ? `${esc(ctx.guide.title)}<span class="sub">${esc(ctx.guide.functionLabel)}</span>` : '<span class="faint">Set My role below</span>')}
      ${row('Key threat', rep.threat ? esc(rep.threat.label) : '—')}
      ${row('Priority objective', esc(rep.priorityObjective?.name || '—'))}
      <button class="btn wide primary" data-act="view-guide">Back to the full report</button>
      ${myDraftCard()}`;
    return;
  }

  const isAlly = recs?.isAlly;
  const top = ctx.list[0];
  const theoryTop = recs?.kind === 'pick' && recs.isAlly ? recs.theoretical[0] : null;
  const ctxLine = step ? (step.manual ? 'Editing a slot' : `${step.phaseLabel} · ${isAlly ? 'your' : 'enemy'} ${step.type}`) : '';
  let body = '';

  if (recs?.kind === 'pick' && isAlly) {
    const open = draft.openRoles(ctx.allySide);
    const advice = open.map((r) => ({ r, n: roleFunction(r, ally, db) })).filter((x) => x.n);
    const best = top ? advice.find((x) => x.r === top.role) || advice[0] : advice[0];
    body += row('Team need', ally.n ? needList(ally.needs) : '<span class="faint">Open. Set your identity with a flexible, high-priority pick.</span>', 'primary');
    body += row('Enemy threat', threatList(enemy));
    const focus = ally.needs.filter((n) => n.pressure >= 0.3).slice(0, 2).map((n) => n.short);
    body += row('Best action', !ally.n ? 'Secure a flexible, high-priority hero'
      : focus.length ? `Prioritize ${esc(focus.join(' / '))}${best ? `<span class="sub">${ROLE_NAME[best.r]} is the slot to fill</span>` : ''}`
        : top ? `Best available ${ROLE_NAME[top.role]}` : '—');
    if (top) {
      body += `<div class="pickcard">
        <span class="clabel">Recommended ${ctx.roleRec ? `${ROLE_NAME[ctx.roleRec.role]} pick · best overall` : `pick${ui.recTab === 'you' && !ctx.forYouEmpty ? ' · your pool' : ''}`}</span>
        <button class="pick-hero" ${ctx.roleRec ? `data-act="role-pick" data-role="${ctx.roleRec.role}"` : 'data-act="hero"'} data-id="${top.hero.id}">
          ${portrait(top.hero, 'pt-coach')}
          <span><b>${esc(top.hero.name)}</b><small>${ROLE_NAME[top.role]}${top.form ? ` · ${esc(top.form.label)}` : ''}</small></span>
          <span class="score ${top.score >= 7 ? 's-hi' : top.score >= 5 ? 's-mid' : 's-lo'}"><b>${top.score.toFixed(1)}</b><small>Draft fit</small></span>
        </button>
        <p>${esc(top.reasons.slice(0, 2).join('. '))}.</p>
        ${(() => {
          const rr = ctx.roleRec;
          const v1 = ui.recTab === 'you' && !ctx.forYouEmpty ? recs.v1?.mine : recs.v1?.theory;
          const be = rr?.board.entries || [];
          const safeE = be.find((x) => x.flags.safe && x.hero.id !== top.hero.id);
          const alt = rr ? safeE && { ...safeE, score: safeE.fit } : v1?.alternative && v1.alternative.hero.id !== top.hero.id ? v1.alternative : null;
          const ctr = rr ? be.find((x) => x.flags.counter && x.hero.id !== top.hero.id) : v1?.counterPick && v1.counterPick.hero.id !== top.hero.id ? v1.counterPick : null;
          const bits = [alt && `${rr ? 'Safe' : 'Alternative'}: ${esc(alt.hero.name)} (${alt.score.toFixed(1)})`, ctr && `Counter pick: ${esc(ctr.hero.name)}`].filter(Boolean);
          return bits.length ? `<p class="hint">${bits.join(' · ')}</p>` : '';
        })()}
        ${top.risks.length ? `<p class="risk">${esc(top.risks.join(' · '))}</p>` : ''}
        ${(() => {
          const c = ctx.contrast;
          if (ctx.roleRec) return ctx.roleRec.board.forYouNote && ctx.roleRec.board.bestForYou !== ctx.roleRec.board.bestOverall ? `<p class="hint">${esc(ctx.roleRec.board.forYouNote)}</p>` : '';
          if (c && ui.recTab === 'you' && !ctx.forYouEmpty) {
            const compelling = c.gap >= 1.5 ? `<p class="hint">Compelling outside-pool option: <b>${esc(c.theory)}</b> (+${c.gap.toFixed(1)} draft fit).</p>` : '';
            return `<p class="hint">Best overall: <b>${esc(c.theory)}</b>${c.forTheory.length ? ` (${esc(c.forTheory.slice(0, 2).join(', '))})` : ''}. ${esc(c.mine)} for you: ${esc(c.forMine.slice(0, 3).join(', '))}.</p>${compelling}`;
          }
          return theoryTop && theoryTop.hero.id !== top.hero.id ? `<p class="hint">Best overall: ${esc(theoryTop.hero.name)} (${theoryTop.score.toFixed(1)})</p>` : '';
        })()}
      </div>`;
    }
    body += compRows(ally);
  } else if (recs?.kind === 'ban') {
    body += row(isAlly ? 'Ban plan' : 'Enemy ban', isAlly ? 'Remove what the enemy wants most: contested meta heroes and answers to your picks.' : 'Expect contested meta heroes and your comfort picks to go.', 'primary');
    if (top) body += row(isAlly ? 'Top ban' : 'Most likely', `${esc(top.hero.name)}<span class="sub">${esc(top.reasons.join(' · '))}</span>`);
    body += row('Enemy threat', threatList(enemy));
    body += compRows(ally);
  } else if (recs?.kind === 'pick') {
    body += row('Enemy is picking', top ? `Likely ${ctx.list.slice(0, 3).map((r) => esc(r.hero.name)).join(', ')}` : '—', 'primary');
    body += row('Enemy needs', enemy.n ? needText(enemy.needs) : '<span class="faint">Not enough information yet</span>');
    body += row('Your next need', ally.n ? needText(ally.needs) : '<span class="faint">Open</span>');
    body += compRows(ally);
  }

  let deep = '';
  if (ui.deep) {
    const open = draft.openRoles(ctx.allySide);
    const roleLines = open.map((r) => { const n = roleFunction(r, ally, db); return `<li><b>${ROLE_NAME[r]}</b> ${n ? esc(n.label) : 'Best available or comfort pick'}</li>`; }).join('');
    const BAN_LABEL = { banRate: 'Ban rate', enemyFit: 'Fits the enemy', threatToUs: 'Threat to your picks', ownPool: 'In your pool (penalty)' };
    const parts = top?.scores ? Object.entries(top.scores).filter(([k]) => top.weights[k]).map(([k, v]) => `<div class="bar"><span>${COMPONENT_LABEL[k] || BAN_LABEL[k] || k} <b class="cv">${(v * 10).toFixed(1)}</b> <em>×${Math.round(Math.abs(top.weights[k]) * 100)}%</em></span><i><b style="width:${Math.round(v * 100)}%"></b></i></div>`).join('') : '';
    const items = itemization(ally, enemy);
    deep = `<div class="deep">
      ${top && recs?.kind === 'pick' ? `<h3>${esc(top.hero.name)}</h3><p class="hint">${identityLine(top.hero, top.form)}</p>${meta.usage(top.hero.id)?.verify ? '<p class="hint">MPL S18 lane usage unverified; needs draft-slot data.</p>' : ''}` : ''}
      ${parts ? `<h3>Score breakdown</h3><div class="bars">${parts}</div>` : ''}
      <h3>Your gaps</h3>${needBars(ally)}
      ${open.length ? `<h3>What each open role should bring</h3><ul class="plain">${roleLines}</ul>` : ''}
      ${ally.win ? `<h3>Win condition</h3><p>${esc(ally.win.primary)}</p>${ally.win.secondary ? `<p class="hint">${esc(ally.win.secondary)}</p>` : ''}<p class="hint">${esc(ally.win.key)}</p>` : ''}
      <h3>Enemy gaps</h3>${needBars(enemy)}
      ${historyList()}
      ${items.length ? `<h3>Itemization watch</h3><ul class="plain">${items.map((i) => `<li><b>${esc(i.title)}</b> ${esc(i.text)}</li>`).join('')}</ul>` : ''}
    </div>`;
  }

  el.innerHTML = `
    <div class="coach-head"><h2>Draft coach</h2>${close}</div>
    <p class="hint">${esc(ctxLine)}</p>
    ${myDraftCard()}
    <div class="crows">${body}</div>
    <button class="link" data-act="deep" aria-expanded="${ui.deep}">${ui.deep ? 'Hide analysis' : 'View analysis'} <span aria-hidden="true">${ui.deep ? '↑' : '→'}</span></button>
    ${deep}
    <p class="meta-src ${meta.hasData ? '' : 'nodata'}">${meta.hasData ? `Meta: ${esc(meta.source)} · ${meta.drafts} drafts` : 'No meta data loaded. Meta is not used in scoring.'}</p>`;
}

function actionLabel(a) {
  const h = a.heroId && db.get(a.heroId);
  const who = a.side ? (a.side === ctx.allySide ? 'you' : 'enemy') : '';
  switch (a.kind) {
    case 'ban': return a.noBan ? `No ban${who ? ` (${who})` : ''}` : `Ban — ${h?.name}${who ? ` (${who})` : ''}`;
    case 'bracket': return `Bracket — ${draft.format.def.brackets?.[a.key]?.label || a.key}`;
    case 'pick': return `Pick ${a.order || ''} — ${h?.name}${a.key ? ` · ${ROLE_NAME[a.key]}` : ''}${who ? ` (${who})` : ''}`;
    case 'role': return `Role — ${h?.name} → ${ROLE_NAME[a.key]}`;
    case 'role-auto': return `Role — ${h?.name} back to auto`;
    case 'remove': return `Removed — ${h?.name || 'slot'}`;
    case 'swap': return `Swapped ${ROLE_NAME[a.key]} ↔ ${ROLE_NAME[a.key2]}`;
    case 'reset': return 'Reset draft';
    case 'format': return `Format — ${draft.formats[a.key]?.label}`;
    case 'side': return `Switched to ${sideName(a.side)}`;
    default: return a.kind;
  }
}

function historyList() {
  const log = draft.log();
  if (!log.length) return '';
  return `<h3>Draft history</h3><ol class="history">${log.map((a) => `<li>${esc(actionLabel(a))}</li>`).join('')}</ol>`;
}

// ------------------------------------------------------------------ post-draft

/** Compact My role / My hero selectors (same ids as the live-draft card; only one is ever on screen). */
function mySelects() {
  const role = me.role;
  const pool = role ? profile.entries(role).map((e) => db.get(e.id)).filter(Boolean).sort((x, y) => profile.stars(y.id, role) - profile.stars(x.id, role)) : [];
  const others = role ? db.all.filter((h) => h.lanes.includes(role) && !pool.includes(h)) : db.all;
  const opt = (h) => `<option value="${h.id}" ${me.hero === h.id ? 'selected' : ''}>${esc(h.name)}${role && profile.stars(h.id, role) ? ` ${'★'.repeat(profile.stars(h.id, role))}` : ''}</option>`;
  return `<span class="rp-selects">
    <select data-my="role" class="select sm" aria-label="My role"><option value="">Role…</option>${ROLES.map((r) => `<option value="${r}" ${role === r ? 'selected' : ''}>${ROLE_NAME[r]}</option>`).join('')}</select>
    <select data-my="hero" class="select sm" aria-label="My hero"><option value="">Hero…</option>${pool.length ? `<optgroup label="My pool">${pool.map(opt).join('')}</optgroup>` : ''}<optgroup label="${role ? `${ROLE_NAME[role]} heroes` : 'All heroes'}">${others.map(opt).join('')}</optgroup></select>
  </span>`;
}

/** ROLE MATCHUP: what each role's hero gives its team in THIS draft (not a 1v1 claim). */
function roleMatchupHTML(M) {
  if (!M) return '';
  const cell = (label, row, who) => `<div class="rm-c"><span class="snap-l">${label}</span>${row ? `<b>${roleDot(row.role)}${ROLE_NAME[row.role]}</b><small>${esc((who === 'them' ? row.them : row.us).name)}</small>` : '<b class="faint">None</b>'}</div>`;
  const sign = (e) => (e > 0 ? `+${e.toFixed(1)}` : e < 0 ? `−${Math.abs(e).toFixed(1)}` : '0.0');
  return `<div class="rm" aria-label="Role matchup">
    <h3 class="rm-h">Role matchup <span class="hint">what each role's hero is worth to its team in this draft</span></h3>
    <div class="rm-sum">${cell('Our strongest role', M.strongest, 'us')}${cell('Enemy strongest role', M.enemyStrongest, 'them')}${cell('Biggest disadvantage', M.disadvantage, 'us')}${cell('Decisive role', M.decisive, 'us')}</div>
    <p class="rm-line">${esc(M.sentence)}</p>
    <div class="rm-t">${M.rows.map((x) => `<div class="rm-r e-${x.tone}" title="${esc(x.evidence.join(' · '))}">
      <span class="rm-role">${roleDot(x.role)}${ROLE_NAME[x.role]}</span>
      <span class="rm-h1">${portrait(x.us, 'pt-chip')}<b>${esc(x.us.name)}</b></span>
      <span class="rm-edge"><b>${sign(x.edge)}</b><small>${esc(x.label)}</small></span>
      <span class="rm-h2"><b>${esc(x.them.name)}</b>${portrait(x.them, 'pt-chip')}</span>
      <span class="rm-why">${esc(x.reason)}</span></div>`).join('')}</div>
  </div>`;
}

/** ITEMIZATION PRIORITIES (inside Your role): traits, at most three catalog items, a warning when it matters. */
function itemsHTML(I) {
  if (!I) return '';
  const stars = (n) => `<span class="stars">${'★'.repeat(n)}<span class="off">${'★'.repeat(5 - n)}</span></span>`;
  return `<div class="itm" aria-label="Itemization priorities">
    <h3 class="rm-h">Itemization priorities <span class="hint">what this enemy draft makes you adapt around, not a full build</span></h3>
    ${I.traits.length ? `<div class="itm-traits">${I.traits.map((t) => `<span class="itm-t" title="${esc(t.evidence)}">${esc(t.label)} ${stars(t.stars)}</span>`).join('')}</div>` : ''}
    ${I.items.length ? `<ol class="itm-list">${I.items.map((x) => `<li>
        <div class="itm-h"><b>${esc(x.item.name)}</b><span class="faint">${esc(x.label)}</span>${`<span class="prio p-${x.priority.toLowerCase()}">${x.priority}</span>`}</div>
        <p>${esc(x.why)}</p><p class="itm-when"><span>Buy when</span> ${esc(x.when)}</p></li>`).join('')}</ol>` : `<p class="itm-none">${esc(I.none)}</p>`}
    ${I.warning ? `<p class="itm-warn">⚠ ${esc(I.warning)}</p>` : ''}
    ${I.catalogVersion ? `<p class="itm-src">Item catalog ${esc(I.catalogVersion)} · check in-game details after a patch</p>` : ''}
  </div>`;
}

/** COACHING LAB: scan (snapshot + 30-second plan) → understand (modules) → drill down (Deep Analysis). */
function renderPostDraft() {
  const el = $('postdraft');
  const show = ctx.complete && !ctx.step?.manual && !ui.showGrid;
  el.hidden = !show;
  $('grid').hidden = show;
  $('filterbar').hidden = show;
  if (!show) { el.innerHTML = ''; return; } // never leave a second rating / selector set in the DOM
  const R = ctx.analysis;
  const r = ctx.rating;
  if (!R) { el.innerHTML = '<p class="empty-msg">Not enough information to analyze this draft.</p>'; return; }
  const P = R.personal;
  const ev = (list) => (list?.length ? `<details class="ev"><summary>Evidence</summary><ul>${list.map((x) => `<li>${esc(x)}</li>`).join('')}</ul></details>` : '');
  const bar = (v, cls = '') => `<i class="mbar ${cls}"><b style="width:${Math.round(v * 100)}%"></b></i>`;
  const cur = (c, cls) => ['early', 'mid', 'late'].map((k) => `<div class="cb"><span>${cap(k)}</span>${bar(c[k], cls)}</div>`).join('');
  const prio = (x) => `<span class="prio p-${x.toLowerCase()}">${x}</span>`;
  const heroChip = (h, sub = '') => `<span class="hchip">${portrait(h, 'pt-chip')}<span><b>${esc(h.name)}</b>${sub ? `<small>${esc(sub)}</small>` : ''}</span></span>`;
  const plan = R.plan;
  const fit = ctx.guide.status === 'ready' && P && ctx.guide.hero === P.hero.id ? ctx.guide.fit : null;
  const fitTone = { good: 'good', ok: 'warn', poor: 'bad' };
  const canEdit = !ui.readonly;

  // ---- per-pick sub-scores, vectors and evidence for Deep Analysis
  const KEYS = ['frontline', 'engage', 'peel', 'antiDive', 'burst', 'sustainedDamage', 'backlineAccess', 'pickoff', 'poke', 'disruption', 'objectiveControl', 'earlyPressure', 'scaling', 'protection'];
  const LBL = { frontline: 'Frontline', engage: 'Engage', peel: 'Peel', antiDive: 'Anti-dive', burst: 'Burst', sustainedDamage: 'Sustained dmg', backlineAccess: 'Backline access', pickoff: 'Pickoff', poke: 'Poke', disruption: 'Crowd control', objectiveControl: 'Objectives', earlyPressure: 'Early', scaling: 'Scaling', protection: 'Protection' };
  const av = R.analysis.ally.vector; const evv = R.analysis.enemy.vector;
  const deep = `<details class="deep-lab"><summary><span class="snap-l">Deep analysis</span> Sub-scores, composition vectors, evidence, counters, meta and player fit</summary>
    <div class="dl-grid">
      <div><h4>Per-pick sub-scores (final context, 0–10)</h4>
        <table class="dl-t"><thead><tr><th>Hero</th>${COMPONENTS.map((k) => `<th title="${esc(COMPONENT_LABEL[k])}">${esc(COMPONENT_LABEL[k].split(' ')[0])}</th>`).join('')}</tr></thead>
        <tbody>${(r?.perPick || []).map((x) => `<tr><td>${esc(db.get(x.hero).name)} <small>${ROLE_NAME[x.role]}</small></td>${COMPONENTS.map((k) => `<td>${(x.scores[k] * 10).toFixed(1)}</td>`).join('')}</tr>`).join('')}</tbody></table>
        <h4>Draft rating components</h4>
        <table class="dl-t"><tbody>${Object.entries(r?.components || {}).filter(([, v]) => v != null).map(([k, v]) => `<tr><td>${esc(k.replace(/([A-Z])/g, ' $1').toLowerCase())}</td><td>${(v * 10).toFixed(1)}</td><td><small>weight ${Math.round((r.weights[k] || 0) * 100)}%</small></td></tr>`).join('')}</tbody></table>
      </div>
      <div><h4>Composition vectors (function units)</h4>
        <table class="dl-t"><thead><tr><th>Function</th><th>Us</th><th>Enemy</th><th></th></tr></thead>
        <tbody>${KEYS.map((k) => `<tr><td>${LBL[k]}</td><td>${av[k].toFixed(2)}</td><td>${evv[k].toFixed(2)}</td><td class="${av[k] - evv[k] >= 0.4 ? 'up' : evv[k] - av[k] >= 0.4 ? 'down' : ''}">${av[k] - evv[k] >= 0 ? '+' : ''}${(av[k] - evv[k]).toFixed(2)}</td></tr>`).join('')}</tbody></table>
        <h4>Team needs left open</h4>
        <ul class="plain">${R.analysis.ally.needs.slice(0, 5).map((n) => `<li>${esc(n.label)} <small>pressure ${n.pressure}</small></li>`).join('') || '<li>None</li>'}</ul>
      </div>
      <div><h4>Evidence behind the conclusions</h4>
        <dl class="dl-ev">
          <dt>Verdict</dt><dd>${R.verdict.evidence.map(esc).join(' · ')}</dd>
          <dt>Key clash</dt><dd>${R.clash.evidence.map(esc).join(' · ')}</dd>
          <dt>Win condition</dt><dd>${R.win.primary.evidence.map(esc).join(' · ')}</dd>
          <dt>Power curve</dt><dd>${R.power.implication.evidence.map(esc).join(' · ')}</dd>
          <dt>Targets</dt><dd>${R.targets.evidence.map(esc).join(' · ')}</dd>
          <dt>Strengths / weaknesses</dt><dd>${[...R.strengths, ...R.weaknesses].flatMap((x) => x.evidence).map(esc).join(' · ')}</dd>
        </dl>
        <h4>Meta and player fit</h4>
        <ul class="plain">${R.roles.map((x) => { const m = meta.get(x.hero.id); const st = profile.stars(x.hero.id, x.role); return `<li>${esc(x.hero.name)} <small>${m ? `${Math.round(m.presence * 100)}% presence${m.picks >= 10 && m.winRate != null ? ` · ${Math.round(m.winRate * 100)}% win` : ''}` : 'no meta data'}${st ? ` · ${'★'.repeat(st)}` : ''}</small></li>`; }).join('')}</ul>
      </div>
    </div>
  </details>`;

  el.innerHTML = `
  <article class="lab" aria-label="Post-draft coaching lab">
    <header class="lab-snap">
      ${ratingHTML(r, 'hero')}
      <div class="ls-c"><span class="snap-l">Our identity</span><b class="ally">${esc(R.analysis.ally.compLabel)}</b><small>${esc(R.identity.ally.curve)}</small></div>
      <div class="ls-c"><span class="snap-l">Enemy identity</span><b class="enemy">${esc(R.analysis.enemy.compLabel)}</b><small>${esc(R.identity.enemy.curve)}</small></div>
      <div class="ls-c ls-q"><span class="snap-l">Key clash</span><b>${esc(R.clash.question)}</b></div>
      <div class="ls-act">${canEdit ? '<button class="btn quiet sm" data-act="show-grid">Edit draft</button>' : ''}<button class="btn sm" data-act="share-final">Share final draft</button></div>
      <p class="ls-verdict">${esc(R.verdict.text)} <span class="faint">Draft rating measures composition quality and fit, not win probability.</span></p>
    </header>

    <section class="plan" aria-label="30-second plan">
      <h2 class="lab-h">30-second plan</h2>
      <div class="plan-g">
        <div><span class="snap-l">Our win condition</span><b>${esc(plan.win)}</b></div>
        <div class="t-bad"><span class="snap-l">Biggest threat</span><b>${esc(plan.threat)}</b></div>
        <div class="pl-job"><span class="snap-l">Your job</span>${plan.job ? `${heroChip(plan.job.hero, plan.job.function)}<p>${esc(plan.job.line)}</p>` : `<p class="hint">${ui.readonly ? 'The host has not set a hero.' : 'Choose your role and hero below.'}</p>`}</div>
        <div><span class="snap-l">First target</span>${plan.target ? `${heroChip(plan.target.hero, plan.target.short)}` : '—'}</div>
        <div><span class="snap-l">First objective</span><b>${plan.objective ? `${esc(plan.objective.name)} ${prio(plan.objective.priority)}` : '—'}</b></div>
        <div class="t-warn"><span class="snap-l">Don't</span><b>${esc(plan.dont)}</b></div>
      </div>
    </section>

    <section class="lab-sec">
      <h2 class="lab-h">Draft matchup <span class="hint">${esc(R.clash.pair)}</span></h2>
      <div class="mu">
        ${['ally', 'enemy'].map((side) => { const x = R.identity[side]; return `<div class="mu-side ${side}"><span class="snap-l">${side === 'ally' ? 'Our draft' : 'Enemy draft'}</span><h3>${esc(x.primary)}</h3>
          <dl><div><dt>Secondary</dt><dd>${esc(x.secondary || '—')}</dd></div><div><dt>Power curve</dt><dd>${esc(x.curve)}</dd></div><div class="w"><dt>Preferred fight</dt><dd>${esc(x.fight)}</dd></div></dl></div>`; }).join('<span class="vs" aria-hidden="true">vs</span>')}
      </div>
      <div class="won-g">
        <div><span class="snap-l c-ally">Our win condition</span><p>${esc(R.win.primary.text)}</p></div>
        <div><span class="snap-l c-enemy">Enemy win condition</span><p>${esc(R.win.enemy.text)}</p></div>
        <div class="won-d"><span class="snap-l">Decisive factor</span><p>${esc(R.clash.decisive)}</p></div>
      </div>
      ${roleMatchupHTML(R.roleMatchup)}
      <details class="more-clash"><summary>Why: the key clash, secondary route and failure condition</summary>
        <p class="mu-clash">${esc(R.clash.decider)}</p>
        ${R.clash.points.length ? `<ul class="mu-pts">${R.clash.points.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>` : ''}
        <p class="mu-sub"><b>Secondary route:</b> ${esc(R.win.secondary.text)} <b>We lose if:</b> ${esc(R.win.failure.text)}</p>
      </details>
    </section>

    <section class="lab-sec trio">
      <div class="m-power"><h2 class="lab-h">Power curve</h2>
        <div class="curves"><div><small>Us</small>${cur(R.power.ally, 'ally')}</div><div><small>Enemy</small>${cur(R.power.enemy, 'enemy')}</div></div>
        <dl class="win-d"><div><dt>Our window</dt><dd>${esc(R.window.ours || 'None: play for execution')}</dd></div><div><dt>Their window</dt><dd>${esc(R.window.theirs || 'None')}</dd></div></dl>
        <p>${esc(R.power.implication.text)}</p></div>
      <div class="m-obj"><h2 class="lab-h">Objective plan</h2>
        ${R.objectives.map((o) => `<div class="obj2"><div><b>${esc(o.name)}</b>${prio(o.priority)}</div><p>${esc(o.why)}</p></div>`).join('')}</div>
      <div class="m-tgt"><h2 class="lab-h">Target priority</h2>
        ${[['#1 target', R.targets.first], ['#2 target', R.targets.second], ["Don't prioritize", R.targets.avoid]].filter(([, t]) => t).map(([l, t], i) => `<div class="tg ${i === 2 ? 'avoid' : ''}">${portrait(t.hero, 'pt-tg')}<div><span class="snap-l">${l}</span><b>${esc(t.hero.name)}</b><p>${esc(t.short || t.why)}</p></div></div>`).join('')}</div>
    </section>

    <section class="lab-sec sw3">
      <div class="sw-row"><span class="snap-l">Strengths</span>${R.strengths.slice(0, 3).map((x) => `<span class="swc good" title="${esc(x.evidence.join(' · '))}">✓ ${esc(x.text)}${x.detail ? `<small>${esc(x.detail)}</small>` : ''}</span>`).join('') || '<span class="faint">No standout strength</span>'}</div>
      <div class="sw-row"><span class="snap-l">Weaknesses</span>${R.weaknesses.slice(0, 3).map((x) => `<span class="swc bad" title="${esc(x.evidence.join(' · '))}">⚠ ${esc(x.text)}${x.detail ? `<small>${esc(x.detail)}</small>` : ''}</span>`).join('') || '<span class="faint">No structural weakness</span>'}</div>
      ${R.weaknesses.length ? `<p class="sw-comp"><span class="snap-l">Compensation</span>${esc(R.compensate)}</p>` : ''}
    </section>

    <section class="lab-sec you" id="your-role">
      <h2 class="lab-h">${ui.readonly ? "Host's role" : 'Your role'}</h2>
      ${P ? `<div class="you-g">
        <div class="you-hero">${portrait(P.hero, 'pt-you')}<div><span class="snap-l">${ROLE_NAME[P.role]}</span><b>${esc(P.hero.name)}</b>${fit ? `<span class="pill ${fitTone[fit.level]}">Hero fit: ${esc(fit.label)}</span>` : ''}</div></div>
        <dl class="you-dl">
          <div class="w"><dt>Function</dt><dd class="big">${esc(P.function)}</dd></div>
          <div class="w"><dt>Your job</dt><dd>${esc(P.job)}</dd></div>
          <div><dt>Priority target</dt><dd>${P.target ? `<b>${esc(P.target.hero)}</b>` : '—'}</dd></div>
          <div><dt>Best timing</dt><dd>${esc(P.timing || '—')}</dd></div>
          <div><dt>Avoid</dt><dd>${esc(P.avoid)}</dd></div>
          <div class="w"><dt>Why you matter</dt><dd>${esc(P.whyYouMatter || '—')}</dd></div>
        </dl>
      </div>
      <details class="you-more"><summary>What enables and limits ${esc(P.hero.name)}</summary>
        <dl class="you-dl"><div><dt>What enables you</dt><dd>${esc(P.enables.join('; '))}</dd></div><div><dt>What limits you</dt><dd>${esc(P.limits.join('; '))}</dd></div></dl>
      </details>
      ${itemsHTML(P.items)}` : `<p class="hint">${ui.readonly ? 'The host has not set a role and hero.' : 'Pick your role and hero to get your job in this exact draft.'}</p>`}
      ${canEdit ? `<details class="you-edit" ${P ? '' : 'open'}><summary>Change role or hero</summary>${identityHTML({ compact: true })}</details>` : ''}
    </section>

    <section class="lab-sec">
      <h2 class="lab-h">Role breakdown</h2>
      <div class="strips">${R.roles.map((x) => `<details class="strip ${P && P.hero.id === x.hero.id ? 'me' : ''}"><summary>
          <span class="st-role">${roleDot(x.role)}${ROLE_NAME[x.role]}</span>${heroChip(x.hero)}<span class="st-fn">${esc(x.function)}</span><span class="st-job">${esc(x.job)}</span></summary>
          <div class="st-more">${x.matchup ? `<p>${esc(x.matchup)}</p>` : ''}${ev(x.evidence)}</div></details>`).join('')}</div>
    </section>

    <section class="lab-sec duo">
      <div><h2 class="lab-h">Important interactions</h2>
        ${R.interactions.map((i) => `<div class="ix t-${i.tone}"><span class="ix-h">${portrait(i.from, 'pt-chip')}<em>→</em>${portrait(i.to, 'pt-chip')}</span><div><b>${esc(i.from.name)} → ${esc(i.to.name)}</b> <span class="ix-l">${esc(i.label)}</span><p><span class="ix-a">${esc(i.advantage)}</span> · ${esc(i.todo)}</p></div></div>`).join('') || '<p class="hint">No single matchup stands out.</p>'}</div>
      <div><h2 class="lab-h">Draft swing factors</h2>
        ${R.swings.map((x) => `<div class="swing ${x.sign === '+' ? 'up' : 'down'}"><span class="sg">${x.sign}</span><div><span class="snap-l">${esc(x.kind)}</span><p>${esc(x.text)}</p></div></div>`).join('')}</div>
    </section>

    <section class="lab-sec missed">
      <h2 class="lab-h">Missed opportunity</h2>
      ${R.counterfactual.lead ? `<p class="mo-lead">${esc(R.counterfactual.lead)}</p>` : ''}
      ${R.counterfactual.options.slice(0, 1).map((o) => `<div class="mo">${portrait(o.to, 'pt-chip')}<p><span class="snap-l">Better alternative</span>${esc(o.text)}</p></div>`).join('')}
      ${R.counterfactual.note ? `<p class="hint">${esc(R.counterfactual.note)}</p>` : ''}
    </section>

    ${deep}
    <p class="hint lab-foot">Click any portrait on the draft board to inspect that hero.</p>
  </article>`;
}

// ------------------------------------------------------------------ render all

function renderAll() {
  hideHover(true);
  ctx = buildContext();
  const key = ctx.complete ? 'done' : ctx.step ? `${ctx.step.manual ? 'm' : ctx.step.index}` : 'none';
  if (key !== ui.stepKey) { ui.stepKey = key; ui.timerLeft = stepTimer(); }

  // Feedback only for a NEW pick/ban (not for undo, which moves back in the log).
  const last = draft.lastAction();
  const fresh = last && last.id > ui.lastSeenAction && (last.kind === 'pick' || last.kind === 'ban');
  ui.lastSeenAction = last ? last.id : 0;
  ui.justUsed = fresh ? last.heroId : null;

  const recRects = captureRects('#recs .rec');
  renderHeader();
  renderBoard();
  renderRecs();
  renderPostDraft();
  if (!$('grid').hidden) renderGrid();
  renderCoach();
  document.body.classList.toggle('coach-open', ui.coachOpen);
  document.body.classList.toggle('report-mode', !!(ctx.complete && !ctx.step?.manual && !ui.showGrid));
  document.body.classList.add('desk');

  if (fresh && last.kind === 'ban' && draft.format.blindBans && ctx.step?.type === 'pick' && !ctx.step.manual
      && draft.state.pickLog.length === 0) toast('Ban phase complete. Bans revealed, picks start.');
  if (fresh) {
    const sel = last.kind === 'ban'
      ? `.ban[data-side="${last.side}"][data-index="${last.key}"]`
      : `.slot[data-side="${last.side}"][data-index="${(last.order || 1) - 1}"]`;
    document.querySelector(sel)?.classList.add('just-filled');
  }
  playFlip('#recs .rec', recRects);
  if (ui.readonly) { $('grid').hidden = true; $('filterbar').hidden = true; }
  $('quickbar').hidden = ui.readonly || (ctx.complete && !ctx.step?.manual);
  document.body.classList.toggle('viewer', ui.readonly);
  schedulePublish();
}

// Recommendation reorder: FLIP (cards slide from their old position, new ones fade in).
function captureRects(sel) {
  const m = new Map();
  document.querySelectorAll(sel).forEach((el) => m.set(el.dataset.key, el.getBoundingClientRect()));
  return m;
}
function playFlip(sel, before) {
  if (!before.size || matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const zoom = parseFloat(getComputedStyle(document.documentElement).zoom) || 1;
  document.querySelectorAll(sel).forEach((el) => {
    const old = before.get(el.dataset.key);
    if (!old) { el.animate([{ opacity: 0, transform: 'translateY(4px)' }, { opacity: 1, transform: 'none' }], { duration: 180, easing: 'ease-out' }); return; }
    const now = el.getBoundingClientRect();
    const dx = (old.left - now.left) / zoom;
    const dy = (old.top - now.top) / zoom;
    if (Math.abs(dx) < 1 && Math.abs(dy) < 1) return;
    el.animate([{ transform: `translate(${dx}px, ${dy}px)` }, { transform: 'none' }], { duration: 200, easing: 'cubic-bezier(.2,.7,.3,1)' });
  });
}

// ------------------------------------------------------------------ hover preview
// Hovering a hero (grid or recommendation) shows exactly where a click will put it:
// the target slot gets a faint preview of the portrait and the tile states the action.
let previewEl = null;
function clearPreview() {
  if (!previewEl) return;
  previewEl.classList.remove('incoming');
  previewEl.querySelector('.ghost')?.remove();
  previewEl = null;
  document.querySelectorAll('[data-intent]').forEach((el) => el.removeAttribute('data-intent'));
}
function showPreview(card) {
  const id = card.dataset.id;
  const t = id && draft.previewTarget(id);
  clearPreview();
  if (!t) return;
  const h = db.get(id);
  const sel = t.type === 'ban' ? `.ban[data-side="${t.side}"][data-index="${t.key}"]` : `.slot[data-side="${t.side}"][data-index="${t.index}"]`;
  previewEl = document.querySelector(sel);
  if (previewEl) {
    previewEl.classList.add('incoming');
    const host = previewEl.querySelector('.slot-pt') || previewEl;
    host.insertAdjacentHTML('beforeend', `<span class="ghost">${portrait(h, t.type === 'ban' ? 'pt-ban' : 'pt-slot')}</span>`);
  }
  const who = t.side === ctx.allySide ? '' : 'Enemy ';
  const intent = t.type === 'ban' ? `${who}Ban` : `${who}Pick ${t.order}${t.key ? ` · ${ROLE_NAME[t.key]}` : ''}`;
  (card.querySelector('.tile-pt') || card).setAttribute('data-intent', intent);
}
for (const zone of ['grid', 'recs']) {
  $(zone).addEventListener('mouseover', (e) => {
    const card = e.target.closest('.tile:not(.used), .rec, .bcard, .prow:not(.phead), .fy-pick');
    if (card && card !== showPreview.last) { showPreview.last = card; showPreview(card); }
  });
  $(zone).addEventListener('mouseleave', () => { showPreview.last = null; clearPreview(); });
  $(zone).addEventListener('focusin', (e) => { const c = e.target.closest('.tile:not(.used), .rec, .bcard'); if (c) showPreview(c); });
  $(zone).addEventListener('focusout', clearPreview);
}

// ------------------------------------------------------------------ rooms + sharing

/** Actions a spectator / share viewer may never trigger (everything that changes the draft or the host's context). */
const MUTATING = new Set(['set-signature', 'hero', 'slot', 'role-menu', 'set-role', 'auto-role', 'ban-slot', 'remove', 'start-over', 'reset', 'no-ban', 'role-pick', 'side', 'undo', 'pool', 'my-role', 'my-hero', 'hero-picker', 'create-match', 'end-match', 'show-grid']);

async function copyText(text, msg) {
  try { await navigator.clipboard.writeText(text); toast(msg); } catch { window.prompt('Copy this link:', text); }
}
const currentState = () => buildMatchState({ draft, me, profile, recRole: ctx?.roleRec?.role || ui.recRole, code: ui.room.code });

async function createMatch() {
  const T = await connectTransport();
  if (!T) { toast('Live rooms need the ML Draft Lab server or a Supabase project.'); return; }
  try {
    const room = await T.create(currentState());
    try { localStorage.setItem(`mldl.host.${room.code}`, room.hostToken); localStorage.setItem(`mldl.view.${room.code}`, room.viewToken); } catch { /* kept for this tab only */ }
    location.assign(`/match/${room.code}`);
  } catch (err) { toast(`Could not create a match: ${err.message}`); }
}

async function endMatch() {
  const T = ui.room.transport;
  if (!T) return;
  const r = await T.end(ui.room.code, ui.room.token);
  if (r.ok) { ui.room.status = 'COMPLETE'; if (Number.isFinite(r.revision)) ui.room.revision = r.revision; toast('Match ended: the room is now read-only.'); renderHeader(); } else toast(`Could not end the match: ${r.error}`);
}

function shareFinal() {
  const url = `${location.origin}/#share=${encodeShare(currentState())}`;
  ui.shareUrl = url;
  copyText(url, 'Read-only link to this final draft copied.');
}

/**
 * Apply a room's shared state (spectators: every newer revision; the host: once, to resume after a refresh).
 * Stale or duplicate deliveries (revision ≤ the one shown) are ignored.
 */
function applyRoom(room, why = 'fetch') {
  const R = ui.room;
  if (!room?.state) return false;
  if (!isNewer(room, R.revision == null && R.updatedAt == null ? null : { revision: R.revision, updatedAt: R.updatedAt, status: R.status })) {
    R.ignored++;
    if (DEBUG) roomLog(`ignored ${why} r${room.revision} (showing r${R.revision})`);
    return false;
  }
  R.status = room.status;
  R.revision = Number.isFinite(room.revision) ? room.revision : R.revision;
  R.updatedAt = room.updatedAt ?? R.updatedAt;
  R.lastSync = Date.now();
  R.applied++;
  roomLog(`applied ${why} r${R.revision} · ${room.status} · ${room.state.picks?.length || 0} picks · ${(room.state.bans || []).filter((b) => b.hero).length} bans`);
  const s = room.state;
  applying = true;
  if (VIEWER) {
    profile.replace(s.pool);
    me.replace({ role: s.myRole, hero: s.myHero, heroSource: s.myHeroSource });
    ui.recRole = s.recRole || null;
  }
  applyMatchState(draft, s);
  applying = false;
  renderAll();
  return true;
}

let pubTimer = null;
let publishing = false;
let publishAgain = false;
/**
 * Host: publish the canonical state after every change. Writes are SERIALIZED (one request in flight,
 * then the latest state), so the server's revision order always matches the host's action order.
 */
function schedulePublish() {
  if (ui.mode !== 'host' || !ui.room.transport || applying || ui.room.status === 'COMPLETE') return;
  clearTimeout(pubTimer);
  pubTimer = setTimeout(publishNow, 120);
}
async function publishNow() {
  if (publishing) { publishAgain = true; return; }
  const st = currentState();
  const key = JSON.stringify({ ...st, updatedAt: 0 });
  if (key === publishNow.last) return; // nothing changed since the last accepted write
  publishing = true;
  try {
    const r = await ui.room.transport.update(ui.room.code, ui.room.token, st);
    if (r.ok) publishNow.last = key;
    if (r.ok) {
      ui.room.status = r.status || st.status;
      if (Number.isFinite(r.revision)) ui.room.revision = r.revision;
      ui.room.lastSync = Date.now(); ui.room.lastError = null; ui.room.write = 'SUCCESS';
      roomLog(`published r${ui.room.revision ?? '?'} · ${st.status} · ${st.picks.length} picks · ${st.bans.filter((b) => b.hero).length} bans`);
    } else if (r.code === 409) { ui.room.status = 'COMPLETE'; toast('This match is complete and read-only for everyone.'); }
    else { ui.room.lastError = r.error || 'network error'; ui.room.write = `FAIL: ${ui.room.lastError}`; roomLog('publish failed:', ui.room.lastError); toast(`Could not sync the match: ${ui.room.lastError}`); }
    renderHeader();
  } finally {
    publishing = false;
    if (publishAgain) { publishAgain = false; publishNow(); }
  }
}

async function initRoom() {
  const code = ui.room.code;
  if (!CODE_RE.test(code)) { ui.room.error = `“${code}” is not a valid match code.`; renderAll(); return; }
  const T = await connectTransport();
  ui.room.transport = T;
  roomLog(`${ui.mode} · room ${code} · transport ${T?.kind || 'none'}`);
  if (!T) { ui.room.error = 'Live rooms are not available on this server.'; renderAll(); return; }
  // 1. FETCH the current state (a spectator joining late must see everything that already happened)
  if (!ui.room.viewKey) {
    ui.room.initialFetch = 'FAIL: no spectator key';
    ui.room.error = 'This match link is missing its spectator key (#k=…). Ask the host for the full link from Copy link.';
    roomLog('initial fetch: FAIL (no spectator key in the link)'); renderAll(); renderDebug(); return;
  }
  const { room, error } = await T.get(code, ui.room.viewKey);
  if (error) { ui.room.initialFetch = `FAIL: ${error}`; ui.room.error = `Could not load match ${code}: ${error}`; ui.room.lastError = error; roomLog(`initial fetch: FAIL (${error})`); renderAll(); }
  else if (!room) { ui.room.initialFetch = 'FAIL: not found'; ui.room.error = `Match ${code} was not found (it may have expired).`; roomLog('initial fetch: FAIL (not found)'); renderAll(); return; }
  else { ui.room.initialFetch = 'SUCCESS'; roomLog(`initial fetch: SUCCESS r${room.revision}`); applyRoom(room, 'join'); }
  // 2. SUBSCRIBE to this room only; every (re)subscription fetches again, newer revisions are applied
  T.watch(code, {
    role: ui.mode === 'host' ? 'host' : 'spectator', token: ui.room.token, viewToken: ui.room.viewKey,
    onState: (r, why = 'realtime') => {
      if (VIEWER) { if (applyRoom(r, why)) ui.room.error = null; }
      else if (r.status !== ui.room.status) { ui.room.status = r.status; renderHeader(); }
    },
    onPresence: (n) => { ui.room.watching = n; renderHeader(); },
    onStatus: (x) => { if (x.channel) ui.room.channel = x.channel; if (x.error) ui.room.lastError = x.error; renderDebug(); },
  });
  renderDebug();
}

// ------------------------------------------------------------------ sync diagnostics (temporary: ?debug=1)
const DEBUG = new URLSearchParams(location.search).has('debug') || (() => { try { return localStorage.getItem('mldl.debug') === '1'; } catch { return false; } })();
function renderDebug() {
  if (!DEBUG || (ui.mode !== 'host' && ui.mode !== 'spectator')) return;
  let el = document.getElementById('sync-debug');
  if (!el) { el = document.createElement('pre'); el.id = 'sync-debug'; el.className = 'sync-debug'; document.body.appendChild(el); }
  const R = ui.room;
  const ago = R.lastSync ? `${Math.round((Date.now() - R.lastSync) / 1000)}s ago` : 'never';
  const conn = !R.transport ? 'not connected' : R.channel === 'SUBSCRIBED' ? 'connected' : R.channel.toLowerCase();
  el.textContent = (ui.mode === 'host' ? [
    `${R.transport?.kind === 'supabase' ? 'Supabase' : R.transport?.kind === 'relay' ? 'Local relay' : 'Transport'}: ${conn}`,
    `Room: ${R.code}`,
    `Write: ${R.write || '—'}`,
    `Revision: ${R.revision ?? '—'} · ${R.status || '—'}`,
    `Last sync: ${ago} · spectators ${R.watching}`,
    R.lastError ? `Last error: ${R.lastError}` : '',
  ] : [
    `${R.transport?.kind === 'supabase' ? 'Supabase' : R.transport?.kind === 'relay' ? 'Local relay' : 'Transport'} ${R.transport ? 'connected' : 'not connected'}`,
    `Room: ${R.code}`,
    `Initial fetch: ${R.initialFetch || '…'}`,
    `Realtime subscription: ${R.channel === 'SUBSCRIBED' ? 'SUBSCRIBED' : R.channel === 'CHANNEL_ERROR' || R.channel === 'TIMED_OUT' ? `ERROR (${R.channel})` : R.channel}`,
    `Revision: ${R.revision ?? '—'} · ${R.status || '—'} · last sync ${ago}`,
    `Applied ${R.applied} · ignored stale ${R.ignored}`,
    R.lastError ? `Last error: ${R.lastError}` : '',
  ]).filter(Boolean).join('\n');
}
if (DEBUG) setInterval(renderDebug, 1000);

// ------------------------------------------------------------------ actions

function onHero(id) {
  if (ui.readonly) return;
  // Legality is format-specific (e.g. a blind ranked wave allows a double ban), so ask the engine.
  const can = draft.canAct(id);
  const y = window.scrollY; // the draft desk stays exactly where the user is looking
  if (!can.ok || !draft.act(id)) { toast(can.reason || 'That action is not available right now.'); return; }
  if (ui.q) { ui.q = ''; $('search').value = ''; renderGrid(); }
  if (document.activeElement === $('search')) $('search').blur(); // free the keyboard for shortcuts
  showPreview.last = null;
  keepScroll(y);
}
/** Restore the scroll position after a re-render (twice: now and after layout settles). */
function keepScroll(y) {
  window.scrollTo({ top: y, behavior: 'instant' });
  requestAnimationFrame(() => window.scrollTo({ top: y, behavior: 'instant' }));
}

/** Select a hero FOR a role: the pick is logged with that role (manual), then normal flow continues. */
function onRolePick(id, role) {
  const side = ctx.allySide;
  if (role && draft.openRoles(side).includes(role)) {
    const r = draft.setTarget({ side, type: 'pick', key: role });
    if (!r.ok) { toast(r.reason); return; }
  }
  onHero(id);
}

function onSlot(side, type, key) {
  const t = draft.state.target;
  if (t && t.side === side && t.type === type && (type === 'pick' || t.key === key)) { draft.setTarget(null); return; }
  const r = draft.setTarget(type === 'pick' ? { side, type } : { side, type, key });
  if (!r.ok) toast(r.reason);
}

function startOver() {
  if (!ui.confirmReset) {
    ui.confirmReset = true;
    renderHeader();
    clearTimeout(startOver.t);
    startOver.t = setTimeout(() => { ui.confirmReset = false; renderHeader(); }, 3000);
    return;
  }
  clearTimeout(startOver.t);
  Object.assign(ui, { confirmReset: false, roleMenu: null, deep: false, showGrid: false, paused: false, q: '', stepKey: null, lastSeenAction: 0 });
  $('search').value = '';
  draft.reset();
  toast('Draft cleared. Start logging from ban 1.');
}

document.addEventListener('click', (e) => {
  if (ui.roleMenu && !e.target.closest('.role-menu, [data-act="role-menu"]')) { ui.roleMenu = null; renderBoard(); }
  if (hc.classList.contains('pinned') && !e.target.closest('#hovercard, [data-act="inspect"]')) hideHover(true);
  const el = e.target.closest('[data-act]');
  if (!el || el.disabled) return;
  const d = el.dataset;
  if (ui.readonly && MUTATING.has(d.act)) { toast(ui.mode === 'share' ? 'This is a read-only shared draft.' : 'Spectator mode: only the host can change the draft.'); return; }
  switch (d.act) {
    case 'my-role': me.setRole(d.role); ui.heroPicker = !me.hero; renderAll(); break; // no hero yet → open the picker
    case 'my-hero': me.setHero(d.id || null); ui.heroPicker = false; renderAll(); break;
    case 'hero-picker': ui.heroPicker = !ui.heroPicker; renderAll(); break;
    case 'set-signature': profile.setSignature?.(d.role, d.id); toast(`${db.get(d.id).name} is now your signature ${ROLE_NAME[d.role]} hero.`); break;
    case 'create-match': createMatch(); break;
    case 'copy-link': copyText(`${location.origin}/match/${ui.room.code}#k=${ui.room.viewKey || ''}`, 'Match link copied: send it to your friends.'); break;
    case 'end-match': endMatch(); break;
    case 'share-final': shareFinal(); break;
    case 'hero': onHero(d.id); break;
    case 'slot': onSlot(d.side, 'pick'); break;
    case 'role-menu': ui.roleMenu = ui.roleMenu && ui.roleMenu.hero === d.hero ? null : { side: d.side, hero: d.hero }; renderBoard(); break;
    case 'set-role': ui.roleMenu = null; if (!draft.assignRole(d.side, d.hero, d.role)) renderBoard(); break;
    case 'auto-role': ui.roleMenu = null; draft.autoRole(d.side, d.hero); break;
    case 'ban-slot': onSlot(d.side, 'ban', Number(d.index)); break;
    case 'remove': e.stopPropagation(); if (!draft.remove(d.side, d.type, d.type === 'ban' ? Number(d.key) : d.key)) toast(draft.canRemove().reason); break;
    case 'start-over': startOver(); break;
    case 'no-ban': if (!draft.noBan()) toast(draft.canNoBan().reason); break;
    case 'role': ui.role = d.role; renderGrid(); break;
    case 'pool-filter': ui.poolOnly = !ui.poolOnly; renderGrid(); break;
    case 'rec-tab': ui.recTab = d.tab; renderAll(); break;
    case 'rec-role': ui.recRole = d.role; renderAll(); break; // inspecting a role never changes the draft
    case 'role-pick': hideHover(true); onRolePick(d.id, d.role); break;
    case 'board-filter': ui.boardFilter = d.f; renderRecs(); break;
    case 'board-sort': ui.boardSort = d.s; renderRecs(); break;
    case 'cmp': e.stopPropagation(); hideHover(true);
      ui.compare = ui.compare.includes(d.id) ? ui.compare.filter((x) => x !== d.id) : [...ui.compare, d.id].slice(-3);
      renderRecs(); return;
    case 'cmp-clear': ui.compare = []; renderRecs(); break;
    case 'inspect': e.stopPropagation(); inspectPick(d.side, d.id, el); return;
    case 'inspect-close': hideHover(true); return;
    case 'view-guide': ui.showGrid = false; renderAll(); document.querySelector('#postdraft .report')?.scrollIntoView({ block: 'start', behavior: 'smooth' }); ui.coachOpen = false; document.body.classList.remove('coach-open'); break;
    case 'side': draft.setUserSide(d.side); break;
    case 'undo': draft.undo(); break;
    case 'reset': startOver(); break;
    case 'pool': openPoolEditor({ db, profile }); break;
    case 'deep': ui.deep = !ui.deep; renderCoach(); break;
    case 'personal': ui.personal = !ui.personal; renderCoach(); break;
    case 'timer': ui.paused = !ui.paused; renderBoard(); break;
    case 'show-grid': ui.showGrid = true; renderAll(); break;
    case 'show-report': ui.showGrid = false; renderAll(); break;
    case 'coach-open': ui.coachOpen = true; document.body.classList.add('coach-open'); break;
    case 'coach-close': ui.coachOpen = false; document.body.classList.remove('coach-open'); break;
    default: break;
  }
});

document.addEventListener('change', (e) => {
  if (ui.readonly && e.target.id !== 'boardSort') return;
  if (e.target.id === 'format') draft.setFormat(e.target.value);
  if (e.target.id === 'bracket') { const r = draft.setBracket(e.target.value); if (!r.ok) { toast(r.reason); renderHeader(); } }
  if (e.target.dataset?.my === 'role') me.setRole(e.target.value || null);
  if (e.target.dataset?.my === 'hero') me.setHero(e.target.value || null);
  if (e.target.id === 'boardSort') { ui.boardSort = e.target.value; renderRecs(); }
});

$('grid').addEventListener('contextmenu', (e) => {
  const tile = e.target.closest('.tile');
  if (!tile || ui.readonly) return;
  e.preventDefault();
  const h = db.get(tile.dataset.id);
  const roles = profile.rolesFor(h.id);
  if (roles.length) { roles.forEach((r) => profile.remove(r, h.id)); toast(`${h.name} removed from your pool`); }
  else { const r = ROLES.includes(ui.role) && h.lanes.includes(ui.role) ? ui.role : h.primaryLane; profile.set(r, h.id, { stars: 3 }); toast(`${h.name} added to your ${ROLE_NAME[r]} pool (★★★)`); }
});

// ------------------------------------------------------------------ quick pick (search → Enter → next)
const qp = $('quickpick');
function quickMatches() {
  const q = qp.value.trim();
  if (!q) return [];
  return db.search(q).filter((h) => draft.canAct(h.id).ok).slice(0, 6);
}
function renderQuick() {
  const list = quickMatches();
  $('qpResults').innerHTML = qp.value.trim()
    ? list.map((h, i) => `<button class="qp-hit ${i === 0 ? 'first' : ''}" data-act="qp-pick" data-id="${h.id}">${portrait(h, 'pt-qp')}<span>${esc(h.name)}</span>${i === 0 ? '<kbd>Enter</kbd>' : ''}</button>`).join('') || '<span class="qp-none">No available hero matches</span>'
    : '';
}
function commitQuick(id) {
  const y = window.scrollY;
  onHero(id);
  qp.value = ''; renderQuick();
  qp.focus({ preventScroll: true }); // ready for the next name
  keepScroll(y);
}
qp.addEventListener('input', renderQuick);
qp.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault(); // never submit / scroll
    const first = quickMatches()[0];
    if (first) commitQuick(first.id);
    else if (qp.value.trim()) toast('No available hero matches that name.');
  } else if (e.key === 'Escape') { qp.value = ''; renderQuick(); qp.blur(); }
});
document.addEventListener('click', (e) => {
  const b = e.target.closest('[data-act="qp-pick"]');
  if (b) { e.stopPropagation(); commitQuick(b.dataset.id); }
}, true);

const search = $('search');
search.addEventListener('input', () => { ui.q = search.value; renderGrid(); });
search.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    const list = visibleHeroes();
    const first = list.find((h) => !draft.usedBy(h.id));
    if (first) onHero(first.id);
    else if (list[0]) onHero(list[0].id); // shows "already banned/picked"
    e.preventDefault();
  } else if (e.key === 'Escape') {
    search.value = ''; ui.q = ''; renderGrid(); search.blur();
  }
});

document.addEventListener('keydown', (e) => {
  if (document.querySelector('.modal')) return;
  const inField = e.target.matches('input, select, textarea');
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z' && !inField) { e.preventDefault(); if (!ui.readonly) draft.undo(); return; }
  if (inField || e.ctrlKey || e.metaKey || e.altKey) return;
  if (e.key === 'Escape') {
    if (!hc.hidden) { hideHover(true); return; }
    if (ui.roleMenu) { ui.roleMenu = null; renderBoard(); return; }
    if (ui.coachOpen) { ui.coachOpen = false; document.body.classList.remove('coach-open'); return; }
    if (draft.state.target) draft.setTarget(null);
    return;
  }
  if ((e.key === 'Enter' || e.key === ' ') && e.target.matches('[role~="button"][data-act]')) { e.preventDefault(); e.target.click(); return; }
  if (ui.readonly) return; // no shortcuts that change the draft
  if (/^[1-9]$/.test(e.key)) {
    const r = ctx.list[Number(e.key) - 1];
    if (r) { if (ctx.roleRec) onRolePick(r.hero.id, ctx.roleRec.role); else onHero(r.hero.id); e.preventDefault(); }
    return;
  }
  if (e.key.length === 1 && /[a-z.\-']/i.test(e.key)) { // keystroke lands in quick pick, without scrolling the page
    const target = !$('quickbar').hidden ? qp : search;
    target.focus({ preventScroll: true });
  }
});

setInterval(() => {
  if (ui.paused || !ctx || ctx.complete || ui.timerLeft <= 0) return;
  ui.timerLeft -= 1;
  const t = $('timer');
  if (t) { t.innerHTML = `${ui.timerLeft}<small>s</small>`; t.classList.toggle('low', ui.timerLeft <= 10); }
}, 1000);

draft.subscribe(renderAll);
me.subscribe(() => { draft.refreshRoles(); renderAll(); });
profile.subscribe(renderAll);
if (MODE === 'share') {
  const st = decodeShare(route.payload);
  if (st) applyRoom({ status: 'COMPLETE', state: st });
  else ui.room.error = 'This share link is invalid or incomplete.';
}
renderAll();
if (MODE === 'host' || MODE === 'spectator') initRoom();
