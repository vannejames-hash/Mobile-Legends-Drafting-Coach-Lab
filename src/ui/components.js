// Small presentational helpers shared by the UI modules.

export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export const ROLE_NAME = { exp: 'EXP', jungle: 'Jungle', mid: 'Mid', gold: 'Gold', roam: 'Roam' };

// ---------------------------------------------------------------- portraits
// Fallback order: hero.portraitUrl → local /assets/heroes/{id}.webp → role placeholder.
// URLs that fail once are remembered for the session, so missing files are never
// re-requested on re-render and a broken-image icon is never shown.
const failedUrls = new Set();

globalThis.__mldlPortraitFail = (img) => {
  failedUrls.add(img.getAttribute('src'));
  const next = (img.dataset.next || '').split('|').filter((u) => u && !failedUrls.has(u));
  if (next.length) {
    img.dataset.next = next.slice(1).join('|');
    img.setAttribute('src', next[0]);
  } else {
    img.parentElement?.classList.remove('has-img');
    img.remove();
  }
};
globalThis.__mldlPortraitLoad = (img) => img.parentElement?.classList.add('loaded');

/** Hero portrait. The UI never builds image URLs: it only reads hero.portraitUrl / portraitFallbackUrl from the hero database. */
export function portrait(hero, cls = '') {
  const lane = hero.primaryLane || hero.lanes[0];
  const urls = [...new Set([hero.portraitUrl, hero.portraitFallbackUrl].filter(Boolean))].filter((u) => !failedUrls.has(u));
  const img = urls.length
    ? `<img src="${esc(urls[0])}" data-next="${esc(urls.slice(1).join('|'))}" alt="" decoding="async" draggable="false" onload="__mldlPortraitLoad(this)" onerror="__mldlPortraitFail(this)">`
    : '';
  return `<span class="pt ${cls} pl-${lane} ${img ? 'has-img' : ''}" aria-hidden="true">${roleIcon(lane)}${img}</span>`;
}

const ICONS = {
  exp: '<path d="M10 2l6 3v5c0 4-3 7-6 8-3-1-6-4-6-8V5z" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M10 6v8M7 9h6" stroke="currentColor" stroke-width="1.8"/>',
  jungle: '<path d="M5 17C5 9 9 4 16 3c-1 7-5 11-11 14z" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M5 17l6-7" stroke="currentColor" stroke-width="1.8"/>',
  mid: '<path d="M10 2l2.2 5.3L18 8l-4.4 3.7L15 17.5 10 14.5 5 17.5l1.4-5.8L2 8l5.8-.7z" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/>',
  gold: '<circle cx="10" cy="10" r="7" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M10 6v8M8 8h3a1.5 1.5 0 010 3H9a1.5 1.5 0 000 3h3" fill="none" stroke="currentColor" stroke-width="1.5"/>',
  roam: '<path d="M10 2l7 3-1 7c-1 3-3 5-6 6-3-1-5-3-6-6L3 5z" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M7 10l2 2 4-4" fill="none" stroke="currentColor" stroke-width="1.8"/>',
};
export const roleIcon = (role) => `<svg class="ri ri-${role}" viewBox="0 0 20 20" aria-hidden="true">${ICONS[role] || ''}</svg>`;

export const starStr = (n) => (n ? '★'.repeat(n) + '☆'.repeat(5 - n) : '');

export function toast(msg) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toast.t);
  toast.t = setTimeout(() => el.classList.remove('show'), 1800);
}
