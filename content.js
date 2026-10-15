// Tracks the cards picked at PokeSurvivor level-ups and the gacha tickets collected in each run.
// The game doesn't expose its state, so we read the DOM (#scr-levelup, #cards, #scr-over, menus)
// and, for live ticket counts, the save the game keeps in localStorage.
(() => {
  const $ = (id) => document.getElementById(id);
  const isOpen = (el) => !!el && !el.classList.contains('hidden');
  const HISTORY_MAX = 30;
  const instanceId = Math.random().toString(36).slice(2);

  let state = { current: null, history: [] };
  let settings = { visible: true, collapsed: false, pos: null, view: 'run' };

  // ---------- Storage ----------

  function save() {
    state.writer = instanceId;
    chrome.storage.local.set({ [PST.STORAGE_KEY]: state });
  }

  function saveSettings() {
    chrome.storage.local.set({ [PST.SETTINGS_KEY]: settings });
  }

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    const changed = changes[PST.STORAGE_KEY];
    // Only adopt writes made elsewhere (popup, another tab): replaying our own
    // writes could roll the state back when two saves happen close together.
    if (changed && changed.newValue?.writer !== instanceId) state = changed.newValue || { current: null, history: [] };
    if (changes[PST.SETTINGS_KEY]) settings = { ...settings, ...changes[PST.SETTINGS_KEY].newValue };
    render();
  });

  // ---------- Tickets ----------
  // The game saves the account (including its ticket balance) to localStorage under
  // ps.save.<id> or ps.cloud.<uid> each time a ticket is picked up. Guests have no save,
  // so for them the count only comes from the end-of-run screen.

  const saveCache = new Map();

  function readTicketBalance() {
    let best = null;
    try {
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        if (!/^ps\.(save|cloud)\./.test(key)) continue;
        const raw = localStorage.getItem(key);
        let entry = saveCache.get(key);
        if (!entry || entry.raw !== raw) {
          let parsed = null;
          try { parsed = JSON.parse(raw); } catch {}
          entry = { raw, save: parsed };
          saveCache.set(key, entry);
        }
        const s = entry.save;
        if (s?.tickets && (!best || (s.updated || 0) > (best.updated || 0))) best = s;
      }
    } catch {}
    return best ? { t1: best.tickets.t1 || 0, t10: best.tickets.t10 || 0 } : null;
  }

  function pollTickets() {
    const run = state.current;
    if (!run || run.ended || !run.ticketBase) return;
    const now = readTicketBalance();
    if (!now) return;
    const t1 = Math.max(0, now.t1 - run.ticketBase.t1);
    const t10 = Math.max(0, now.t10 - run.ticketBase.t10);
    if (t1 === run.tickets.t1 && t10 === run.tickets.t10) return;
    run.tickets = { t1, t10 };
    save();
    render();
  }

  function readOverTickets() {
    const res = { t1: 0, t10: 0 };
    for (const row of $('over-stats')?.children || []) {
      if (!PST.norm(row.querySelector('span')?.textContent).includes('ticket')) continue;
      for (const img of row.querySelectorAll('img')) {
        const m = /\+\s*(\d+)/.exec(img.nextSibling?.textContent || '');
        if (!m) continue;
        // The ×10 ticket icon is the purple one.
        res[/c47bff/i.test(img.getAttribute('src') || '') ? 't10' : 't1'] += Number(m[1]);
      }
    }
    return res;
  }

  // ---------- Runs ----------

  function newRun(level) {
    archiveCurrent();
    state.current = {
      id: Date.now(),
      startedAt: Date.now(),
      partner: ($('menu-partner-name')?.textContent || '').trim(),
      lastLevel: level,
      ended: false,
      counts: PST.emptyCounts(),
      tickets: { t1: 0, t10: 0 },
      ticketBase: readTicketBalance(),
      picks: [],
    };
  }

  function hasContent(run) {
    return run.picks.length > 0 || run.tickets?.t1 > 0 || run.tickets?.t10 > 0;
  }

  function archiveCurrent() {
    const run = state.current;
    if (!run || run.archived || !hasContent(run)) return;
    run.archived = true;
    state.history.unshift(run);
    state.history.length = Math.min(state.history.length, HISTORY_MAX);
  }

  // result/tickets come from the end screen; without one (quit, reload) we keep what we tracked.
  function endRun(result, tickets) {
    const run = state.current;
    if (!run || run.ended) return;
    if (tickets) run.tickets = tickets;
    else pollTickets();
    run.ended = true;
    run.endedAt = Date.now();
    if (result) run.result = result;
    delete run.ticketBase;
    archiveCurrent();
    save();
    render();
  }

  function onRunStart() {
    newRun(1);
    save();
    render();
  }

  function onLevelUpOpened() {
    const level = parseInt($('lvl-num')?.textContent, 10) || 0;
    const run = state.current;
    if (!run || run.ended || level < run.lastLevel) newRun(level);
    state.current.lastLevel = level;
    save();
    render();
  }

  function onGameOver() {
    const run = state.current;
    if (!run || run.ended) return;
    // Let the game translate the screen content before reading it.
    setTimeout(() => {
      const rows = [...($('over-stats')?.children || [])]
        .map((d) => [d.querySelector('span')?.textContent.trim() || '', d.querySelector('b')?.textContent.replace(/\s+/g, ' ').trim() || ''])
        .filter(([k]) => k && !PST.norm(k).includes('ticket'));
      // The end screen has the exact ticket counts (and works for guests too).
      endRun({ title: ($('over-title')?.textContent || '').trim(), rows }, readOverTickets());
    }, 150);
  }

  // ---------- Reading a card ----------

  function readCard(card) {
    const nm = card.querySelector('.nm');
    const chip = nm?.querySelector('.tag-chip');
    const chipText = (chip?.textContent || '').trim();
    let title = '';
    for (const n of nm?.childNodes || []) if (n !== chip) title += n.textContent;
    title = title.trim();
    const desc = (card.querySelector('.ds')?.textContent || '').trim();

    let kind;
    let stat = null;
    if (card.classList.contains('evo')) kind = 'evo';
    else if (/^(nuevo|new)\b/.test(PST.norm(chipText))) kind = 'new';
    else if (/\d+\s*>\s*\d+/.test(chipText)) kind = 'up';
    else if ((stat = PST.statIdFromTitle(title))) kind = 'stat';
    else kind = 'other';

    return { kind, stat, title, tag: chipText, desc };
  }

  // ---------- Pick detection ----------
  // Click (mouse / touch) or keys 1-3. A pick is only committed once the game
  // closes the screen (solo) or marks the cards "done" (co-op).

  let pending = null;
  let pendingTimer = 0;

  function levelUpAcceptsPick() {
    return isOpen($('scr-levelup')) && !$('cards')?.classList.contains('done');
  }

  function setPending(index) {
    const card = $('cards')?.querySelectorAll('.card')[index];
    if (!card || !levelUpAcceptsPick()) return;
    pending = { index, data: readCard(card) };
    clearTimeout(pendingTimer);
    pendingTimer = setTimeout(() => (pending = null), 2000);
  }

  function tryCommit() {
    if (!pending) return;
    const cards = $('cards');
    const closed = !isOpen($('scr-levelup')) || cards?.classList.contains('done');
    if (!closed) return;
    const picked = cards?.querySelector('.card.picked');
    let data = pending.data;
    if (picked) data = readCard(picked);
    pending = null;
    clearTimeout(pendingTimer);
    commit(data);
  }

  function commit(data) {
    if (!state.current || state.current.ended) newRun(parseInt($('lvl-num')?.textContent, 10) || 0);
    const run = state.current;
    run.picks.push({ ...data, level: run.lastLevel, at: Date.now() });
    if (data.kind === 'stat') run.counts[data.stat] = (run.counts[data.stat] || 0) + 1;
    save();
    render(data.kind === 'stat' ? data.stat : null);
  }

  document.addEventListener('click', (e) => {
    const card = e.target.closest?.('#cards .card');
    if (!card) return;
    setPending([...card.parentNode.children].indexOf(card));
  }, true);

  document.addEventListener('keydown', (e) => {
    if (e.repeat) return;
    const m = /^(?:Digit|Numpad)([1-3])$/.exec(e.code);
    if (m) setPending(Number(m[1]) - 1);
    if (e.altKey && e.code === 'KeyT') {
      settings.visible = !settings.visible;
      saveSettings();
      render();
    }
  }, true);

  // ---------- Watching the game DOM ----------

  function watch() {
    const lvl = $('scr-levelup');
    const cards = $('cards');
    const over = $('scr-over');
    const menu = $('scr-menu');
    if (!lvl || !cards || !over || !menu) return false;

    let lvlWasOpen = isOpen(lvl);
    new MutationObserver(() => {
      const open = isOpen(lvl);
      if (open && !lvlWasOpen) onLevelUpOpened();
      lvlWasOpen = open;
      tryCommit();
    }).observe(lvl, { attributes: true, attributeFilter: ['class'] });

    new MutationObserver(tryCommit).observe(cards, { attributes: true, attributeFilter: ['class'], subtree: true });

    let overWasOpen = isOpen(over);
    new MutationObserver(() => {
      const open = isOpen(over);
      if (open && !overWasOpen) onGameOver();
      overWasOpen = open;
    }).observe(over, { attributes: true, attributeFilter: ['class'] });

    // A run starts when the game leaves the main menu (or the co-op lobby) for the map,
    // and is over if we get back to the menu without an end screen (quit, crash…).
    const screens = [...document.querySelectorAll('section.scr')];
    const inMenu = () => isOpen(menu) || isOpen($('scr-lobby'));
    let wasInMenu = inMenu();
    const screenObserver = new MutationObserver(() => {
      const nowInMenu = inMenu();
      if (wasInMenu && !nowInMenu && !screens.some(isOpen)) onRunStart();
      if (nowInMenu && state.current && !state.current.ended) endRun(null);
      wasInMenu = nowInMenu;
    });
    for (const s of screens) screenObserver.observe(s, { attributes: true, attributeFilter: ['class'] });

    setInterval(pollTickets, 1000);
    return true;
  }

  // ---------- Overlay ----------
  // Shadow DOM: isolates styles and keeps the game's translator from rewriting our text.

  // After an extension update, the previous instance may still be in the page.
  document.getElementById('pst-overlay-host')?.remove();
  const host = document.createElement('div');
  host.id = 'pst-overlay-host';
  const root = host.attachShadow({ mode: 'closed' });
  root.innerHTML = `
    <style>
      :host { all: initial; }
      .panel {
        position: fixed; top: 70px; right: 12px; z-index: 2147483000;
        width: 280px; color: #f4f8ff; font: 13px/1.3 'Pixelify', system-ui, sans-serif;
        background: rgba(10, 20, 48, .88); border: 2px solid rgba(244, 248, 255, .25);
        border-radius: 10px; box-shadow: 0 6px 20px rgba(0, 0, 0, .45); user-select: none;
      }
      .head {
        display: flex; align-items: center; gap: 6px; padding: 6px 8px; cursor: move;
        border-bottom: 1px solid rgba(244, 248, 255, .15);
      }
      .title { flex: 1; font-weight: 700; color: #ffd23f; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
      .sub { color: #9fb1c9; font-weight: 400; }
      button {
        all: unset; cursor: pointer; min-width: 20px; height: 20px; padding: 0 4px; box-sizing: border-box;
        text-align: center; line-height: 20px; border-radius: 5px; color: #c9d6ea; background: rgba(255, 255, 255, .08);
      }
      button:hover { background: rgba(255, 255, 255, .2); }
      button.on { background: #ffd23f; color: #0a1430; }
      .body { padding: 4px 8px 8px; max-height: 70vh; overflow-y: auto; }
      .collapsed .body { display: none; }
      .collapsed .head { border-bottom: 0; }
      .tickets { display: flex; gap: 6px; padding: 4px 0 6px; }
      .tk { flex: 1; display: flex; align-items: center; gap: 6px; padding: 3px 6px; border-radius: 6px; background: rgba(255, 255, 255, .06); }
      .tk i { width: 14px; height: 10px; border-radius: 2px; flex: none; }
      .tk.t1 i { background: #ffd23f; box-shadow: inset -3px 0 #c08a10; }
      .tk.t10 i { background: #c47bff; box-shadow: inset -3px 0 #8a3fd0; }
      .tk b { margin-left: auto; color: #ffd23f; }
      .tk.t10 b { color: #d9a6ff; }
      .note { color: #9fb1c9; font-size: 10px; padding-bottom: 4px; }
      .row { display: grid; grid-template-columns: 1fr auto; gap: 0 8px; padding: 3px 0; border-top: 1px solid rgba(244, 248, 255, .07); }
      .name { font-weight: 700; }
      .n { text-align: right; font-weight: 700; color: #ffd23f; }
      .eff { grid-column: 1 / -1; color: #c9d6ea; font-size: 12px; }
      .zero { opacity: .38; }
      .zero .n { color: inherit; }
      .maxed .n::after { content: ' MAX'; color: #7be08a; font-size: 10px; }
      .flash { animation: flash 1.2s ease-out; }
      @keyframes flash { from { background: rgba(255, 210, 63, .35); } to { background: transparent; } }
      .foot { margin-top: 6px; color: #9fb1c9; font-size: 11px; }
      .ended { color: #ff9b9b; }
      .hrun { padding: 5px 0; }
      .hrun + .hrun { border-top: 1px solid rgba(244, 248, 255, .1); }
      .hhead { display: flex; justify-content: space-between; gap: 6px; font-weight: 700; }
      .hmeta { color: #9fb1c9; font-size: 11px; }
      .hstats { color: #c9d6ea; font-size: 12px; }
      .empty { color: #9fb1c9; font-style: italic; padding: 6px 0; }
    </style>
    <div class="panel">
      <div class="head">
        <div class="title"></div>
        <button class="hist" title="Run history">History</button>
        <button class="collapse" title="Collapse"></button>
        <button class="close" title="Hide (Alt+T)">×</button>
      </div>
      <div class="body"><div class="content"></div><div class="foot"></div></div>
    </div>`;

  const panel = root.querySelector('.panel');
  const titleEl = root.querySelector('.title');
  const contentEl = root.querySelector('.content');
  const footEl = root.querySelector('.foot');
  const collapseBtn = root.querySelector('.collapse');
  const histBtn = root.querySelector('.hist');

  // Keep the game from treating our clicks/touches as game input.
  for (const t of ['pointerdown', 'pointerup', 'mousedown', 'mouseup', 'touchstart', 'touchend', 'click', 'wheel']) {
    host.addEventListener(t, (e) => e.stopPropagation());
  }

  collapseBtn.addEventListener('click', () => {
    settings.collapsed = !settings.collapsed;
    saveSettings();
    render();
  });
  histBtn.addEventListener('click', () => {
    settings.view = settings.view === 'history' ? 'run' : 'history';
    settings.collapsed = false;
    saveSettings();
    render();
  });
  root.querySelector('.close').addEventListener('click', () => {
    settings.visible = false;
    saveSettings();
    render();
  });

  // Drag by the title bar.
  const head = root.querySelector('.head');
  head.addEventListener('pointerdown', (e) => {
    if (e.target.closest('button')) return;
    const r = panel.getBoundingClientRect();
    const dx = e.clientX - r.left;
    const dy = e.clientY - r.top;
    head.setPointerCapture(e.pointerId);
    const move = (ev) => {
      const x = Math.max(0, Math.min(window.innerWidth - r.width, ev.clientX - dx));
      const y = Math.max(0, Math.min(window.innerHeight - 30, ev.clientY - dy));
      settings.pos = { x, y };
      applyPos();
    };
    const up = () => {
      head.removeEventListener('pointermove', move);
      head.removeEventListener('pointerup', up);
      saveSettings();
    };
    head.addEventListener('pointermove', move);
    head.addEventListener('pointerup', up);
  });

  function applyPos() {
    if (!settings.pos) return;
    panel.style.left = `${settings.pos.x}px`;
    panel.style.top = `${settings.pos.y}px`;
    panel.style.right = 'auto';
  }

  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

  function ticketsHtml(run) {
    const t = run?.tickets || { t1: 0, t10: 0 };
    const guest = run && !run.ended && !run.ticketBase;
    return `<div class="tickets">
        <span class="tk t1" title="Gacha tickets"><i></i>Tickets<b>${t.t1}</b></span>
        <span class="tk t10" title="×10 gacha tickets"><i></i>×10<b>${t.t10}</b></span>
      </div>${guest ? '<div class="note">Playing as guest: tickets are counted at the end of the run.</div>' : ''}`;
  }

  function renderRun(run, flashId) {
    const counts = run?.counts || PST.emptyCounts();
    const total = Object.values(counts).reduce((a, b) => a + b, 0);
    titleEl.innerHTML = run
      ? `Run stats <span class="sub">· Lv ${run.lastLevel} · ${total} stat${total === 1 ? '' : 's'}</span>`
      : 'Run stats <span class="sub">· waiting</span>';

    contentEl.innerHTML = ticketsHtml(run) + PST.STATS.map((s) => {
      const n = counts[s.id] || 0;
      const cls = ['row', n ? '' : 'zero', s.max && n >= s.max ? 'maxed' : '', flashId === s.id ? 'flash' : ''].join(' ');
      return `<div class="${cls}" title="${esc(s.game)}">
        <span class="name">${esc(s.label)}</span>
        <span class="n">${n}${s.max ? `<span class="sub">/${s.max}</span>` : ''}</span>
        <span class="eff">${n ? esc(s.effect(n)) : '—'}</span>
      </div>`;
    }).join('');

    const last = run?.picks[run.picks.length - 1];
    let foot = last ? `Last pick (Lv ${last.level}): ${esc(last.title)} · ${esc(PST.KIND_LABEL[last.kind])}` : 'No card picked yet.';
    if (run?.ended) foot += `<br><span class="ended">${esc(run.result?.title || 'Run over')}</span>`;
    footEl.innerHTML = foot + '<br>Alt+T to show / hide';
  }

  function renderHistory() {
    const runs = state.history || [];
    titleEl.innerHTML = `Run history <span class="sub">· ${runs.length} run${runs.length === 1 ? '' : 's'}</span>`;
    contentEl.innerHTML = runs.length ? runs.map((run) => {
      const time = run.result?.rows?.find(([k]) => ['tiempo', 'time'].includes(PST.norm(k)))?.[1];
      const stats = PST.STATS.filter((s) => run.counts?.[s.id]).map((s) => `${esc(s.label)} ×${run.counts[s.id]}`).join(' · ');
      const t = run.tickets || { t1: 0, t10: 0 };
      const date = new Date(run.startedAt).toLocaleString(undefined, { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
      return `<div class="hrun">
        <div class="hhead"><span>${esc(run.partner || 'Run')}</span><span class="hmeta">${date}</span></div>
        <div class="hmeta">Lv ${run.lastLevel}${time ? ` · ${esc(time)}` : ''} · Tickets ${t.t1} · ×10 ${t.t10}</div>
        <div class="hstats">${stats || 'No stats picked'}</div>
      </div>`;
    }).join('') : '<div class="empty">No finished runs yet. A run is saved here when it ends.</div>';
    footEl.innerHTML = 'Full details in the extension popup.<br>Alt+T to show / hide';
  }

  function render(flashId) {
    host.style.display = settings.visible ? '' : 'none';
    panel.classList.toggle('collapsed', settings.collapsed);
    collapseBtn.textContent = settings.collapsed ? '+' : '–';
    histBtn.classList.toggle('on', settings.view === 'history');
    applyPos();
    if (settings.view === 'history') renderHistory();
    else renderRun(state.current, flashId);
  }

  // ---------- Startup ----------

  chrome.storage.local.get([PST.STORAGE_KEY, PST.SETTINGS_KEY], (res) => {
    if (res[PST.STORAGE_KEY]) state = res[PST.STORAGE_KEY];
    if (res[PST.SETTINGS_KEY]) settings = { ...settings, ...res[PST.SETTINGS_KEY] };
    state.history = state.history || [];
    // A run left unfinished by a page reload can't be resumed by the game: file it away.
    // (Only on a fresh page load, not when re-injected into a page mid-run after an update.)
    if (state.current && !state.current.ended && performance.now() < 20000) endRun(null);
    document.documentElement.appendChild(host);
    render();
    if (!watch()) {
      // The game's HTML is static, but wait in case it isn't there yet.
      const timer = setInterval(() => watch() && clearInterval(timer), 500);
    }
  });
})();
