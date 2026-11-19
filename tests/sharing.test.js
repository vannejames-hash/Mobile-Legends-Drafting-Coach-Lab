// Sharing: final-draft share links (R) and live match rooms on the local relay (S–Y).
//   node tests/sharing.test.js
import assert from 'node:assert/strict';
import { db, meta, makeDraft, makeProfile, setup } from './helpers.js';
import { createRecommendationEngine } from '../src/recommendationEngine.js';
import { analyzeCompletedDraft } from '../src/draftAnalysis.js';
import { buildMatchState, applyMatchState, encodeShare, decodeShare, sharedProfile, memoryStorage, CODE_RE, isNewer } from '../src/matchState.js';
import { createPlayerContext } from '../src/playerContext.js';
import { relayTransport } from '../src/realtime.js';
import { createAppServer } from '../server.js';

let failures = 0;
const test = async (name, fn) => {
  try { await fn(); console.log(`  ✓ ${name}`); } catch (e) { failures++; console.log(`  ✗ ${name}\n      ${e.message.split('\n')[0]}`); }
};
const lanesOf = (id) => db.get(id)?.lanes;
const POOL = { jungle: { saber: 5, suyou: 5 }, roam: { tigreal: 4 } };
const members = (d, side) => d.team(side).map(({ role, id }) => ({ role, hero: db.get(id) }));

function finishedDraft() {
  const d = makeDraft('FREE');
  return setup(d, {
    blue: { roam: 'tigreal', jungle: 'saber', mid: 'pharsa', gold: 'claude', exp: 'paquito' },
    red: { jungle: 'karina', mid: 'kadita', roam: 'angela', exp: 'yuzhong', gold: 'layla' },
    bans: { blue: ['fanny', 'ling'], red: ['joy', 'nolan'] },
  });
}
function hostMe() {
  const me = createPlayerContext({ lanesOf, storage: memoryStorage() });
  me.setRole('jungle'); me.setHero('saber');
  return me;
}
/** Everything a viewer derives from the shared state. */
function derived(d, profile, me) {
  const engine = createRecommendationEngine({ db, meta, profile });
  const rating = engine.rateDraft(d, d.userSide, { myHero: me.hero });
  const a = analyzeCompletedDraft({ db, ally: members(d, d.userSide), enemy: members(d, d.userSide === 'blue' ? 'red' : 'blue'), rating, myRole: me.role, myHero: me.hero, isAvailable: (id) => !d.usedBy(id) });
  return { rating: rating.rating, label: rating.label, verdict: a.verdict.text, clash: a.clash.decider, job: a.personal.job, plan: JSON.stringify(a.plan), roles: a.roles.map((x) => `${x.hero.id}:${x.function}`).join('|') };
}

/** Minimal SSE reader (Node has no EventSource): resolves events as they arrive. */
function sse(url) {
  const ctrl = new AbortController();
  const queue = []; const waiters = [];
  const push = (ev) => { const w = waiters.shift(); if (w) w(ev); else queue.push(ev); };
  fetch(url, { signal: ctrl.signal }).then(async (res) => {
    const dec = new TextDecoder(); let buf = '';
    for await (const chunk of res.body) {
      buf += dec.decode(chunk, { stream: true });
      let i;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const block = buf.slice(0, i); buf = buf.slice(i + 2);
        const ev = /^event: (.*)$/m.exec(block)?.[1]; const data = /^data: (.*)$/m.exec(block)?.[1];
        if (ev && data) push({ event: ev, data: JSON.parse(data) });
      }
    }
  }).catch(() => {});
  return {
    next: (event, timeout = 2000) => new Promise((resolve, reject) => {
      let w = null;
      const timer = setTimeout(() => { const i = waiters.indexOf(w); if (i >= 0) waiters.splice(i, 1); reject(new Error(`no ${event} event within ${timeout}ms`)); }, timeout);
      timer.unref();
      const take = () => {
        const k = queue.findIndex((e) => e.event === event);
        if (k >= 0) { clearTimeout(timer); return resolve(queue.splice(k, 1)[0].data); }
        w = (e) => { if (e.event === event) { clearTimeout(timer); resolve(e.data); } else { queue.push(e); take(); } };
        waiters.push(w);
      };
      take();
    }),
    close: () => ctrl.abort(),
  };
}

console.log('\nSharing + match rooms');

