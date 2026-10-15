// Shared logic for the content script, the popup, the background worker and the tests.
// Stat card values taken from the game code (LevelUp module): each card applies its bonus once per pick.
var PST = (() => {
  // ---------- i18n ----------

  function t(key, ...subs) {
    let msg = '';
    try { msg = chrome.i18n.getMessage(key, subs.map(String)); } catch {}
    return msg || key;
  }

  const pct = (x) => `${Math.round(x * 100)}%`;

  // ---------- Stat cards ----------

  const STATS = [
    { id: 'atk',  game: 'Power · Potencia',          max: 40, effect: (n) => t('effAtk', pct(1.1 ** n - 1)) },
    { id: 'def',  game: 'Armor · Coraza',            max: 12, effect: (n) => t('effDef', Math.min(70, 6 * n)) },
    { id: 'hp',   game: 'Vigor',                     max: 0,  effect: (n) => t('effHp', 20 * n) },
    { id: 'rgn',  game: 'Synthesis · Síntesis',      max: 0,  effect: (n) => t('effRgn', (0.9 * n).toFixed(1)) },
    { id: 'xp',   game: 'Learning · Aprendizaje',    max: 8,  effect: (n) => t('effXp', pct(1.12 ** n - 1)) },
    { id: 'spd',  game: 'Sprint · Carrera',          max: 8,  effect: (n) => t('effSpd', pct(1.07 ** n - 1)) },
    { id: 'cd',   game: 'Reflexes · Reflejos',       max: 10, effect: (n) => t('effCd', pct(1 - 0.92 ** n)) },
    { id: 'mag',  game: 'Magnet · Imán',             max: 6,  effect: (n) => t('effMag', pct(1.3 ** n - 1)) },
    { id: 'heal', game: 'Sitrus Berry · Baya Zidra', max: 0,  effect: (n) => t('effHeal', n) },
  ];
  for (const s of STATS) s.label = t(`stat_${s.id}`);

  // Card titles as the game displays them (Spanish and English), without accents.
  const NAMES = {
    vigor: 'hp',
    potencia: 'atk', power: 'atk',
    carrera: 'spd', sprint: 'spd',
    reflejos: 'cd', reflexes: 'cd',
    coraza: 'def', armor: 'def',
    sintesis: 'rgn', synthesis: 'rgn',
    iman: 'mag', magnet: 'mag',
    aprendizaje: 'xp', learning: 'xp',
    'baya zidra': 'heal', 'sitrus berry': 'heal',
  };

  const norm = (s) => (s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();

  const BY_ID = Object.fromEntries(STATS.map((s) => [s.id, s]));

  function statIdFromTitle(title) {
    return NAMES[norm(title)] || null;
  }

  function emptyCounts() {
    return Object.fromEntries(STATS.map((s) => [s.id, 0]));
  }

  const KIND_LABEL = Object.fromEntries(['stat', 'new', 'up', 'evo', 'other'].map((k) => [k, t(`kind_${k}`)]));

  // What a level-up card is, from what the game shows on it.
  function classifyCard({ isEvo, chipText, title }) {
    if (isEvo) return { kind: 'evo', stat: null };
    if (/^(nuevo|new)\b/.test(norm(chipText))) return { kind: 'new', stat: null };
    if (/\d+\s*>\s*\d+/.test(chipText || '')) return { kind: 'up', stat: null };
    const stat = statIdFromTitle(title);
    return stat ? { kind: 'stat', stat } : { kind: 'other', stat: null };
  }

  // "2 > 3" → 3
  function moveLevel(tag) {
    const m = /(\d+)\s*>\s*(\d+)/.exec(tag || '');
    return m ? Number(m[2]) : null;
  }

  // The moves learned during a run, with their current level, in the order they were learned.
  function moves(run) {
    const byName = new Map();
    for (const p of run?.picks || []) {
      if (!['new', 'up', 'evo'].includes(p.kind)) continue;
      const key = norm(p.title);
      const prev = byName.get(key);
      if (p.kind === 'evo') byName.set(key, { title: p.title, level: null, evo: true });
      else if (p.kind === 'new') byName.set(key, { title: p.title, level: 1, evo: false });
      else byName.set(key, { title: p.title, level: moveLevel(p.tag) || (prev?.level || 0) + 1, evo: false });
    }
    return [...byName.values()];
  }

  // Damage output and damage intake relative to a run without stat cards.
  function power(counts) {
    const c = counts || {};
    const offense = 1.1 ** (c.atk || 0) / 0.92 ** (c.cd || 0);
    const toughness = 1 / (1 - Math.min(70, 6 * (c.def || 0)) / 100);
    return { offense, toughness };
  }

  // ---------- Tickets and time ----------

  // A ×10 ticket is worth ten tickets.
  const ticketValue = (tk) => (tk?.t1 || 0) + 10 * (tk?.t10 || 0);

  function runDuration(run, now = Date.now()) {
    if (!run?.startedAt) return null;
    const end = run.ended ? run.endedAt : now;
    return end ? Math.max(0, end - run.startedAt) : null;
  }

  // Ticket value per minute; null for runs too short to give a meaningful rate.
  function ticketRate(run, now = Date.now()) {
    const d = runDuration(run, now);
    return d && d >= 30000 ? ticketValue(run.tickets) / (d / 60000) : null;
  }

  function fmtDuration(ms) {
    if (ms == null) return '—';
    const s = Math.floor(ms / 1000);
    const h = Math.floor(s / 3600);
    const mm = String(Math.floor((s % 3600) / 60)).padStart(h ? 2 : 1, '0');
    const ss = String(s % 60).padStart(2, '0');
    return h ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
  }

  // The in-game time shown on the end screen.
  function gameTime(run) {
    return run?.result?.rows?.find(([k]) => ['tiempo', 'time', 'temps'].includes(norm(k)))?.[1] || null;
  }

  const dayKey = (time) => {
    const d = new Date(time);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  };

  // Ticket value collected today, over the history and the run in progress.
  function todayValue(state, now = Date.now()) {
    const today = dayKey(now);
    const runs = [...(state?.history || [])];
    const cur = state?.current;
    if (cur && !runs.some((r) => r.id === cur.id)) runs.push(cur);
    return runs.filter((r) => r.startedAt && dayKey(r.startedAt) === today).reduce((sum, r) => sum + ticketValue(r.tickets), 0);
  }

  // ---------- History ----------

  const HISTORY_MAX = 200; // unpinned runs kept
  const DETAIL_MAX = 30;   // most recent runs that keep the cards offered at each level-up

  function compactRun(run) {
    return { ...run, picks: run.picks.map(({ offered, desc, ...p }) => p) };
  }

  function pruneHistory(history) {
    let unpinned = 0;
    return history
      .filter((r) => r.pinned || ++unpinned <= HISTORY_MAX)
      .map((r, i) => (i >= DETAIL_MAX && !r.pinned && r.picks?.some((p) => p.offered || p.desc) ? compactRun(r) : r));
  }

  function addToHistory(history, run) {
    return pruneHistory([run, ...(history || []).filter((r) => r.id !== run.id)]);
  }

  const isRun = (r) => !!r && typeof r === 'object' && typeof r.startedAt === 'number' && Array.isArray(r.picks);

  // Runs from an export file: a full export ({ history: [...] }) or a bare array.
  function runsFromImport(data) {
    const list = Array.isArray(data) ? data : data?.history;
    if (!Array.isArray(list)) return null;
    return list.filter(isRun).map((r) => ({
      ...r,
      id: r.id ?? r.startedAt,
      ended: true,
      archived: true,
      counts: { ...emptyCounts(), ...r.counts },
      tickets: { t1: r.tickets?.t1 || 0, t10: r.tickets?.t10 || 0 },
    }));
  }

  // Adds the runs not already in the history, keeping it sorted from newest to oldest.
  function mergeHistory(history, runs) {
    const ids = new Set((history || []).map((r) => r.id));
    const added = runs.filter((r) => !ids.has(r.id));
    const merged = [...(history || []), ...added].sort((a, b) => b.startedAt - a.startedAt);
    return { history: pruneHistory(merged), added: added.length };
  }

  function summarize(runs) {
    const n = runs.length;
    const value = runs.reduce((s, r) => s + ticketValue(r.tickets), 0);
    const timed = runs.map((r) => runDuration(r)).filter((d) => d != null);
    const totalTime = timed.reduce((s, d) => s + d, 0);
    let best = null;
    for (const r of runs) if (!best || ticketValue(r.tickets) > ticketValue(best.tickets)) best = r;
    return {
      runs: n,
      t1: runs.reduce((s, r) => s + (r.tickets?.t1 || 0), 0),
      t10: runs.reduce((s, r) => s + (r.tickets?.t10 || 0), 0),
      value,
      avgValue: n ? value / n : 0,
      avgLevel: n ? runs.reduce((s, r) => s + (r.lastLevel || 0), 0) / n : 0,
      maxLevel: runs.reduce((m, r) => Math.max(m, r.lastLevel || 0), 0),
      avgDuration: timed.length ? totalTime / timed.length : null,
      rate: totalTime >= 30000 ? runs.filter((r) => runDuration(r) != null).reduce((s, r) => s + ticketValue(r.tickets), 0) / (totalTime / 60000) : null,
      best,
    };
  }

  // How often each card was offered and picked, over the picks that recorded their offer.
  function cardStats(runs) {
    const byName = new Map();
    const entry = (title) => {
      const key = norm(title);
      if (!byName.has(key)) byName.set(key, { title, offered: 0, picked: 0 });
      return byName.get(key);
    };
    for (const r of runs) {
      for (const p of r.picks || []) {
        if (!p.offered?.length) continue;
        for (const title of p.offered) entry(title).offered++;
        entry(p.title).picked++;
      }
    }
    return [...byName.values()].sort((a, b) => b.offered - a.offered || b.picked - a.picked);
  }

  function toCSV(runs) {
    const cell = (v) => {
      const s = String(v ?? '');
      return /[",\n;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const head = ['date', 'partner', 'level', 'duration_min', 'game_time', 'tickets', 'tickets_x10', 'ticket_value', 'result',
      ...STATS.map((s) => s.id), 'picks'];
    const rows = runs.map((r) => {
      const d = runDuration(r);
      return [
        new Date(r.startedAt).toISOString(), r.partner || '', r.lastLevel || 0, d == null ? '' : (d / 60000).toFixed(1),
        gameTime(r) || '', r.tickets?.t1 || 0, r.tickets?.t10 || 0, ticketValue(r.tickets), r.result?.title || '',
        ...STATS.map((s) => r.counts?.[s.id] || 0), r.picks.map((p) => p.title).join(' | '),
      ];
    });
    return [head, ...rows].map((row) => row.map(cell).join(',')).join('\n');
  }

  const DEFAULT_SETTINGS = { visible: true, collapsed: false, compact: false, pos: null, view: 'run', opacity: 1, scale: 1, goal: 0 };

  return {
    t, STATS, BY_ID, statIdFromTitle, emptyCounts, norm, KIND_LABEL, classifyCard, moveLevel, moves, power,
    ticketValue, runDuration, ticketRate, fmtDuration, gameTime, dayKey, todayValue,
    HISTORY_MAX, DETAIL_MAX, pruneHistory, addToHistory, runsFromImport, mergeHistory, summarize, cardStats, toCSV,
    DEFAULT_SETTINGS,
    STORAGE_KEY: 'pst_state', SETTINGS_KEY: 'pst_settings', STATUS_KEY: 'pst_status',
    SHORTCUT_KEY: 'pst_shortcut', GOAL_NOTIFIED_KEY: 'pst_goal_notified',
  };
})();

if (typeof module !== 'undefined') module.exports = PST;
