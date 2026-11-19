// Populate hero portraits automatically for every hero in data/heroes.json.
//
//   node tools/download-hero-portraits.js            # download missing portraits
//   node tools/download-hero-portraits.js --force    # re-download everything
//   node tools/download-hero-portraits.js --remote   # only resolve URLs, link them remotely
//
// How it works
//  1. Reads the hero database and resolves each hero's portrait through the
//     Mobile Legends Fandom wiki MediaWiki API (prop=pageimages): the lead image of
//     each hero page is the official "Hero<n>-portrait" artwork. Nothing is hard-coded;
//     page titles come from hero names (fix odd ones via data/hero-portraits.json → sourceTitles).
//  2. Downloads each image to public/assets/heroes/<hero.id>.webp (ffmpeg converts if
//     the source isn't WebP). Existing files are skipped unless --force.
//  3. If a download is refused or ffmpeg is unavailable, the resolved image URL is
//     written to data/hero-portraits.json → remote, so the app still shows the real
//     portrait (loaded by the browser). Once a local file exists, its remote entry is removed.
// It always exits 0: a missing portrait never breaks the app (the UI falls back to a role placeholder).
//
// Artwork © Moonton. Images are cached locally for personal use of this tool only.

import { readFileSync, writeFileSync, existsSync, mkdirSync, unlinkSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHeroDatabase } from '../src/heroDatabase.js';

const args = new Set(process.argv.slice(2));
const FORCE = args.has('--force');
const REMOTE_ONLY = args.has('--remote');
const API = 'https://mobile-legends.fandom.com/api.php';
const UA = 'MLDraftLab-portrait-fetcher/0.1 (personal draft tool; one request per hero)';
const THUMB = 512; // longest side requested from the wiki
const root = fileURLToPath(new URL('..', import.meta.url));
const outDir = join(root, 'public', 'assets', 'heroes');
const manifestPath = join(root, 'data', 'hero-portraits.json');

const read = (p) => JSON.parse(readFileSync(join(root, p), 'utf8'));
const manifest = read('data/hero-portraits.json');
manifest.overrides ||= {};
manifest.remote ||= {};
manifest.sourceTitles ||= {};
const db = createHeroDatabase(read('data/heroes.json'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const hasFfmpeg = spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' }).status === 0;

async function getJson(url) {
  const res = await fetch(url, { headers: { 'User-Agent': UA, 'Api-User-Agent': UA } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

/** Resolve wiki title → portrait thumbnail URL, 50 titles per API call. */
async function resolvePortraits(heroes) {
  const byTitle = new Map(heroes.map((h) => [manifest.sourceTitles[h.id] || h.name, h]));
  const found = new Map(); // heroId -> { url, file }
  const titles = [...byTitle.keys()];
  for (let i = 0; i < titles.length; i += 50) {
    const batch = titles.slice(i, i + 50);
    const q = new URLSearchParams({ action: 'query', format: 'json', redirects: '1', prop: 'pageimages', pithumbsize: String(THUMB), titles: batch.join('|') });
    const data = await getJson(`${API}?${q}`);
    // map normalized/redirected titles back to the requested title
    const back = new Map();
    for (const n of data.query.normalized || []) back.set(n.to, n.from);
    for (const r of data.query.redirects || []) back.set(r.to, back.get(r.from) || r.from);
    for (const page of Object.values(data.query.pages || {})) {
      const asked = back.get(page.title) || page.title;
      const hero = byTitle.get(asked);
      if (!hero) continue;
      if (page.thumbnail?.source && /^Hero\d+-portrait\./i.test(page.pageimage || '')) {
        found.set(hero.id, { url: page.thumbnail.source, file: page.pageimage });
      }
    }
    await sleep(300);
  }
  return found;
}

async function download(url, dest) {
  const res = await fetch(url, { headers: { 'User-Agent': UA } });
  const type = res.headers.get('content-type') || '';
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  if (!type.startsWith('image/')) throw new Error(`source returned ${type.split(';')[0] || 'non-image'} instead of an image`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (type.includes('webp')) { writeFileSync(dest, buf); return; }
  if (!hasFfmpeg) throw new Error('needs conversion to WebP but ffmpeg is not installed');
  const tmp = join(tmpdir(), `mldl-${process.pid}-${Date.now()}`);
  writeFileSync(tmp, buf);
  const r = spawnSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', tmp, '-c:v', 'libwebp', '-quality', '84', dest], { encoding: 'utf8' });
  try { unlinkSync(tmp); } catch { /* ignore */ }
  if (r.status !== 0) throw new Error(`ffmpeg: ${(r.stderr || '').trim().split('\n').pop()}`);
}

function saveManifest() {
  manifest.remoteSource = Object.keys(manifest.remote).length
    ? { from: 'mobile-legends.fandom.com (MediaWiki pageimages)', resolvedAt: new Date().toISOString().slice(0, 10), note: 'Browser-loaded until cached locally; re-run the downloader to cache.' }
    : undefined;
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
}

// ---------------------------------------------------------------------------
mkdirSync(outDir, { recursive: true });
const heroes = db.all;
const total = heroes.length;
const fileFor = (h) => join(outDir, `${h.id}.webp`);
const todo = heroes.filter((h) => FORCE || REMOTE_ONLY || !existsSync(fileFor(h)));
console.log(`${total} heroes · ${total - todo.length} already cached · resolving ${todo.length} via the wiki API${hasFfmpeg ? '' : ' (ffmpeg not found: non-WebP sources will be linked remotely)'}\n`);

let resolved = new Map();
try {
  resolved = await resolvePortraits(todo);
} catch (err) {
  console.log(`Could not reach the wiki API (${err.message}). Existing portraits and placeholders still work.`);
}

const failures = [];
const linked = [];
let done = 0;
let n = 0;
for (const h of heroes) {
  n++;
  if (!todo.includes(h)) { delete manifest.remote[h.id]; continue; }
  const src = resolved.get(h.id);
  if (!src) { failures.push(`${h.name} (${h.id}): no portrait found on the wiki — add data/hero-portraits.json → sourceTitles.${h.id}`); continue; }
  if (REMOTE_ONLY) { manifest.remote[h.id] = src.url; linked.push(h); console.log(`Linked ${n}/${total} — ${h.name}`); continue; }
  try {
    await download(src.url, fileFor(h));
    delete manifest.remote[h.id];
    done++;
    console.log(`Downloaded ${n}/${total} — ${h.name}`);
  } catch (err) {
    manifest.remote[h.id] = src.url; // still show the real portrait
    linked.push(h);
    console.log(`Linked ${n}/${total} — ${h.name}  (download failed: ${err.message})`);
  }
  await sleep(150);
}
saveManifest();

console.log(`\nDone: ${done} downloaded · ${linked.length} linked remotely · ${failures.length} unresolved · ${total - todo.length} already cached`);
if (linked.length && !REMOTE_ONLY) console.log('Remote-linked portraits load in the browser now; re-run this script later to cache them locally.');
if (failures.length) console.log(`\nFailures (these show the role placeholder):\n  ${failures.join('\n  ')}`);
process.exitCode = 0;