await test('R — a completed-draft share URL reproduces the same draft, rating and coaching report', () => {
  const d = finishedDraft();
  const me = hostMe();
  const hostProfile = makeProfile(POOL);
  const state = buildMatchState({ draft: d, me, profile: hostProfile });
  const token = encodeShare(state);
  console.log(`      share payload: ${token.length} chars (URL-safe: ${/^[A-Za-z0-9_-]+$/.test(token)})`);
  assert.ok(/^[A-Za-z0-9_-]+$/.test(token) && token.length < 2000);
  const back = decodeShare(token);
  const v = makeDraft('RANKED_DRAFT', 'red'); // a viewer with different local settings
  assert.ok(applyMatchState(v, back));
  const vme = createPlayerContext({ lanesOf, storage: memoryStorage() });
  vme.replace({ role: back.myRole, hero: back.myHero, heroSource: back.myHeroSource });
  assert.deepEqual(v.snapshot(), d.snapshot(), 'draft state identical');
  const A = derived(d, hostProfile, me);
  const B = derived(v, sharedProfile(back.pool), vme);
  console.log(`      host ${A.rating} ${A.label} · viewer ${B.rating} ${B.label}`);
  assert.deepEqual(B, A, 'same rating, verdict, clash, personal job, 30-second plan and roles');
  assert.equal(decodeShare('not-a-valid-payload'), null);
});

const server = createAppServer();
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;
const T = relayTransport(base);

await test('S — create a live room → a spectator joins and receives the current state', async () => {
  const d = makeDraft('RANKED_DRAFT');
  const room = await T.create(buildMatchState({ draft: d, me: hostMe(), profile: makeProfile(POOL) }));
  assert.match(room.code, CODE_RE);
  assert.ok(room.hostToken && room.hostToken.length >= 20);
  const spec = sse(`${base}/api/rooms/${room.code}/events?role=spectator&k=${room.viewToken}`);
  const first = await spec.next('state');
  assert.equal(first.code, room.code);
  assert.equal(first.status, 'WAITING');
  const p = await spec.next('presence');
  assert.equal(p.watching, 1);
  console.log(`      room ${room.code}: spectator joined, watching ${p.watching}`);
  spec.close();
});

await test('T/U — host picks and bans reach the spectator without a refresh', async () => {
  const d = makeDraft('RANKED_DRAFT');
  const me = hostMe();
  const prof = makeProfile(POOL);
  const room = await T.create(buildMatchState({ draft: d, me, profile: prof }));
  const spec = sse(`${base}/api/rooms/${room.code}/events?role=spectator&k=${room.viewToken}`);
  await spec.next('state');
  // host bans (Ranked: 5 blind bans per side first)
  d.act('fanny');
  let r = await T.update(room.code, room.hostToken, buildMatchState({ draft: d, me, profile: prof, code: room.code }));
  assert.ok(r.ok);
  let got = await spec.next('state');
  const viewer = makeDraft('RANKED_DRAFT');
  applyMatchState(viewer, got.state);
  assert.deepEqual(viewer.state.bans, d.state.bans, 'ban visible');
  assert.equal(got.status, 'LIVE');
  // finish the ban phase, then a pick
  for (const id of ['ling', 'joy', 'nolan', 'lancelot', 'hayabusa', 'arlott', 'julian', 'kalea', 'chip', 'tigreal']) d.act(id);
  r = await T.update(room.code, room.hostToken, buildMatchState({ draft: d, me, profile: prof, code: room.code }));
  got = await spec.next('state');
  applyMatchState(viewer, got.state);
  assert.equal(viewer.state.picks.blue.roam, 'tigreal', 'pick visible with its role');
  assert.equal(got.state.events.at(-1).heroId, 'tigreal');
  assert.equal(got.state.events.at(-1).actionType, 'pick');
  spec.close();
});

await test('V — a spectator (no host token) cannot modify the match', async () => {
  const d = makeDraft('RANKED_DRAFT');
  const room = await T.create(buildMatchState({ draft: d, me: hostMe(), profile: makeProfile() }));
  d.act('fanny');
  const forged = buildMatchState({ draft: d, me: hostMe(), profile: makeProfile() });
  for (const tok of [null, 'guess', `${room.hostToken}x`]) {
    const r = await T.update(room.code, tok, forged);
    assert.equal(r.ok, false); assert.equal(r.code, 403);
  }
  assert.equal((await T.end(room.code, 'guess')).ok, false);
  const now = (await T.get(room.code, room.viewToken)).room;
  assert.equal(now.state.bans.length, 0, 'room unchanged');
});

