// REALTIME TRANSPORT for match rooms. One interface, two backends:
//   • Supabase Realtime  — when /api/config returns a Supabase URL + publishable (anon) key (production)
//   • local relay        — server.js /api/rooms (server-sent events) for local / LAN use and tests
//
// interface: { kind, create(state) → { code, hostToken }, get(code) → room|null,
//              update(code, token, state) → { ok, status, error }, end(code, token),
//              watch(code, { role, token, onState(room), onPresence(n) }) → stop() }
// Only shared match state travels; every client runs the recommendation / analysis engines locally.

import { CODE_RE, newRoomCode } from './matchState.js';

const SUPABASE_ESM = 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/+esm';

export async function connectTransport() {
  const cfg = await fetch('/api/config', { cache: 'no-store' }).then((r) => (r.ok ? r.json() : null)).catch(() => null);
  if (cfg?.supabaseUrl && cfg?.supabaseAnonKey) {
    try { return await supabaseTransport(cfg); } catch (err) { console.warn('[realtime] Supabase unavailable:', err.message); }
  }
  if (cfg?.relay) return relayTransport();
  return null;
}

// ------------------------------------------------------------------ local relay (server.js)

export function relayTransport(base = '') {
  const call = async (method, path, body, token) => {
    const res = await fetch(`${base}${path}`, {
      method, cache: 'no-store',
      headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(token ? { 'X-Host-Token': token } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await res.json().catch(() => ({}));
    return { ok: res.ok, status: res.status, data };
  };
  return {
    kind: 'relay',
    async create(state) { const r = await call('POST', '/api/rooms', { state }); if (!r.ok) throw new Error(r.data.error || 'could not create room'); return r.data; },
    async get(code) { if (!CODE_RE.test(code)) return null; const r = await call('GET', `/api/rooms/${code}`); return r.ok ? r.data : null; },
    async update(code, token, state) { const r = await call('PUT', `/api/rooms/${code}`, { state }, token); return { ok: r.ok, status: r.data.status, code: r.status, error: r.data.error }; },
    async end(code, token) { const r = await call('POST', `/api/rooms/${code}/end`, {}, token); return { ok: r.ok, error: r.data.error }; },
    watch(code, { role = 'spectator', token = null, onState, onPresence }) {
      // EventSource cannot send headers, so the host identifies itself with its token in the query
      // (only to exclude itself from the spectator count; all writes still need the X-Host-Token header).
      const q = role === 'host' && token ? `role=host&t=${encodeURIComponent(token)}` : 'role=spectator';
      const es = new EventSource(`${base}/api/rooms/${code}/events?${q}`);
      es.addEventListener('state', (e) => onState?.(JSON.parse(e.data)));
      es.addEventListener('presence', (e) => onPresence?.(JSON.parse(e.data).watching));
      return () => es.close();
    },
  };
}

// ------------------------------------------------------------------ Supabase Realtime

async function supabaseTransport({ supabaseUrl, supabaseAnonKey }) {
  const { createClient } = await import(SUPABASE_ESM);
  const sb = createClient(supabaseUrl, supabaseAnonKey, { auth: { persistSession: false } });
  const token = () => { const b = new Uint8Array(18); crypto.getRandomValues(b); return btoa(String.fromCharCode(...b)).replace(/[+/=]/g, ''); };
  const asRoom = (row) => row && { code: row.code, status: row.status, state: row.state, updatedAt: row.updated_at };
  return {
    kind: 'supabase',
    async create(state) {
      for (let i = 0; i < 5; i++) {
        const code = newRoomCode(); const hostToken = token();
        const { error } = await sb.rpc('create_match', { p_code: code, p_token: hostToken, p_state: { ...state, matchId: code }, p_status: state.status || 'WAITING' });
        if (!error) return { code, hostToken, status: state.status || 'WAITING' };
        if (!/duplicate|unique/i.test(error.message)) throw new Error(error.message);
      }
      throw new Error('could not allocate a room code');
    },
    async get(code) {
      if (!CODE_RE.test(code)) return null;
      const { data } = await sb.from('matches').select('code,status,state,updated_at').eq('code', code).maybeSingle();
      return asRoom(data);
    },
    async update(code, hostToken, state) {
      const { error } = await sb.rpc('update_match', { p_code: code, p_token: hostToken, p_state: { ...state, matchId: code }, p_status: state.status || 'LIVE' });
      return error ? { ok: false, error: error.message, code: /complete/i.test(error.message) ? 409 : 403 } : { ok: true, status: state.status };
    },
    async end(code, hostToken) {
      const { error } = await sb.rpc('end_match', { p_code: code, p_token: hostToken });
      return { ok: !error, error: error?.message };
    },
    watch(code, { role = 'spectator', onState, onPresence }) {
      const ch = sb.channel(`match:${code}`, { config: { presence: { key: token() } } });
      ch.on('postgres_changes', { event: '*', schema: 'public', table: 'matches', filter: `code=eq.${code}` }, (p) => p.new && onState?.(asRoom(p.new)));
      ch.on('presence', { event: 'sync' }, () => {
        const n = Object.values(ch.presenceState()).flat().filter((x) => x.role === 'spectator').length;
        onPresence?.(n);
      });
      ch.subscribe(async (status) => { if (status === 'SUBSCRIBED') await ch.track({ role }); });
      this.get(code).then((r) => r && onState?.(r));
      return () => sb.removeChannel(ch);
    },
  };
}
