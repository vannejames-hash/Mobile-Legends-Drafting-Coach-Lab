// Zero-dependency server: `node server.js` → http://localhost:5173
//
//   static files      the app (index.html, src/, data/, styles.css; /assets/* → public/assets/*)
//   /match/<code>     SPA route for live match rooms (serves index.html)
//   /api/config       public client config (Supabase URL + anon key from env, if set)
//   /api/rooms…       LOCAL REALTIME RELAY for match rooms (in memory, server-sent events). Used when
//                     Supabase is not configured: local play, LAN play (HOST=0.0.0.0) and the tests.
//                     In production (Vercel) rooms run on Supabase Realtime instead; see supabase/schema.sql.
//
// Env: PORT (5173) · HOST (127.0.0.1; 0.0.0.0 to let friends on your network join)
//      SUPABASE_URL · SUPABASE_ANON_KEY (publishable keys only — never a service-role key)
import http from 'node:http';
import { createHash, randomBytes, randomInt } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = fileURLToPath(new URL('.', import.meta.url));
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp',
  '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.avif': 'image/avif', '.md': 'text/markdown; charset=utf-8',
};
const CODE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
const CODE_RE = /^MLDL-[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{4}$/;
const MAX_BODY = 128 * 1024;
const ROOM_TTL_MS = 24 * 60 * 60 * 1000;
const sha = (s) => createHash('sha256').update(String(s)).digest('hex');

export function createAppServer({ root = ROOT, env = process.env } = {}) {
  /** code → { code, tokenHash, status, state, createdAt, updatedAt, clients: Set<{ res, role }> } */
  const rooms = new Map();

  const json = (res, status, body) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(body)); };
  const watching = (room) => [...room.clients].filter((c) => c.role === 'spectator').length;
  const send = (c, event, data) => { try { c.res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); } catch { /* client gone */ } };
  const publicRoom = (room) => ({ code: room.code, status: room.status, state: room.state, revision: room.revision, watching: watching(room), updatedAt: room.updatedAt });
  const broadcastState = (room) => { for (const c of room.clients) send(c, 'state', publicRoom(room)); };
  const broadcastPresence = (room) => { const n = watching(room); for (const c of room.clients) send(c, 'presence', { watching: n }); };

  function newCode() {
    for (;;) {
      let s = '';
      for (let i = 0; i < 4; i++) s += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
      const code = `MLDL-${s}`;
      if (!rooms.has(code)) return code;
    }
  }
  function readBody(req) {
    return new Promise((resolve, reject) => {
      let size = 0; const chunks = [];
      req.on('data', (c) => { size += c.length; if (size > MAX_BODY) { reject(new Error('too large')); req.destroy(); } else chunks.push(c); });
      req.on('end', () => { try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); } catch { reject(new Error('bad json')); } });
      req.on('error', reject);
    });
  }
  const statusOf = (state) => (['WAITING', 'LIVE', 'COMPLETE'].includes(state?.status) ? state.status : 'LIVE');
  const isHost = (room, req) => room.tokenHash === sha(req.headers['x-host-token'] || '');

  async function api(req, res, path) {
    if (path === '/api/config') {
      return json(res, 200, { supabaseUrl: env.SUPABASE_URL || null, supabaseAnonKey: env.SUPABASE_ANON_KEY || null, relay: true });
    }
    if (path === '/api/rooms' && req.method === 'POST') {
      const body = await readBody(req);
      if (!body.state || typeof body.state !== 'object') return json(res, 400, { error: 'state required' });
      const code = newCode();
      const hostToken = randomBytes(18).toString('base64url');
      const now = Date.now();
      rooms.set(code, { code, tokenHash: sha(hostToken), status: statusOf(body.state), revision: 0, state: { ...body.state, matchId: code, revision: 0 }, createdAt: now, updatedAt: now, clients: new Set() });
      return json(res, 201, { code, hostToken, status: rooms.get(code).status, revision: 0 });
    }
    const m = path.match(/^\/api\/rooms\/([^/]+)(\/events|\/end)?$/);
    if (!m) return json(res, 404, { error: 'not found' });
    const code = m[1].toUpperCase();
    if (!CODE_RE.test(code)) return json(res, 400, { error: 'bad room code' });
    const room = rooms.get(code);
    if (!room) return json(res, 404, { error: 'room not found' });

    if (m[2] === '/events' && req.method === 'GET') {
      const q = new URL(req.url, 'http://x').searchParams; // EventSource cannot send headers: host token may come as ?t=
      const role = q.get('role') === 'host' && (isHost(room, req) || room.tokenHash === sha(q.get('t') || '')) ? 'host' : 'spectator';
      res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
      res.write('retry: 2000\n\n');
      const client = { res, role };
      room.clients.add(client);
      send(client, 'state', publicRoom(room));
      broadcastPresence(room);
      const beat = setInterval(() => { try { res.write(': ping\n\n'); } catch { /* closed */ } }, 20000);
      req.on('close', () => { clearInterval(beat); room.clients.delete(client); broadcastPresence(room); });
      return undefined;
    }
    if (m[2] === '/end' && req.method === 'POST') {
      if (!isHost(room, req)) return json(res, 403, { error: 'only the host can end this match' });
      room.revision += 1; room.status = 'COMPLETE'; room.state = { ...room.state, status: 'COMPLETE', revision: room.revision }; room.updatedAt = Date.now();
      broadcastState(room);
      return json(res, 200, { status: room.status, revision: room.revision });
    }
    if (!m[2] && req.method === 'GET') return json(res, 200, publicRoom(room));
    if (!m[2] && req.method === 'PUT') {
      if (!isHost(room, req)) return json(res, 403, { error: 'only the host can modify this match' });
      if (room.status === 'COMPLETE') return json(res, 409, { error: 'this match is complete and read-only', status: room.status });
      const body = await readBody(req);
      if (!body.state || typeof body.state !== 'object') return json(res, 400, { error: 'state required' });
      room.revision += 1; // every accepted host write gets the next revision; viewers drop anything older
      room.state = { ...body.state, matchId: code, revision: room.revision };
      room.status = statusOf(body.state);
      room.updatedAt = Date.now();
      broadcastState(room);
      return json(res, 200, { status: room.status, revision: room.revision });
    }
    return json(res, 405, { error: 'method not allowed' });
  }

  async function serveStatic(req, res, path) {
    if (path.endsWith('/')) path += 'index.html';
    if (/^\/match\/[^/.]+\/?$/.test(path)) path = '/index.html'; // SPA route
    if (path.startsWith('/assets/')) path = `/public${path}`; // static assets live in public/
    const file = normalize(join(root, path));
    if (!file.startsWith(root.endsWith(sep) ? root : root + sep)) { res.writeHead(403).end(); return; }
    const body = await readFile(file);
    const isImage = /^image\//.test(TYPES[extname(file)] || '');
    res.writeHead(200, { 'Content-Type': TYPES[extname(file)] || 'application/octet-stream', 'Cache-Control': isImage ? 'max-age=86400' : 'no-store' });
    res.end(body);
  }

  const server = http.createServer(async (req, res) => {
    try {
      const path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
      if (path.startsWith('/api/')) await api(req, res, path);
      else await serveStatic(req, res, path);
    } catch (err) {
      if (res.headersSent) { res.end(); return; }
      if (err?.message === 'bad json' || err?.message === 'too large') json(res, 400, { error: err.message });
      else res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found');
    }
  });
  const sweep = setInterval(() => { const now = Date.now(); for (const [k, r] of rooms) if (now - r.updatedAt > ROOM_TTL_MS && !r.clients.size) rooms.delete(k); }, 60 * 60 * 1000);
  sweep.unref();
  server.on('close', () => clearInterval(sweep));
  server.rooms = rooms;
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(process.env.PORT) || 5173;
  const host = process.env.HOST || '127.0.0.1';
  createAppServer().listen(port, host, () => console.log(`ML Draft Lab → http://${host === '0.0.0.0' ? 'localhost' : host}:${port}${host === '0.0.0.0' ? ' (also on your network IP)' : ''}`));
}