await test('W — a spectator refresh restores the current state', async () => {
  const d = makeDraft('RANKED_DRAFT');
  const me = hostMe(); const prof = makeProfile(POOL);
  const room = await T.create(buildMatchState({ draft: d, me, profile: prof }));
  for (const id of ['fanny', 'ling', 'joy']) d.act(id);
  await T.update(room.code, room.hostToken, buildMatchState({ draft: d, me, profile: prof, recRole: 'gold', code: room.code }));
  const fresh = (await T.get(room.code, room.viewToken)).room; // what a reloaded spectator page fetches first
  const v = makeDraft('RANKED_DRAFT');
  applyMatchState(v, fresh.state);
  assert.deepEqual(v.state.bans, d.state.bans);
  assert.equal(fresh.state.recRole, 'gold');
  assert.equal(fresh.state.myHero, 'saber');
});

await test('X — room A cannot access room B', async () => {
  const a = await T.create(buildMatchState({ draft: makeDraft('RANKED_DRAFT'), me: hostMe(), profile: makeProfile() }));
  const dB = makeDraft('RANKED_DRAFT'); dB.act('claude');
  const b = await T.create(buildMatchState({ draft: dB, me: hostMe(), profile: makeProfile() }));
  assert.notEqual(a.code, b.code);
  const specA = sse(`${base}/api/rooms/${a.code}/events?role=spectator&k=${a.viewToken}`);
  await specA.next('state');
  // A's host token cannot write B
  const r = await T.update(b.code, a.hostToken, buildMatchState({ draft: makeDraft('RANKED_DRAFT'), me: hostMe(), profile: makeProfile() }));
  assert.equal(r.code, 403);
  // B's update never reaches A's spectators
  dB.act('melissa');
  await T.update(b.code, b.hostToken, buildMatchState({ draft: dB, me: hostMe(), profile: makeProfile() }));
  await assert.rejects(specA.next('state', 400), /no state event/);
  assert.equal((await T.get(a.code, a.viewToken)).room.state.bans.length, 0);
  assert.equal((await T.get('MLDL-0000')).room, null, 'invalid codes are rejected');
  specA.close();
});

await test('Y — a completed room becomes read-only', async () => {
  const d = finishedDraft();
  const me = hostMe(); const prof = makeProfile(POOL);
  const room = await T.create(buildMatchState({ draft: makeDraft('FREE'), me, profile: prof }));
  let r = await T.update(room.code, room.hostToken, buildMatchState({ draft: d, me, profile: prof, code: room.code }));
  assert.equal(r.status, 'COMPLETE');
  d.undo();
  r = await T.update(room.code, room.hostToken, buildMatchState({ draft: d, me, profile: prof, code: room.code }));
  assert.equal(r.ok, false); assert.equal(r.code, 409, 'even the host cannot change a completed room');
  const ended = await T.create(buildMatchState({ draft: makeDraft('FREE'), me, profile: prof }));
  assert.ok((await T.end(ended.code, ended.hostToken)).ok, 'End match');
  assert.equal((await T.get(ended.code, ended.viewToken)).room.status, 'COMPLETE');
});

await test('Revisions — every host write gets the next revision; stale deliveries are ignored', async () => {
  const d = makeDraft('RANKED_DRAFT');
  const me = hostMe(); const prof = makeProfile(POOL);
  const room = await T.create(buildMatchState({ draft: d, me, profile: prof }));
  assert.equal(room.revision, 0);
  const revs = [];
  for (const id of ['freya', 'atlas', 'fanny']) {
    d.act(id);
    revs.push((await T.update(room.code, room.hostToken, buildMatchState({ draft: d, me, profile: prof, code: room.code }))).revision);
  }
  assert.deepEqual(revs, [1, 2, 3]);
  const now = (await T.get(room.code, room.viewToken)).room;
  assert.equal(now.revision, 3); assert.equal(now.state.revision, 3);
  assert.equal(isNewer({ revision: 18 }, { revision: 17 }), true, 'r18 over r17 → apply');
  assert.equal(isNewer({ revision: 16 }, { revision: 17 }), false, 'r16 over r17 → ignore');
  assert.equal(isNewer({ revision: 17 }, { revision: 17 }), false, 'duplicate → ignore');
  assert.equal(isNewer({ revision: 0 }, null), true, 'first state → apply');
});

