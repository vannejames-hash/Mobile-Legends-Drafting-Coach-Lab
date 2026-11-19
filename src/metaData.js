// CURRENT META layer: per-hero pick/ban/win statistics for one season or patch.
// Lives in data/meta/, separate from the hero database, and is chosen through
// data/meta/index.json, so a new season is a data change, not a code change.
//
// Hero-stat file format (written by tools/import-hero-stats.js):
// { id, source, status: "verified" | "pending", drafts,
//   heroes: [ { id, hero, picks, bans, wins, losses, winRate, presence } ] }
// winRate is wins / picks; presence is (picks + bans) / drafts; both are 0–1.

export async function loadMetaManifest(url) {
  const res = await fetch(url, { cache: 'no-store' });
  if (!res.ok) throw new Error(`meta manifest ${res.status}`);
  const manifest = await res.json();
  const entry = manifest.datasets[manifest.active];
  if (!entry) throw new Error(`active dataset "${manifest.active}" missing from manifest`);
  // manifest paths are project-relative; resolve them from the site root so deep links (/match/…) work
  const abs = (p) => (typeof p === 'string' && !/^([a-z]+:|\/)/i.test(p) ? `/${p}` : p);
  return { id: manifest.active, ...Object.fromEntries(Object.entries(entry).map(([k, v]) => [k, abs(v)])) };
}

export async function loadMetaData(manifestUrl) {
  try {
    const ds = await loadMetaManifest(manifestUrl);
    const res = await fetch(ds.heroStats, { cache: 'no-store' });
    if (!res.ok) throw new Error(`hero stats ${res.status}`);
    let usage = null;
    if (ds.usage) {
      const u = await fetch(ds.usage, { cache: 'no-store' }).catch(() => null);
      if (u?.ok) usage = await u.json();
    }
    return createMetaData(await res.json(), ds, usage);
  } catch (err) {
    console.warn('[metaData] no meta loaded, using neutral values:', err.message);
    return createMetaData(null, null);
  }
}

export function createMetaData(raw, dataset, usageRaw = null) {
  const drafts = raw?.drafts || 0;
  const stats = new Map();
  let maxPresence = 0;
  let maxBan = 0;
  for (const row of raw?.heroes || []) {
    const pickRate = drafts ? row.picks / drafts : 0;
    const banRate = drafts ? row.bans / drafts : 0;
    const presence = row.presence ?? Math.min(1, pickRate + banRate);
    const winRate = row.winRate ?? (row.picks ? row.wins / row.picks : null);
    stats.set(row.id, { ...row, pickRate, banRate, presence, winRate });
    maxPresence = Math.max(maxPresence, presence);
    maxBan = Math.max(maxBan, banRate);
  }
  const hasData = stats.size > 0 && drafts > 0;
  const complete = hasData && !!raw?.coverage?.complete;

  return {
    id: raw?.id || null,
    source: raw?.source || 'No meta data loaded',
    status: hasData ? raw.status || 'verified' : 'empty',
    drafts,
    hasData,
    coverage: raw?.coverage || null,
    draftLogUrl: dataset?.draftLog || null,
    /**
     * Stats for a hero. A roster hero absent from a COMPLETE dataset (totals reconcile) genuinely had
     * zero picks/bans there, so it gets an explicit zero record (absent: true) rather than invented
     * values. With an incomplete or empty dataset, unknown heroes return null (= unavailable).
     */
    get: (id) => stats.get(id) || (complete && id ? { picks: 0, bans: 0, wins: 0, losses: 0, pickRate: 0, banRate: 0, presence: 0, winRate: null, absent: true } : null),
    isComplete: () => complete,
    /** Observed competitive usage (separate from official identity). null if the hero has no entry. */
    usage: (id) => usageRaw?.heroes?.[id] || null,
    usageFlagged: usageRaw?.flaggedForVerification || [],
    /** 0–1 presence relative to the most-contested hero (constant 0.3 when no data, so meta has no effect on ranking). */
    presenceNorm(id) {
      if (!hasData) return 0.3;
      return (stats.get(id)?.presence || 0) / (maxPresence || 1);
    },
    banNorm(id) {
      if (!hasData) return 0.3;
      return (stats.get(id)?.banRate || 0) / (maxBan || 1);
    },
  };
}
