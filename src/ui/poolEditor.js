// "My Pool" editor: heroes by role, with proficiency stars and notes.
import { ROLES } from '../draftState.js';
import { STAR_LABEL } from '../playerProfile.js';
import { esc, portrait, roleIcon, ROLE_NAME } from './components.js';

const ROLE_LABEL = ROLE_NAME;
const ROLE_SHORT = ROLE_NAME;

export function openPoolEditor({ db, profile }) {
  const root = document.getElementById('modal-root');
  let role = 'jungle';
  let q = '';
  let open = null; // heroId whose notes are expanded

  function render() {
    const entries = profile.entries(role).map((e) => ({ ...e, hero: db.get(e.id) })).filter((e) => e.hero)
      .sort((a, b) => b.stars - a.stars || a.hero.name.localeCompare(b.hero.name));
    const results = (q ? db.search(q) : db.all.filter((h) => h.lanes.includes(role)))
      .filter((h) => !profile.inPool(h.id, role)).slice(0, 24);
    root.innerHTML = `
      <div class="modal-back" data-close></div>
      <div class="modal" role="dialog" aria-modal="true" aria-label="My hero pool">
        <div class="modal-head"><h2>My pool</h2><p class="muted">Recommendations in “For you” only use these heroes, weighted by proficiency.</p><button class="btn ghost" data-close aria-label="Close">✕</button></div>
        <div class="tabs pool-tabs">${ROLES.map((r) => `<button data-role="${r}" class="${r === role ? 'on' : ''}">${roleIcon(r)}${ROLE_LABEL[r]} <em>${profile.entries(r).length}</em></button>`).join('')}</div>
        <div class="pool-list">
          ${entries.length ? entries.map((e) => `
            <div class="pool-row">
              ${portrait(e.hero, 'pt-mini')}
              <b>${esc(e.hero.name)}</b>
              <span class="star-input" role="radiogroup" aria-label="Proficiency">${[1, 2, 3, 4, 5].map((n) => `<button data-star="${n}" data-id="${e.id}" class="${n <= e.stars ? 'on' : ''}" title="${STAR_LABEL[n]}" aria-label="${n} stars — ${STAR_LABEL[n]}">★</button>`).join('')}</span>
              <span class="muted star-label">${STAR_LABEL[e.stars]}</span>
              <button class="btn ghost sm" data-notes="${e.id}">${open === e.id ? 'Close' : 'Notes'}</button>
              <button class="btn ghost sm" data-remove="${e.id}" aria-label="Remove ${esc(e.hero.name)}">Remove</button>
              ${open === e.id ? `<div class="notes">${['build:Preferred build', 'playstyle:Preferred playstyle', 'likes:Situations I like', 'avoids:Situations I avoid'].map((f) => {
                const [k, label] = f.split(':');
                return `<label><span>${label}</span><input data-note="${k}" data-id="${e.id}" value="${esc(e[k] || '')}"></label>`;
              }).join('')}</div>` : ''}
            </div>`).join('') : `<p class="muted">No ${ROLE_LABEL[role]} heroes in your pool yet.</p>`}
        </div>
        <div class="pool-add">
          <input id="poolSearch" placeholder="Add a hero to ${ROLE_LABEL[role]}…" value="${esc(q)}" autocomplete="off">
          <div class="pool-results">${results.map((h) => `<button data-add="${h.id}" title="Add ${esc(h.name)}">${portrait(h, 'pt-mini')}<span>${esc(h.name)}</span><em>${h.lanes.map((l) => ROLE_SHORT[l]).join('·')}</em></button>`).join('')}</div>
        </div>
        <div class="modal-foot"><button class="btn ghost" data-reset>Reset to default pool</button><button class="btn primary" data-close>Done</button></div>
      </div>`;
    const input = root.querySelector('#poolSearch');
    input.addEventListener('input', () => { q = input.value; const pos = input.selectionStart; render(); const i2 = root.querySelector('#poolSearch'); i2.focus(); i2.setSelectionRange(pos, pos); });
  }

  function onClick(e) {
    const t = e.target.closest('button, [data-close]');
    if (!t) return;
    const d = t.dataset;
    if ('close' in d) return close();
    if (d.role) { role = d.role; q = ''; open = null; }
    else if (d.star) profile.set(role, d.id, { stars: Number(d.star) });
    else if (d.remove) profile.remove(role, d.remove);
    else if (d.add) profile.set(role, d.add, { stars: 3 });
    else if (d.notes) open = open === d.notes ? null : d.notes;
    else if ('reset' in d) { if (confirm('Reset your pool to the default example?')) profile.reset(); }
    else return;
    render();
  }
  function onChange(e) {
    const el = e.target;
    if (el.dataset.note) profile.set(role, el.dataset.id, { [el.dataset.note]: el.value.trim() });
  }
  function onKey(e) { if (e.key === 'Escape') close(); }
  function close() {
    root.removeEventListener('click', onClick);
    root.removeEventListener('change', onChange);
    document.removeEventListener('keydown', onKey);
    root.innerHTML = '';
  }

  root.addEventListener('click', onClick);
  root.addEventListener('change', onChange);
  document.addEventListener('keydown', onKey);
  render();
  root.querySelector('#poolSearch')?.focus();
}