await test('Two spectators + reconnect: 5+5 bans and 6 picks restored on refresh, then the next pick arrives live', async () => {
  const d = makeDraft('RANKED_DRAFT');
  const me = hostMe(); const prof = makeProfile(POOL);
  const room = await T.create(buildMatchState({ draft: d, me, profile: prof }));
  const pub = () => T.update(room.code, room.hostToken, buildMatchState({ draft: d, me, profile: prof, code: room.code }));
  const s1 = sse(`${base}/api/rooms/${room.code}/events?role=spectator&k=${room.viewToken}`);
  const s2 = sse(`${base}/api/rooms/${room.code}/events?role=spectator&k=${room.viewToken}`);
  await s1.next('state'); await s2.next('state');
  for (const id of ['freya', 'atlas', 'fanny', 'ling', 'joy', 'nolan', 'lancelot', 'hayabusa', 'arlott', 'julian', 'saber', 'suyou', 'karina', 'tigreal', 'claude', 'kadita']) { d.act(id); await pub(); }
  // both spectators converge on the latest revision
  const last = async (s) => { let x; try { for (;;) x = await s.next('state', 300); } catch { return x; } };
  const [a, b] = await Promise.all([last(s1), last(s2)]);
  assert.equal(a.revision, 16); assert.equal(b.revision, 16);
  assert.deepEqual(a.state.picks, b.state.picks);
  s2.close(); // spectator 2 closes the tab …
  const reopened = (await T.get(room.code, room.viewToken)).room; // … and reopens: first fetch
  const v = makeDraft('RANKED_DRAFT'); applyMatchState(v, reopened.state);
  assert.equal(v.state.bans.blue.length + v.state.bans.red.length, 10);
  assert.equal(v.state.pickLog.length, 6);
  const s3 = sse(`${base}/api/rooms/${room.code}/events?role=spectator&k=${room.viewToken}`);
  assert.equal((await s3.next('state')).revision, 16);
  d.act('pharsa'); await pub(); // host makes another pick
  const [n1, n3] = await Promise.all([s1.next('state'), s3.next('state')]);
  assert.equal(n1.revision, 17); assert.equal(n3.revision, 17);
  const v2 = makeDraft('RANKED_DRAFT'); applyMatchState(v2, n3.state);
  assert.equal(v2.state.pickLog.length, 7);
  console.log(`      host r17 · spectator 1 r${n1.revision} · reopened spectator r${n3.revision} · ${v2.state.pickLog.length} picks`);
  s1.close(); s3.close();
});

await test('Spectator key — reads need the room key; a wrong, missing or other-room key reads nothing', async () => {
  const a = await T.create(buildMatchState({ draft: makeDraft('RANKED_DRAFT'), me: hostMe(), profile: makeProfile() }));
  const b = await T.create(buildMatchState({ draft: makeDraft('RANKED_DRAFT'), me: hostMe(), profile: makeProfile() }));
  assert.ok(a.viewToken && a.viewToken !== b.viewToken);
  assert.ok((await T.get(a.code, a.viewToken)).room, 'right key reads');
  for (const k of [undefined, '', 'guess', b.viewToken]) assert.equal((await T.get(a.code, k)).room, null, `key ${k} must not read room A`);
  const r = await fetch(`${base}/api/rooms/${a.code}/events?role=spectator&k=${b.viewToken}`);
  assert.equal(r.status, 404, 'no event stream with another room key');
  const raw = JSON.stringify((await T.get(a.code, a.viewToken)).room);
  assert.ok(!raw.includes(a.hostToken) && !raw.includes(a.viewToken), 'reads never contain the host token or the key');
});

await test('Routing — /match/<code> serves the app; /api/config exposes only public keys', async () => {
  const html = await (await fetch(`${base}/match/MLDL-7K4P`)).text();
  assert.match(html, /<script type="module" src="\/src\/ui\/app.js">/);
  const cfg = await (await fetch(`${base}/api/config`)).json();
  assert.deepEqual(Object.keys(cfg).sort(), ['relay', 'supabaseAnonKey', 'supabaseUrl']);
});

server.closeAllConnections?.();
await new Promise((r) => server.close(r));
setTimeout(() => process.exit(failures ? 1 : 0), 50).unref();
if (failures) console.log(`\n${failures} sharing test(s) failed`);
else console.log('\nAll sharing + match-room tests passed');
