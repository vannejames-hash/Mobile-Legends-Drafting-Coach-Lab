// App configuration. Data files are loaded at runtime, so meta and hero data
// can be swapped by editing JSON — no rebuild needed.
export const CONFIG = {
  heroDataUrl: '/data/heroes.json',
  // Meta manifest: picks the active season/patch dataset (hero stats + optional draft log).
  metaManifestUrl: '/data/meta/index.json',
  // Portrait manifest (separate from hero data). Images live in public/assets/heroes/<heroId>.webp.
  portraitManifestUrl: '/data/hero-portraits.json',
  // Draft formats (sequence, timers, enforcement). Default comes from the file.
  draftFormatsUrl: '/data/draft-formats.json',
  stepSeconds: 30, // fallback when a format phase has no timer
  recommendationCount: 4,
};
