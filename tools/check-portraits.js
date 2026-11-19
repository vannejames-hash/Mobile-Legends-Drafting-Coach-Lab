// Reports portrait coverage: cached locally, linked remotely, or missing.
//
//   node tools/check-portraits.js
//
// Local file per hero: public/assets/heroes/<heroId>.webp (ids from data/heroes.json).
// data/hero-portraits.json may add manual `overrides` or downloader-written `remote` links.

import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { createHeroDatabase } from '../src/heroDatabase.js';

const read = (p) => JSON.parse(readFileSync(new URL(`../${p}`, import.meta.url)));
const manifest = read('data/hero-portraits.json');
const db = createHeroDatabase(read('data/heroes.json'), manifest);
const dir = new URL('../public/assets/heroes/', import.meta.url);
const files = existsSync(dir) ? readdirSync(dir).filter((f) => /\.(webp|png|jpe?g|avif)$/i.test(f)) : [];
const validFile = (f) => files.includes(f) && statSync(new URL(f, dir)).size > 500;

const local = [];
const remote = [];
const override = [];
const missing = [];
for (const h of db.all) {
  if (validFile(`${h.id}.webp`)) local.push(h.id);
  else if (manifest.overrides?.[h.id]) override.push(h.id);
  else if (manifest.remote?.[h.id]) remote.push(h.id);
  else missing.push(`${h.id}  →  ${h.id}.webp  (${h.name})`);
}
const ids = new Set(db.all.map((h) => `${h.id}.webp`));
const unexpected = files.filter((f) => !ids.has(f));

console.log(`Portraits for ${db.all.length} heroes:`);
console.log(`  ${local.length} cached locally (public/assets/heroes/)`);
console.log(`  ${remote.length} linked remotely (loaded by the browser; run tools/download-hero-portraits.js to cache)`);
if (override.length) console.log(`  ${override.length} manual overrides`);
console.log(`  ${missing.length} missing (role placeholder shown)\n`);
if (missing.length) console.log(`Missing:\n  ${missing.join('\n  ')}\n`);
if (unexpected.length) console.log(`Files with no matching hero id (rename to <heroId>.webp):\n  ${unexpected.join('\n  ')}`);
