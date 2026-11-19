// REALTIME TRANSPORT for match rooms. One interface, two backends:
//   • Supabase  — production source of truth (when /api/config returns a Supabase URL + publishable key)
//   • local relay — server.js /api/rooms (server-sent events, in memory): local / LAN use and the tests only
//
// interface: { kind, create(state) → { code, hostToken, revision },
//              get(code) → { room|null, error|null },
//              update(code, token, state) → { ok, status, revision, code, error },
//              end(code, token) → { ok, revision, error },
//              watch(code, { role, token, onState(room), onPresence(n), onStatus(info) }) → stop() }
// A room is { code, status, state, revision, updatedAt }. Only shared match state travels: every client
// runs the recommendation / analysis engines locally. Writes are host-only and enforced server-side.
//
// Spectator flow (both backends): FETCH current state → render → SUBSCRIBE to this room only → on every
// (re)subscription fetch again (closes the gap between fetch and subscribe) → apply only newer revisions.

import { CODE_RE, newRoomCode } from './matchState.js';

const SUPABASE_ESM = 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/+esm';
const FALLBACK_POLL_MS = 15000; // only while the realtime channel is not connected

export async function connectTransport() {
  const cfg = await fetch('/api/config', { cache: 'no-store' }).then((r) => (r.ok ? r.json() : null)).catch(() => null);
  if (cfg?.supabaseUrl && cfg?.supabaseAnonKey) {
    try { return await supabaseTransport(cfg); } catch (err) { log('Supabase client could not load:', err.message); }
  }
  if (cfg?.relay) return relayTransport();
  return null;
}

/** Console diagnostics, always prefixed so they are easy to filter. */
export function log(...args) { console.info('[room]', ...args); }

// ------------------------------------------------------------------ local relay (server.js)

export function relayTransport(base = '') {
  const call = async (method, path, body, token) => {
    try {
      const res = await fetch(`${base}${path}`, {
        method, cache: 'no-store',
        headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(token ? { 'X-Host-Token': token } : {}) },
        body: body ? JSON.stringify(body) : undefined,
      });
      const data = await res.json().catch(() => ({}));
      return { ok: res.ok, status: res.status, data };
    } catch (err) {
      return { ok: false, status: 0, data: { error: err.message } };
    }
  };
  return {
    kind: 'relay',
    async create(state) { const r = await call('POST', '/api/rooms', { state }); if (!r.ok) throw new Error(r.data.error || 'could not create room'); return r.data; },
    async get(code) {
      if (!CODE_RE.test(code)) return { room: null, error: 'invalid code' };
      const r = await call('GET', `/api/rooms/${code}`);
      return r.ok ? { room: r.data, error: null } : { room: null, error: r.status === 404 ? null : r.data.error || `HTTP ${r.status}` };
    },
    async update(code, token, state) { const r = await call('PUT', `/api/rooms/${code}`, { state }, token); return { ok: r.ok, status: r.data.status, revision: r.data.revision, code: r.status, error: r.data.error }; },
    async end(code, token) { const r = await call('POST', `/api/rooms/${code}/end`, {}, token); return { ok: r.ok, revision: r.data.revision, error: r.data.error }; },
    watch(code, { role = 'spectator', token = null, onState, onPresence, onStatus }) {
      // EventSource cannot send headers, so the host identifies itself with its token in the query
      // (only to exclude itself from the spectator count; all writes still need the X-Host-Token header).
      const q = role === 'host' && token ? `role=host&t=${encodeURIComponent(token)}` : 'role=spectator';
      const es = new EventSource(`${base}/api/rooms/${code}/events?${q}`);
      es.addEventListener('open', () => onStatus?.({ channel: 'SUBSCRIBED' }));
      es.addEventListener('error', () => onStatus?.({ channel: es.readyState === 2 ? 'CLOSED' : 'RECONNECTING' }));
      es.addEventListener('state', (e) => onState?.(JSON.parse(e.data)));
      es.addEventListener('presence', (e) => onPresence?.(JSON.parse(e.data).watching));
      return () => es.close();
    },
  };
}

// ------------------------------------------------------------------ Supabase (production)

