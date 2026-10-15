const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

const fmtDate = (t) => new Date(t).toLocaleString(undefined, { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });

function renderRun(run, open) {
  const stats = PST.STATS.filter((s) => run.counts?.[s.id]);
  const statsHtml = stats.length
    ? `<div class="stats">${stats.map((s) => `
        <span>${esc(s.label)}</span>
        <span class="n">×${run.counts[s.id]}</span>
        <span class="eff">${esc(s.effect(run.counts[s.id]))}</span>`).join('')}</div>`
    : '<div class="empty">No stats picked.</div>';

  const t = run.tickets || { t1: 0, t10: 0 };
  const tickets = `<div class="tickets"><span class="tk t1"><i></i>Tickets <b>${t.t1}</b></span><span class="tk t10"><i></i>×10 <b>${t.t10}</b></span></div>`;

  const result = run.result?.rows?.length
    ? `<div class="result">${esc(run.result.title)} · ${run.result.rows.map(([k, v]) => `${esc(k)} <b>${esc(v)}</b>`).join(' · ')}</div>`
    : '';

  const picks = run.picks.map((p) => `
    <li class="${p.kind}"><span class="lv">Lv ${p.level}</span>
      <span><span class="t">${esc(p.title)}</span> <span class="k">${esc(PST.KIND_LABEL[p.kind] || '')}${p.tag && p.kind !== 'stat' ? ' · ' + esc(p.tag) : ''}</span></span></li>`).join('');

  return `<div class="run">
    <div class="run-head"><span>${esc(run.partner || 'Run')}</span><span class="meta">${fmtDate(run.startedAt)} · Lv ${run.lastLevel}</span></div>
    ${result}
    ${tickets}
    ${statsHtml}
    <details${open ? ' open' : ''}><summary>${run.picks.length} card${run.picks.length === 1 ? '' : 's'} picked</summary><ol>${picks}</ol></details>
  </div>`;
}

function render(state, settings) {
  const cur = state.current;
  document.getElementById('current').innerHTML = cur && !cur.ended
    ? renderRun(cur, false)
    : '<div class="empty">No run in progress. Tracking starts when you enter a run.</div>';

  const history = state.history || [];
  document.getElementById('history').innerHTML = history.length
    ? history.map((r) => renderRun(r, false)).join('')
    : '<div class="empty">No runs recorded yet.</div>';

  document.getElementById('toggle-overlay').textContent = settings.visible === false ? 'Show overlay' : 'Hide overlay';
}

let state = { current: null, history: [] };
let settings = { visible: true };

chrome.storage.local.get([PST.STORAGE_KEY, PST.SETTINGS_KEY], (res) => {
  state = res[PST.STORAGE_KEY] || state;
  settings = { ...settings, ...res[PST.SETTINGS_KEY] };
  render(state, settings);
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (changes[PST.STORAGE_KEY]) state = changes[PST.STORAGE_KEY].newValue || { current: null, history: [] };
  if (changes[PST.SETTINGS_KEY]) settings = { ...settings, ...changes[PST.SETTINGS_KEY].newValue };
  render(state, settings);
});

document.getElementById('toggle-overlay').addEventListener('click', () => {
  settings.visible = settings.visible === false;
  chrome.storage.local.set({ [PST.SETTINGS_KEY]: settings });
});

document.getElementById('clear').addEventListener('click', () => {
  if (!confirm('Clear all recorded runs?')) return;
  const current = state.current && !state.current.ended ? state.current : null;
  chrome.storage.local.set({ [PST.STORAGE_KEY]: { current, history: [], writer: 'popup' } });
});
