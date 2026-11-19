// LIVE database access tests against a real Supabase project (the one the app is configured with).
// Uses only the publishable (anon) key — exactly what a spectator's browser has. Creates a few test rooms.
//
//   SUPABASE_URL=… SUPABASE_ANON_KEY=… node tests/supabase-access.test.js
//   (skipped when the variables are not set, so `npm test` stays offline)
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';

const URL_ = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
const KEY = process.env.SUPABASE_ANON_KEY || '';
if (!URL_ || !KEY) { console.log('\nSupabase access tests: skipped (set SUPABASE_URL and SUPABASE_ANON_KEY to run against a live project)'); process.exit(0); }

let failures = 0;
const test = async (name, fn) => { try { await fn(); console.log(`  ✓ ${name}`); } catch (e) { failures++; console.log(`  ✗ ${name}\n      ${String(e.message).split('\n')[0]}`); } };
const H = { apikey: KEY, Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' };
const rest = async (method, path, body) => {
  const res = await fetch(`${URL_}/rest/v1${path}`, { method, headers: { ...H, Prefer: 'return=representation' }, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let data = null; try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  return { status: res.status, data };
};
const rpc = (fn, args) => rest('POST', `/rpc/${fn}`, args);
const ALPHA = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
const code = () => `MLDL-${Array.from(randomBytes(4), (b) => ALPHA[b % ALPHA.length]).join('')}`;
const tok = () => randomBytes(18).toString('base64url');
const state = (extra = {}) => ({ v: 1, status: 'WAITING', format: 'RANKED_DRAFT', userSide: 'blue', picks: [], bans: [], ...extra });

async function newRoom() {
  const r = { code: code(), host: tok(), view: tok() };
  const c = await rpc('create_match', { p_code: r.code, p_token: r.host, p_view_token: r.view, p_state: state(), p_status: 'WAITING' });
  if (c.status >= 300) throw new Error(`create_match ${c.status}: ${JSON.stringify(c.data)}`);
  return r;
}

console.log('\nSupabase access (live project, anon key)');
const A = await newRoom();
const B = await newRoom();

await test('A — spectator with the room key reads that room through get_match', async () => {
  const r = await rpc('get_match', { p_code: A.code, p_view_token: A.view });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.code, A.code); assert.equal(r.data.status, 'WAITING'); assert.equal(r.data.revision, 0);
});

await test('B — wrong, missing or other-room key reads nothing; the table itself is not readable', async () => {
  for (const k of ['', 'guess', B.view]) {
    const r = await rpc('get_match', { p_code: A.code, p_view_token: k });
    assert.equal(r.status, 200); assert.equal(r.data, null, `key ${k || '(empty)'} must not read room A`);
  }
  const direct = await rest('GET', `/matches?code=eq.${A.code}&select=*`);
  assert.ok(direct.status === 401 || direct.status === 403 || (direct.status === 200 && direct.data.length === 0), `direct table read must fail, got ${direct.status}`);
  const hosts = await rest('GET', '/match_hosts?select=*&limit=1');
  assert.ok(hosts.status === 401 || hosts.status === 403 || (hosts.status === 200 && hosts.data.length === 0), 'host secrets unreadable');
});

await test('C — anon cannot update matches directly', async () => {
  const r = await rest('PATCH', `/matches?code=eq.${A.code}`, { status: 'COMPLETE' });
  assert.ok(r.status === 401 || r.status === 403 || (Array.isArray(r.data) && r.data.length === 0), `direct update must fail, got ${r.status}`);
  const still = await rpc('get_match', { p_code: A.code, p_view_token: A.view });
  assert.equal(still.data.status, 'WAITING');
});

await test('D — anon cannot delete or insert matches directly', async () => {
  const del = await rest('DELETE', `/matches?code=eq.${A.code}`);
  assert.ok(del.status === 401 || del.status === 403 || (Array.isArray(del.data) && del.data.length === 0), `direct delete must fail, got ${del.status}`);
  const ins = await rest('POST', '/matches', { code: code(), status: 'LIVE', state: {} });
  assert.ok(ins.status === 401 || ins.status === 403, `direct insert must fail, got ${ins.status}`);
  assert.ok((await rpc('get_match', { p_code: A.code, p_view_token: A.view })).data, 'room A still exists');
});

await test('E — the host updates its room with the host token; anyone else is refused', async () => {
  const ok = await rpc('update_match', { p_code: A.code, p_token: A.host, p_state: state({ status: 'LIVE', bans: [{ side: 'blue', wave: 1, slot: 1, hero: 'freya' }] }), p_status: 'LIVE' });
  assert.equal(ok.status, 200, JSON.stringify(ok.data)); assert.equal(ok.data, 1, 'revision 1');
  for (const t of [B.host, 'guess-guess-guess-guess', A.view]) {
    const bad = await rpc('update_match', { p_code: A.code, p_token: t, p_state: state(), p_status: 'LIVE' });
    assert.ok(bad.status >= 400 && /only the host/.test(JSON.stringify(bad.data)), `token ${t.slice(0, 4)}… must be refused`);
  }
  const now = await rpc('get_match', { p_code: A.code, p_view_token: A.view });
  assert.equal(now.data.revision, 1); assert.equal(now.data.state.bans[0].hero, 'freya'); assert.equal(now.data.state.revision, 1);
});

await test('F — spectator responses never contain the host token, the key or their hashes', async () => {
  const r = await rpc('get_match', { p_code: A.code, p_view_token: A.view });
  const raw = JSON.stringify(r.data);
  assert.deepEqual(Object.keys(r.data).sort(), ['code', 'revision', 'state', 'status', 'updated_at']);
  for (const secret of [A.host, A.view]) assert.ok(!raw.includes(secret));
  assert.ok(!/token_hash|view_hash/.test(raw));
});

await test('H — after loading the room, a host update arrives live on the room channel (Realtime Broadcast)', async () => {
  const ws = new WebSocket(`${URL_.replace(/^http/, 'ws')}/realtime/v1/websocket?apikey=${encodeURIComponent(KEY)}&vsn=1.0.0`);
  const topic = `realtime:match:${A.code}`;
  const msgs = [];
  const waitFor = (pred, ms, what) => new Promise((resolve, reject) => {
    const t0 = Date.now();
    const iv = setInterval(() => { const m = msgs.find(pred); if (m) { clearInterval(iv); resolve(m); } else if (Date.now() - t0 > ms) { clearInterval(iv); reject(new Error(`timed out waiting for ${what}`)); } }, 50);
  });
  ws.onmessage = (e) => msgs.push(JSON.parse(e.data));
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('websocket failed')); });
  ws.send(JSON.stringify({ topic, event: 'phx_join', ref: '1', payload: { config: { broadcast: { self: false }, presence: { key: '' }, postgres_changes: [], private: false }, access_token: KEY } }));
  const join = await waitFor((m) => m.ref === '1' && m.event === 'phx_reply', 8000, 'channel join');
  assert.equal(join.payload.status, 'ok', `join: ${JSON.stringify(join.payload)}`);
  const t0 = Date.now();
  const up = await rpc('update_match', { p_code: A.code, p_token: A.host, p_state: state({ status: 'LIVE' }), p_status: 'LIVE' });
  assert.equal(up.data, 2);
  const hint = await waitFor((m) => m.topic === topic && m.event === 'broadcast' && m.payload?.event === 'rev', 10000, 'the revision broadcast');
  console.log(`      broadcast {revision: ${hint.payload.payload.revision}, status: ${hint.payload.payload.status}} after ${Date.now() - t0} ms`);
  assert.equal(hint.payload.payload.revision, 2);
  assert.ok(!JSON.stringify(hint).includes('"picks"'), 'the hint carries no draft state');
  ws.close();
});

await test('G — a completed room stays readable and becomes read-only (even for the host)', async () => {
  const end = await rpc('end_match', { p_code: B.code, p_token: B.host });
  assert.equal(end.status, 200, JSON.stringify(end.data));
  const r = await rpc('get_match', { p_code: B.code, p_view_token: B.view });
  assert.equal(r.data.status, 'COMPLETE');
  const after = await rpc('update_match', { p_code: B.code, p_token: B.host, p_state: state(), p_status: 'LIVE' });
  assert.ok(after.status >= 400 && /complete/.test(JSON.stringify(after.data)), 'no edits after COMPLETE');
});

await rpc('end_match', { p_code: A.code, p_token: A.host }); // leave test rooms closed
if (failures) { console.log(`\n${failures} Supabase access test(s) failed`); process.exit(1); }
console.log('\nAll Supabase access tests passed');
