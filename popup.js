const { t } = PST;
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const fmtDate = (time) => new Date(time).toLocaleString(undefined, { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
const pctOf = (a, b) => (b ? `${Math.round((a / b) * 100)}%` : '—');

// The popup can also be opened in a tab (file pickers close the popup on some systems).
const inTab = new URLSearchParams(location.search).has('tab');
document.body.classList.toggle('tab', inTab);
document.documentElement.lang = chrome.i18n.getUILanguage();

for (const el of document.querySelectorAll('[data-i18n]')) el.textContent = t(el.dataset.i18n);
for (const el of document.querySelectorAll('[data-i18n-title]')) el.title = t(el.dataset.i18nTitle);

let state = { current: null, history: [] };
let settings = { ...PST.DEFAULT_SETTINGS };
let status = null;
let partner = '';

// ---------- Rendering ----------

function sparkline(run) {
  const pts = [[0, 1], ...run.picks.filter((p) => p.at).map((p) => [p.at - run.startedAt, p.level])];
  if (pts.length < 3) return '';
  const maxX = Math.max(...pts.map(([x]) => x)) || 1;
  const maxY = Math.max(...pts.map(([, y]) => y)) || 1;
  const coords = pts.map(([x, y]) => `${((x / maxX) * 100).toFixed(1)},${(36 - (y / maxY) * 34).toFixed(1)}`).join(' ');
  return `<svg class="spark" viewBox="0 0 100 36" preserveAspectRatio="none" aria-label="${esc(t('levelCurve'))}"><polyline points="${coords}"/></svg>`;
}

function renderRun(run, { actions }) {
  const stats = PST.STATS.filter((s) => run.counts?.[s.id]);
  const statsHtml = stats.length
    ? `<div class="stats">${stats.map((s) => `
        <span>${esc(s.label)}</span>
        <span class="n">×${run.counts[s.id]}</span>
        <span class="eff">${esc(s.effect(run.counts[s.id]))}</span>`).join('')}</div>`
    : `<div class="empty">${esc(t('noStatsPicked'))}</div>`;

  const tk = run.tickets || { t1: 0, t10: 0 };
  const tickets = `<div class="tickets"><span class="tk t1"><i></i>${esc(t('tickets'))} <b>${tk.t1}</b></span><span class="tk t10"><i></i>×10 <b>${tk.t10}</b></span></div>`;

  const result = run.result?.rows?.length
    ? `<div class="result">${esc(run.result.title)} · ${run.result.rows.map(([k, v]) => `${esc(k)} <b>${esc(v)}</b>`).join(' · ')}</div>`
    : '';

  const rate = PST.ticketRate(run);
  const { offense, toughness } = PST.power(run.counts);
  const line = `<div class="line">
      <span>${esc(t('duration'))} <b>${esc(PST.fmtDuration(PST.runDuration(run)))}</b></span>
      <span>${esc(t('rate'))} <b>${rate == null ? '—' : esc(t('perMin', rate.toFixed(1)))}</b></span>
      <span title="${esc(t('powerTitle'))}">${esc(t('offense'))} <b>×${offense.toFixed(2)}</b> · ${esc(t('toughness'))} <b>×${toughness.toFixed(2)}</b></span>
    </div>`;

  const moves = PST.moves(run);
  const movesHtml = moves.length
    ? `<div class="moves">${esc(t('moves'))}: ${moves.map((m) => `<b>${esc(m.title)}</b> ${esc(m.evo ? t('kind_evo') : t('levelShort', m.level))}`).join(' · ')}</div>`
    : '';

  const picks = run.picks.map((p) => `
    <li class="${esc(p.kind)}"><span class="lv">${esc(t('levelShort', p.level))}</span>
      <span class="at">${p.at ? esc(PST.fmtDuration(p.at - run.startedAt)) : ''}</span>
      <span><span class="t">${esc(p.title)}</span> <span class="k">${esc(PST.KIND_LABEL[p.kind] || '')}${p.tag && p.kind !== 'stat' ? ' · ' + esc(p.tag) : ''}</span></span></li>`).join('');

  const btns = actions
    ? `<span class="run-btns">
        <button class="icon${run.pinned ? ' on' : ''}" data-act="pin" data-id="${esc(run.id)}" title="${esc(t(run.pinned ? 'unpin' : 'pin'))}">📌</button>
        <button class="icon danger" data-act="delete" data-id="${esc(run.id)}" title="${esc(t('deleteRun'))}">🗑</button>
      </span>`
    : '';

  return `<div class="run${run.pinned ? ' pinned' : ''}">
    <div class="run-head"><span>${esc(run.partner || t('run'))}</span><span class="meta">${fmtDate(run.startedAt)} · ${esc(t('levelShort', run.lastLevel))}</span>${btns}</div>
    ${result}
    ${tickets}
    ${line}
    ${statsHtml}
    ${movesHtml}
    <details><summary>${esc(t('cardsPicked', run.picks.length))}</summary>${sparkline(run)}<ol>${picks}</ol></details>
  </div>`;
}

function tile(label, value, sub = '') {
  return `<div class="tile"><div class="k">${esc(label)}</div><div class="v">${esc(value)}</div>${sub ? `<div class="s">${esc(sub)}</div>` : ''}</div>`;
}

function renderSummary(runs) {
  if (!runs.length) {
    $('summary').innerHTML = `<div class="empty">${esc(t('noRunsYet'))}</div>`;
    $('card-stats').innerHTML = '';
    return;
  }
  const s = PST.summarize(runs);
  $('summary').innerHTML = `<div class="summary">
    ${tile(t('runs'), s.runs)}
    ${tile(t('tickets'), s.t1, `×10 ${s.t10}`)}
    ${tile(t('ticketValue'), s.value, t('avgPerRun', s.avgValue.toFixed(1)))}
    ${tile(t('rate'), s.rate == null ? '—' : t('perMin', s.rate.toFixed(1)))}
    ${tile(t('avgLevel'), s.avgLevel.toFixed(1), t('maxLevel', s.maxLevel))}
    ${tile(t('avgDuration'), PST.fmtDuration(s.avgDuration))}
  </div>
  ${s.best && PST.ticketValue(s.best.tickets) > 0 ? `<div class="line">${esc(t('bestRun'))} <b>${esc(s.best.partner || t('run'))}</b> · ${fmtDate(s.best.startedAt)} · ${esc(t('ticketValue'))} <b>${PST.ticketValue(s.best.tickets)}</b></div>` : ''}`;

  const cards = PST.cardStats(runs).slice(0, 20);
  $('card-stats').innerHTML = cards.length
    ? `<table><tr><th>${esc(t('card'))}</th><th class="num">${esc(t('offered'))}</th><th class="num">${esc(t('picked'))}</th><th class="num">%</th></tr>${
      cards.map((c) => `<tr><td>${esc(c.title)}</td><td class="num">${c.offered}</td><td class="num">${c.picked}</td><td class="num">${pctOf(c.picked, c.offered)}</td></tr>`).join('')}</table>`
    : `<div class="empty">${esc(t('noOfferData'))}</div>`;
}

function renderPartners(history) {
  const partners = [...new Set(history.map((r) => r.partner).filter(Boolean))].sort();
  if (partner && !partners.includes(partner)) partner = '';
  $('partner').innerHTML = `<option value="">${esc(t('allPartners'))}</option>`
    + partners.map((p) => `<option value="${esc(p)}"${p === partner ? ' selected' : ''}>${esc(p)}</option>`).join('');
}

function renderGoal() {
  const goal = settings.goal || 0;
  $('goal-sec').hidden = !(goal > 0);
  if (!(goal > 0)) return;
  const value = PST.todayValue(state);
  $('goal').innerHTML = `<div class="line"><span>${esc(t('ticketValue'))} <b>${value} / ${goal}</b></span><span>${pctOf(Math.min(value, goal), goal)}</span></div>
    <div class="goal-bar"><i style="width:${Math.round(Math.min(1, value / goal) * 100)}%"></i></div>`;
}

function renderSettings() {
  $('toggle-overlay').textContent = settings.visible === false ? t('showOverlay') : t('hideOverlay');
  if (document.activeElement !== $('goal-input')) $('goal-input').value = settings.goal || '';
  $('opacity').value = settings.opacity ?? 1;
  $('scale').value = String(settings.scale || 1);
  $('compact').checked = !!settings.compact;
}

function render() {
  const history = state.history || [];
  const cur = state.current;
  $('current').innerHTML = cur && !cur.ended
    ? renderRun(cur, { actions: false })
    : `<div class="empty">${esc(t('noRunInProgress'))}</div>`;

  renderPartners(history);
  const runs = partner ? history.filter((r) => r.partner === partner) : history;
  renderSummary(runs);
  $('history').innerHTML = runs.length
    ? runs.map((r) => renderRun(r, { actions: true })).join('')
    : `<div class="empty">${esc(t('noRunsYet'))}</div>`;

  renderGoal();
  renderSettings();

  $('status').hidden = status?.attached !== false;
  $('status').textContent = t('notAttached');
}

// ---------- Writing ----------

function writeState(next) {
  state = { ...next, writer: 'popup' };
  chrome.storage.local.set({ [PST.STORAGE_KEY]: state });
}

function writeSettings(patch) {
  settings = { ...settings, ...patch };
  chrome.storage.local.set({ [PST.SETTINGS_KEY]: settings });
}

function download(name, type, text) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

const stamp = () => PST.dayKey(Date.now());

// ---------- Events ----------

chrome.storage.local.get([PST.STORAGE_KEY, PST.SETTINGS_KEY, PST.STATUS_KEY], (res) => {
  state = res[PST.STORAGE_KEY] || state;
  settings = { ...settings, ...res[PST.SETTINGS_KEY] };
  status = res[PST.STATUS_KEY] || null;
  render();
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (changes[PST.STORAGE_KEY]) state = changes[PST.STORAGE_KEY].newValue || { current: null, history: [] };
  if (changes[PST.SETTINGS_KEY]) settings = { ...settings, ...changes[PST.SETTINGS_KEY].newValue };
  if (changes[PST.STATUS_KEY]) status = changes[PST.STATUS_KEY].newValue || null;
  render();
});

chrome.commands.getAll((commands) => {
  const shortcut = commands.find((c) => c.name === 'toggle-overlay')?.shortcut || '';
  $('shortcut').textContent = shortcut || t('none');
  // Keep the overlay's copy in sync in case the shortcut was changed since the worker started.
  chrome.storage.local.set({ [PST.SHORTCUT_KEY]: shortcut });
});

$('change-shortcut').addEventListener('click', () => {
  const firefox = typeof browser !== 'undefined' && navigator.userAgent.includes('Firefox');
  chrome.tabs.create({ url: firefox ? 'about:addons' : 'chrome://extensions/shortcuts' });
});

$('toggle-overlay').addEventListener('click', () => writeSettings({ visible: settings.visible === false }));
$('open-tab').addEventListener('click', () => chrome.tabs.create({ url: chrome.runtime.getURL('popup.html?tab=1') }));
$('partner').addEventListener('change', (e) => {
  partner = e.target.value;
  render();
});

$('goal-input').addEventListener('change', (e) => writeSettings({ goal: Math.max(0, Math.round(Number(e.target.value) || 0)) }));
$('opacity').addEventListener('input', (e) => writeSettings({ opacity: Number(e.target.value) }));
$('scale').addEventListener('change', (e) => writeSettings({ scale: Number(e.target.value) }));
$('compact').addEventListener('change', (e) => writeSettings({ compact: e.target.checked, collapsed: false }));

$('history').addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-act]');
  if (!btn) return;
  const id = btn.dataset.id;
  const history = state.history || [];
  if (btn.dataset.act === 'pin') {
    writeState({ ...state, history: history.map((r) => (String(r.id) === id ? { ...r, pinned: !r.pinned } : r)) });
  } else if (btn.dataset.act === 'delete' && confirm(t('confirmDeleteRun'))) {
    writeState({ ...state, history: history.filter((r) => String(r.id) !== id) });
  }
});

$('clear').addEventListener('click', () => {
  if (!confirm(t('confirmClear'))) return;
  const current = state.current && !state.current.ended ? state.current : null;
  writeState({ current, history: (state.history || []).filter((r) => r.pinned) });
});

$('export-json').addEventListener('click', () => {
  download(`pokesurvivor-runs-${stamp()}.json`, 'application/json', JSON.stringify({ version: 1, exportedAt: Date.now(), history: state.history || [] }, null, 2));
});

$('export-csv').addEventListener('click', () => {
  download(`pokesurvivor-runs-${stamp()}.csv`, 'text/csv', '﻿' + PST.toCSV(state.history || []));
});

$('import').addEventListener('click', () => {
  if (inTab) $('import-file').click();
  else chrome.tabs.create({ url: chrome.runtime.getURL('popup.html?tab=1') });
});

$('import-file').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  let runs = null;
  try { runs = PST.runsFromImport(JSON.parse(await file.text())); } catch {}
  if (!runs) {
    $('import-msg').textContent = t('importInvalid');
    return;
  }
  const { history, added } = PST.mergeHistory(state.history || [], runs);
  writeState({ ...state, history });
  $('import-msg').textContent = t('importDone', added, runs.length - added);
});
