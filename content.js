// Tracks the cards picked at PokeSurvivor level-ups and the gacha tickets collected in each run.
// The game doesn't expose its state, so we read the DOM (#scr-levelup, #cards, #scr-over, menus)
// and, for live ticket counts, the save the game keeps in localStorage.
(() => {
  const $ = (id) => document.getElementById(id);
  const isOpen = (el) => !!el && !el.classList.contains('hidden');
  const { t } = PST;
  const instanceId = Math.random().toString(36).slice(2);
  const ATTACH_TIMEOUT = 10000;

  let state = { current: null, history: [] };
  let settings = { ...PST.DEFAULT_SETTINGS };
  let shortcut = '';
  let attached = false;
  let attachFailed = false;

  // ---------- Storage ----------

  function save() {
    state.writer = instanceId;
    chrome.storage.local.set({ [PST.STORAGE_KEY]: state });
  }

  function saveSettings() {
    chrome.storage.local.set({ [PST.SETTINGS_KEY]: settings });
  }

  function saveStatus() {
    chrome.storage.local.set({ [PST.STATUS_KEY]: { attached, at: Date.now() } });
  }

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    const changed = changes[PST.STORAGE_KEY];
    // Only adopt writes made elsewhere (popup, another tab): replaying our own
    // writes could roll the state back when two saves happen close together.
    if (changed && changed.newValue?.writer !== instanceId) {
      state = changed.newValue || { current: null, history: [] };
      state.history = state.history || [];
    }
    if (changes[PST.SETTINGS_KEY]) settings = { ...settings, ...changes[PST.SETTINGS_KEY].newValue };
    if (changes[PST.SHORTCUT_KEY]) shortcut = changes[PST.SHORTCUT_KEY].newValue || '';
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
    state.history = PST.addToHistory(state.history, run);
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
    const { kind, stat } = PST.classifyCard({ isEvo: card.classList.contains('evo'), chipText, title });
    return { kind, stat, title, tag: chipText };
  }

  // ---------- Pick detection ----------
  // Click (mouse / touch) or keys 1-3 tell us which card the player chose. The pick is
  // committed once the game closes the screen (solo) or marks the cards "done" (co-op);
  // the card the game marks as picked wins over the one we saw being chosen.

  let pending = null;  // card the player chose
  let offer = [];      // cards on screen
  let handled = true;  // this level-up's pick is recorded (or no level-up is open)

  function levelUpAcceptsPick() {
    return isOpen($('scr-levelup')) && !$('cards')?.classList.contains('done');
  }

  function readOffer() {
    if (!levelUpAcceptsPick()) return;
    const cards = [...($('cards')?.querySelectorAll('.card') || [])].map(readCard).filter((c) => c.title);
    if (cards.length) offer = cards;
  }

  function onLevelUpOpened() {
    const level = parseInt($('lvl-num')?.textContent, 10) || 0;
    const run = state.current;
    if (!run || run.ended || level < run.lastLevel) newRun(level);
    state.current.lastLevel = level;
    pending = null;
    offer = [];
    handled = false;
    readOffer();
    save();
    render();
  }

  function setPending(index) {
    const card = $('cards')?.querySelectorAll('.card')[index];
    if (!card || !levelUpAcceptsPick()) return;
    readOffer();
    pending = readCard(card);
  }

  function tryCommit() {
    if (handled) return;
    const cards = $('cards');
    const closed = !isOpen($('scr-levelup')) || cards?.classList.contains('done');
    if (!closed) {
      readOffer();
      return;
    }
    const picked = cards?.querySelector('.card.picked');
    const data = picked ? readCard(picked) : pending;
    if (!data) return;
    handled = true;
    pending = null;
    commit(data);
  }

  function commit(data) {
    if (!state.current || state.current.ended) newRun(parseInt($('lvl-num')?.textContent, 10) || 0);
    const run = state.current;
    const pick = { ...data, level: run.lastLevel, at: Date.now() };
    if (offer.length) pick.offered = offer.map((c) => c.title);
    run.picks.push(pick);
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

    new MutationObserver(tryCommit).observe(cards, { attributes: true, attributeFilter: ['class'], childList: true, subtree: true });

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
    attached = true;
    attachFailed = false;
    saveStatus();
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
        width: 21.5em; color: #f4f8ff; font: 13px/1.3 'Pixelify', system-ui, sans-serif;
        background: rgba(10, 20, 48, .88); border: 2px solid rgba(244, 248, 255, .25);
        border-radius: 10px; box-shadow: 0 6px 20px rgba(0, 0, 0, .45); user-select: none;
      }
      .head {
        display: flex; align-items: center; gap: 6px; padding: 6px 8px; cursor: move;
        border-bottom: 1px solid rgba(244, 248, 255, .15);
      }
      .logo { width: 1.4em; height: 1.4em; flex: none; image-rendering: pixelated; }
      .title { flex: 1; font-weight: 700; color: #ffd23f; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
      .sub { color: #9fb1c9; font-weight: 400; }
      button {
        all: unset; cursor: pointer; min-width: 1.55em; height: 1.55em; padding: 0 4px; box-sizing: border-box;
        text-align: center; line-height: 1.55em; border-radius: 5px; color: #c9d6ea; background: rgba(255, 255, 255, .08);
      }
      button:hover { background: rgba(255, 255, 255, .2); }
      button.on { background: #ffd23f; color: #0a1430; }
      .body { padding: 4px 8px 8px; max-height: 70vh; overflow-y: auto; }
      .collapsed .body, .compact .body, .compact .hist { display: none; }
      .collapsed .head, .compact .head { border-bottom: 0; }
      .tickets { display: flex; gap: 6px; padding: 4px 0 6px; }
      .tk { flex: 1; display: flex; align-items: center; gap: 6px; padding: 3px 6px; border-radius: 6px; background: rgba(255, 255, 255, .06); }
      .tk i { width: 14px; height: 10px; border-radius: 2px; flex: none; }
      .tk.t1 i { background: #ffd23f; box-shadow: inset -3px 0 #c08a10; }
      .tk.t10 i { background: #c47bff; box-shadow: inset -3px 0 #8a3fd0; }
      .tk b { margin-left: auto; color: #ffd23f; }
      .tk.t10 b { color: #d9a6ff; }
      .note { color: #9fb1c9; font-size: .77em; padding-bottom: 4px; }
      .warn { color: #ffb36b; font-size: .85em; padding: 4px 0; }
      .line { display: flex; justify-content: space-between; gap: 8px; color: #c9d6ea; font-size: .92em; padding: 2px 0; }
      .line b { color: #f4f8ff; }
      .goal { height: 6px; border-radius: 3px; background: rgba(255, 255, 255, .1); overflow: hidden; margin: 2px 0 4px; }
      .goal i { display: block; height: 100%; background: #7be08a; }
      .row { display: grid; grid-template-columns: 1fr auto; gap: 0 8px; padding: 3px 0; border-top: 1px solid rgba(244, 248, 255, .07); }
      .name { font-weight: 700; }
      .n { text-align: right; font-weight: 700; color: #ffd23f; }
      .eff { grid-column: 1 / -1; color: #c9d6ea; font-size: .92em; }
      .zero { opacity: .38; }
      .zero .n { color: inherit; }
      .maxed .n::after { content: ' MAX'; color: #7be08a; font-size: .77em; }
      .flash { animation: flash 1.2s ease-out; }
      @keyframes flash { from { background: rgba(255, 210, 63, .35); } to { background: transparent; } }
      .moves { margin-top: 6px; padding-top: 4px; border-top: 1px solid rgba(244, 248, 255, .15); }
      .moves h4 { margin: 0 0 2px; font-size: .85em; color: #9fb1c9; font-weight: 400; text-transform: uppercase; letter-spacing: .05em; }
      .mv { display: flex; justify-content: space-between; gap: 8px; padding: 1px 0; }
      .mv b { color: #ffd23f; }
      .mv b.evo { color: #7be08a; }
      .foot { margin-top: 6px; color: #9fb1c9; font-size: .85em; }
      .ended { color: #ff9b9b; }
      .hrun { padding: 5px 0; }
      .hrun + .hrun { border-top: 1px solid rgba(244, 248, 255, .1); }
      .hhead { display: flex; justify-content: space-between; gap: 6px; font-weight: 700; }
      .hmeta { color: #9fb1c9; font-size: .85em; }
      .hstats { color: #c9d6ea; font-size: .92em; }
      .empty { color: #9fb1c9; font-style: italic; padding: 6px 0; }
    </style>
    <div class="panel">
      <div class="head">
        <img class="logo" alt="">
        <div class="title"></div>
        <button class="hist"></button>
        <button class="collapse"></button>
        <button class="close">×</button>
      </div>
      <div class="body"><div class="content"></div><div class="foot"></div></div>
    </div>`;

  const panel = root.querySelector('.panel');
  const titleEl = root.querySelector('.title');
  const contentEl = root.querySelector('.content');
  const footEl = root.querySelector('.foot');
  const collapseBtn = root.querySelector('.collapse');
  const histBtn = root.querySelector('.hist');
  const closeBtn = root.querySelector('.close');
  root.querySelector('.logo').src = chrome.runtime.getURL('icons/icon32.png');
  histBtn.textContent = '☰';
  histBtn.title = t('runHistory');
  closeBtn.title = t('hide');

  // Keep the game from treating our clicks/touches as game input.
  for (const type of ['pointerdown', 'pointerup', 'mousedown', 'mouseup', 'touchstart', 'touchend', 'click', 'wheel']) {
    host.addEventListener(type, (e) => e.stopPropagation());
  }

  collapseBtn.addEventListener('click', () => {
    if (settings.compact) settings.compact = false;
    else settings.collapsed = !settings.collapsed;
    saveSettings();
    render();
  });
  histBtn.addEventListener('click', () => {
    settings.view = settings.view === 'history' ? 'run' : 'history';
    settings.collapsed = false;
    saveSettings();
    render();
  });
  closeBtn.addEventListener('click', () => {
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
      settings.pos = { x: ev.clientX - dx, y: ev.clientY - dy };
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

  // The saved position is kept as is; it is only clamped for display, so the panel stays
  // on screen when the window shrinks and goes back to its place when it grows again.
  function applyPos() {
    if (!settings.pos) {
      panel.style.left = panel.style.top = panel.style.right = '';
      return;
    }
    const x = Math.max(0, Math.min(window.innerWidth - panel.offsetWidth, settings.pos.x));
    const y = Math.max(0, Math.min(window.innerHeight - 30, settings.pos.y));
    panel.style.left = `${x}px`;
    panel.style.top = `${y}px`;
    panel.style.right = 'auto';
  }
  window.addEventListener('resize', applyPos);

  const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

  function ticketsHtml(run) {
    const tk = run?.tickets || { t1: 0, t10: 0 };
    const guest = run && !run.ended && !run.ticketBase;
    return `<div class="tickets">
        <span class="tk t1" title="${esc(t('ticketsTitle'))}"><i></i>${esc(t('tickets'))}<b>${tk.t1}</b></span>
        <span class="tk t10" title="${esc(t('tickets10Title'))}"><i></i>×10<b>${tk.t10}</b></span>
      </div>${guest ? `<div class="note">${esc(t('guestNote'))}</div>` : ''}`;
  }

  function liveText(run) {
    const rate = PST.ticketRate(run);
    return t('durationRate', PST.fmtDuration(PST.runDuration(run)), rate == null ? '—' : rate.toFixed(1));
  }

  function goalHtml() {
    if (!(settings.goal > 0)) return '';
    const value = PST.todayValue(state);
    const ratio = Math.min(1, value / settings.goal);
    return `<div class="line"><span>${esc(t('goalToday'))}</span><b>${value} / ${settings.goal}</b></div>
      <div class="goal"><i style="width:${Math.round(ratio * 100)}%"></i></div>`;
  }

  function movesHtml(run) {
    const list = PST.moves(run);
    if (!list.length) return '';
    return `<div class="moves"><h4>${esc(t('moves'))}</h4>${list.map((m) => `<div class="mv"><span>${esc(m.title)}</span>${
      m.evo ? `<b class="evo">${esc(t('kind_evo'))}</b>` : `<b>${esc(t('levelShort', m.level))}</b>`}</div>`).join('')}</div>`;
  }

  function renderRun(run, flashId) {
    const counts = run?.counts || PST.emptyCounts();
    const total = Object.values(counts).reduce((a, b) => a + b, 0);

    if (settings.compact) {
      const tk = run?.tickets || { t1: 0, t10: 0 };
      titleEl.innerHTML = run
        ? `${esc(t('levelShort', run.lastLevel))} <span class="sub">· 🎟 ${tk.t1} · ×10 ${tk.t10} · <span class="live">${esc(PST.fmtDuration(PST.runDuration(run)))}</span></span>`
        : `${esc(t('runStats'))} <span class="sub">· ${esc(t('waiting'))}</span>`;
      return;
    }

    titleEl.innerHTML = run
      ? `${esc(t('levelShort', run.lastLevel))} <span class="sub">· ${esc(t('statCount', total))}${run.partner ? ` · ${esc(run.partner)}` : ''}</span>`
      : `${esc(t('runStats'))} <span class="sub">· ${esc(t('waiting'))}</span>`;

    const { offense, toughness } = PST.power(counts);
    contentEl.innerHTML = ticketsHtml(run)
      + (run ? `<div class="line"><span class="live">${esc(liveText(run))}</span></div>` : '')
      + goalHtml()
      + `<div class="line" title="${esc(t('powerTitle'))}"><span>${esc(t('offense'))} <b>×${offense.toFixed(2)}</b></span><span>${esc(t('toughness'))} <b>×${toughness.toFixed(2)}</b></span></div>`
      + PST.STATS.map((s) => {
        const n = counts[s.id] || 0;
        const cls = ['row', n ? '' : 'zero', s.max && n >= s.max ? 'maxed' : '', flashId === s.id ? 'flash' : ''].join(' ');
        return `<div class="${cls}" title="${esc(s.game)}">
          <span class="name">${esc(s.label)}</span>
          <span class="n">${n}${s.max ? `<span class="sub">/${s.max}</span>` : ''}</span>
          <span class="eff">${n ? esc(s.effect(n)) : '—'}</span>
        </div>`;
      }).join('')
      + movesHtml(run);

    const last = run?.picks[run.picks.length - 1];
    let foot = last ? esc(t('lastPick', last.level, last.title, PST.KIND_LABEL[last.kind])) : esc(t('noPickYet'));
    if (run?.ended) foot += `<br><span class="ended">${esc(run.result?.title || t('runOver'))}</span>`;
    footEl.innerHTML = foot + '<br>' + shortcutHint();
  }

  function shortcutHint() {
    return esc(shortcut ? t('shortcutHint', shortcut) : t('noShortcutHint'));
  }

  function renderHistory() {
    const runs = state.history || [];
    titleEl.innerHTML = `${esc(t('runHistory'))} <span class="sub">· ${esc(t('runCount', runs.length))}</span>`;
    contentEl.innerHTML = runs.length ? runs.map((run) => {
      const time = PST.gameTime(run);
      const stats = PST.STATS.filter((s) => run.counts?.[s.id]).map((s) => `${esc(s.label)} ×${run.counts[s.id]}`).join(' · ');
      const tk = run.tickets || { t1: 0, t10: 0 };
      const date = new Date(run.startedAt).toLocaleString(undefined, { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
      const rate = PST.ticketRate(run);
      return `<div class="hrun">
        <div class="hhead"><span>${run.pinned ? '📌 ' : ''}${esc(run.partner || t('run'))}</span><span class="hmeta">${date}</span></div>
        <div class="hmeta">${esc(t('levelShort', run.lastLevel))}${time ? ` · ${esc(time)}` : ''} · ${esc(t('tickets'))} ${tk.t1} · ×10 ${tk.t10}${
          rate == null ? '' : ` · ${esc(t('perMin', rate.toFixed(1)))}`}</div>
        <div class="hstats">${stats || esc(t('noStatsPicked'))}</div>
      </div>`;
    }).join('') : `<div class="empty">${esc(t('noFinishedRuns'))}</div>`;
    footEl.innerHTML = esc(t('fullDetails')) + '<br>' + shortcutHint();
  }

  function render(flashId) {
    host.style.display = settings.visible ? '' : 'none';
    panel.style.opacity = String(settings.opacity ?? 1);
    panel.style.fontSize = `${13 * (settings.scale || 1)}px`;
    panel.classList.toggle('collapsed', settings.collapsed && !settings.compact);
    panel.classList.toggle('compact', !!settings.compact);
    collapseBtn.textContent = settings.collapsed || settings.compact ? '+' : '–';
    collapseBtn.title = settings.collapsed || settings.compact ? t('expand') : t('collapse');
    histBtn.classList.toggle('on', settings.view === 'history');
    applyPos();
    if (attachFailed) {
      titleEl.textContent = t('extName');
      contentEl.innerHTML = `<div class="warn">${esc(t('notAttached'))}</div>`;
      footEl.innerHTML = shortcutHint();
    } else if (settings.view === 'history' && !settings.compact) renderHistory();
    else renderRun(state.current, flashId);
  }

  // Keep the run duration and ticket rate ticking without redrawing the whole panel.
  setInterval(() => {
    const run = state.current;
    const live = root.querySelector('.live');
    if (!live || !run || run.ended || !settings.visible) return;
    live.textContent = settings.compact ? PST.fmtDuration(PST.runDuration(run)) : liveText(run);
  }, 1000);

  // ---------- Startup ----------

  chrome.storage.local.get([PST.STORAGE_KEY, PST.SETTINGS_KEY, PST.SHORTCUT_KEY], (res) => {
    if (res[PST.STORAGE_KEY]) state = res[PST.STORAGE_KEY];
    if (res[PST.SETTINGS_KEY]) settings = { ...settings, ...res[PST.SETTINGS_KEY] };
    shortcut = res[PST.SHORTCUT_KEY] || '';
    state.history = state.history || [];
    // A run left unfinished by a page reload can't be resumed by the game: file it away.
    // (Only on a fresh page load, not when re-injected into a page mid-run after an update.)
    if (state.current && !state.current.ended && performance.now() < 20000) endRun(null);
    document.documentElement.appendChild(host);
    render();
    if (!watch()) {
      // The game's HTML is static, but wait in case it isn't there yet;
      // past a few seconds, say so instead of failing silently.
      const started = Date.now();
      const timer = setInterval(() => {
        if (watch()) {
          clearInterval(timer);
          render();
        } else if (!attachFailed && Date.now() - started > ATTACH_TIMEOUT) {
          attachFailed = true;
          saveStatus();
          render();
        }
      }, 500);
    }
  });
})();