async function supabaseTransport({ supabaseUrl, supabaseAnonKey }) {
  const { createClient } = await import(SUPABASE_ESM);
  const sb = createClient(supabaseUrl, supabaseAnonKey, { auth: { persistSession: false, autoRefreshToken: false } });
  const rand = () => { const b = new Uint8Array(18); crypto.getRandomValues(b); return btoa(String.fromCharCode(...b)).replace(/[+/=]/g, ''); };
  const asRoom = (row) => row && { code: row.code, status: row.status, state: row.state, revision: Number(row.revision ?? row.state?.revision ?? 0), updatedAt: row.updated_at };
  const channels = new Map(); // code → channel (the host reuses its channel to send revision hints)
  let hasRevision = true;

  async function get(code) {
    if (!CODE_RE.test(code)) return { room: null, error: 'invalid code' };
    let { data, error } = await sb.from('matches').select(hasRevision ? 'code,status,state,revision,updated_at' : 'code,status,state,updated_at').eq('code', code).maybeSingle();
    if (error?.code === '42703' && hasRevision) { // database without migration 002: order by update time instead
      hasRevision = false;
      log('no revision column (run supabase/migrations/002_live_sync.sql); falling back to update time');
      ({ data, error } = await sb.from('matches').select('code,status,state,updated_at').eq('code', code).maybeSingle());
    }
    if (error) { log('fetch failed:', error.code, error.message); return { room: null, error: `${error.code || 'error'}: ${error.message}` }; }
    return { room: asRoom(data), error: null };
  }

  return {
    kind: 'supabase',
    async create(state) {
      for (let i = 0; i < 5; i++) {
        const code = newRoomCode(); const hostToken = rand();
        const { error } = await sb.rpc('create_match', { p_code: code, p_token: hostToken, p_state: { ...state, matchId: code, revision: 0 }, p_status: state.status || 'WAITING' });
        if (!error) return { code, hostToken, status: state.status || 'WAITING', revision: 0 };
        if (!/duplicate|unique/i.test(error.message)) throw new Error(error.message);
      }
      throw new Error('could not allocate a room code');
    },
    get,
    async update(code, hostToken, state) {
      const { data, error } = await sb.rpc('update_match', { p_code: code, p_token: hostToken, p_state: { ...state, matchId: code }, p_status: state.status || 'LIVE' });
      if (error) return { ok: false, error: error.message, code: /complete/i.test(error.message) ? 409 : /host/i.test(error.message) ? 403 : 500 };
      const revision = typeof data === 'number' ? data : Number(data) || null;
      // tell spectators to re-read the row (a hint only: it carries no state, so a forged one is harmless)
      channels.get(code)?.send({ type: 'broadcast', event: 'rev', payload: { revision } }).catch(() => {});
      return { ok: true, status: state.status, revision };
    },
    async end(code, hostToken) {
      const { data, error } = await sb.rpc('end_match', { p_code: code, p_token: hostToken });
      if (!error) channels.get(code)?.send({ type: 'broadcast', event: 'rev', payload: { revision: data } }).catch(() => {});
      return { ok: !error, revision: data ?? null, error: error?.message };
    },
    watch(code, { role = 'spectator', onState, onPresence, onStatus }) {
      let stopped = false;
      let channelState = 'CONNECTING';
      const refetch = async (why) => {
        if (stopped) return;
        const { room, error } = await get(code);
        if (room) onState?.(room, why);
        onStatus?.({ channel: channelState, fetched: why, error });
      };
      const ch = sb.channel(`match:${code}`, { config: { presence: { key: rand() }, broadcast: { self: false } } });
      channels.set(code, ch);
      // authoritative row changes, scoped to this room only
      ch.on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'matches', filter: `code=eq.${code}` }, (p) => {
        if (p.new?.code === code) { onState?.(asRoom(p.new), 'realtime'); onStatus?.({ channel: channelState, realtime: Date.now() }); }
      });
      ch.on('broadcast', { event: 'rev' }, () => refetch('hint'));
      ch.on('presence', { event: 'sync' }, () => {
        onPresence?.(Object.values(ch.presenceState()).flat().filter((x) => x.role === 'spectator').length);
      });
      ch.subscribe(async (status, err) => {
        channelState = status;
        log(`channel ${code}: ${status}${err ? ` (${err.message})` : ''}`);
        onStatus?.({ channel: status, error: err?.message || null });
        if (status === 'SUBSCRIBED') {
          await ch.track({ role });
          refetch('subscribed'); // anything that changed between the first fetch and the subscription
        }
      });
      // phones and background tabs drop websockets: catch up whenever the page is back
      const wake = () => { if (document.visibilityState === 'visible') refetch('visible'); };
      document.addEventListener('visibilitychange', wake);
      window.addEventListener('online', wake);
      window.addEventListener('focus', wake);
      const poll = setInterval(() => { if (channelState !== 'SUBSCRIBED') refetch('poll'); }, FALLBACK_POLL_MS);
      return () => {
        stopped = true; clearInterval(poll);
        document.removeEventListener('visibilitychange', wake); window.removeEventListener('online', wake); window.removeEventListener('focus', wake);
        channels.delete(code); sb.removeChannel(ch);
      };
    },
  };
}
