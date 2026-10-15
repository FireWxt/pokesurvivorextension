// Run with: npm test (node --test, no dependencies).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const locale = (lang) => JSON.parse(fs.readFileSync(path.join(ROOT, '_locales', lang, 'messages.json'), 'utf8'));
const en = locale('en');

// Minimal chrome.i18n: English messages with Chrome's $1…$9 substitution.
globalThis.chrome = {
  i18n: {
    getMessage: (key, subs = []) => (en[key] ? en[key].message.replace(/\$(\d)/g, (_, i) => subs[i - 1] ?? '') : ''),
  },
};
const PST = require('../stats.js');

const run = (over = {}) => ({
  id: 1, startedAt: 1_000_000, ended: true, endedAt: 1_000_000 + 10 * 60000, lastLevel: 10,
  counts: PST.emptyCounts(), tickets: { t1: 0, t10: 0 }, picks: [], ...over,
});

test('stat cards are recognised in Spanish and English, with or without accents', () => {
  assert.equal(PST.statIdFromTitle('Síntesis'), 'rgn');
  assert.equal(PST.statIdFromTitle('  IMÁN '), 'mag');
  assert.equal(PST.statIdFromTitle('Sitrus   Berry'), 'heal');
  assert.equal(PST.statIdFromTitle('Lanzallamas'), null);
});

test('classifyCard', () => {
  assert.deepEqual(PST.classifyCard({ isEvo: true, chipText: '', title: 'Charizard' }), { kind: 'evo', stat: null });
  assert.equal(PST.classifyCard({ chipText: 'NUEVO', title: 'Ascuas' }).kind, 'new');
  assert.equal(PST.classifyCard({ chipText: 'New!', title: 'Ember' }).kind, 'new');
  assert.equal(PST.classifyCard({ chipText: '2 > 3', title: 'Ember' }).kind, 'up');
  assert.deepEqual(PST.classifyCard({ chipText: '', title: 'Potencia' }), { kind: 'stat', stat: 'atk' });
  assert.equal(PST.classifyCard({ chipText: '', title: '???' }).kind, 'other');
});

test('moves follow new / upgrade / evolution picks', () => {
  assert.equal(PST.moveLevel('2 > 3'), 3);
  assert.equal(PST.moveLevel(''), null);
  const r = run({ picks: [
    { kind: 'new', title: 'Ember' },
    { kind: 'stat', title: 'Power', stat: 'atk' },
    { kind: 'up', title: 'Ember', tag: '1 > 2' },
    { kind: 'up', title: 'Ember', tag: '' },
    { kind: 'new', title: 'Scratch' },
    { kind: 'evo', title: 'Inferno' },
  ] });
  assert.deepEqual(PST.moves(r), [
    { title: 'Ember', level: 3, evo: false },
    { title: 'Scratch', level: 1, evo: false },
    { title: 'Inferno', level: null, evo: true },
  ]);
});

test('stat effects', () => {
  assert.equal(PST.BY_ID.atk.effect(2), '+21% damage');
  assert.equal(PST.BY_ID.def.effect(20), '-70% damage taken');
  assert.equal(PST.BY_ID.rgn.effect(3), '+2.7 HP/s');
  assert.equal(PST.BY_ID.cd.effect(1), '-8% cooldown');
  assert.equal(PST.BY_ID.atk.label, 'Damage');
});

test('power', () => {
  assert.deepEqual(PST.power({}), { offense: 1, toughness: 1 });
  const p = PST.power({ atk: 1, cd: 1, def: 5 });
  assert.ok(Math.abs(p.offense - 1.1 / 0.92) < 1e-9);
  assert.ok(Math.abs(p.toughness - 1 / 0.7) < 1e-9);
});

test('tickets and time', () => {
  const r = run({ tickets: { t1: 5, t10: 1 } });
  assert.equal(PST.ticketValue(r.tickets), 15);
  assert.equal(PST.runDuration(r), 10 * 60000);
  assert.equal(PST.ticketRate(r), 1.5);
  assert.equal(PST.ticketRate(run({ endedAt: 1_000_000 + 5000 })), null);
  assert.equal(PST.runDuration(run({ endedAt: undefined })), null);
  assert.equal(PST.runDuration(run({ ended: false, endedAt: undefined }), 1_000_000 + 3000), 3000);
  assert.equal(PST.fmtDuration(65_000), '1:05');
  assert.equal(PST.fmtDuration(3_725_000), '1:02:05');
  assert.equal(PST.fmtDuration(null), '—');
  assert.equal(PST.gameTime(run({ result: { rows: [['Tiempo', '12:34']] } })), '12:34');
});

test('todayValue counts the current run once', () => {
  const now = Date.now();
  const cur = run({ id: 2, startedAt: now, tickets: { t1: 3, t10: 0 } });
  const old = run({ id: 3, startedAt: now - 3 * 86400000, tickets: { t1: 100, t10: 0 } });
  assert.equal(PST.todayValue({ current: cur, history: [cur, old] }, now), 3);
  assert.equal(PST.todayValue({ current: cur, history: [old] }, now), 3);
});

test('pruneHistory keeps pinned runs and compacts old ones', () => {
  const runs = Array.from({ length: PST.HISTORY_MAX + 5 }, (_, i) =>
    run({ id: i, startedAt: 1e9 - i, pinned: i === PST.HISTORY_MAX + 2, picks: [{ kind: 'other', title: 'x', offered: ['x', 'y'] }] }));
  const pruned = PST.pruneHistory(runs);
  assert.equal(pruned.length, PST.HISTORY_MAX + 1);
  assert.ok(pruned.some((r) => r.id === PST.HISTORY_MAX + 2));
  assert.ok(pruned[0].picks[0].offered);
  assert.equal(pruned[PST.DETAIL_MAX].picks[0].offered, undefined);
  assert.ok(pruned.at(-1).picks[0].offered, 'pinned runs keep their details');
});

test('import and merge', () => {
  assert.equal(PST.runsFromImport({ foo: 1 }), null);
  const runs = PST.runsFromImport({ history: [run({ id: 10, startedAt: 10 }), { bad: true }, run({ id: 1, startedAt: 30 })] });
  assert.equal(runs.length, 2);
  const { history, added } = PST.mergeHistory([run({ id: 1, startedAt: 30 }), run({ id: 2, startedAt: 20 })], runs);
  assert.equal(added, 1);
  assert.deepEqual(history.map((r) => r.id), [1, 2, 10]);
});

test('summarize and cardStats', () => {
  const a = run({ id: 1, lastLevel: 10, tickets: { t1: 10, t10: 0 }, picks: [{ kind: 'stat', title: 'Power', offered: ['Power', 'Vigor', 'Ember'] }] });
  const b = run({ id: 2, lastLevel: 20, tickets: { t1: 0, t10: 2 }, picks: [{ kind: 'stat', title: 'Vigor', offered: ['Power', 'Vigor'] }, { kind: 'new', title: 'Ember' }] });
  const s = PST.summarize([a, b]);
  assert.equal(s.runs, 2);
  assert.equal(s.value, 30);
  assert.equal(s.avgLevel, 15);
  assert.equal(s.maxLevel, 20);
  assert.equal(s.best.id, 2);
  assert.equal(s.rate, 30 / 20);
  assert.deepEqual(PST.cardStats([a, b]).map((c) => [c.title, c.offered, c.picked]), [['Power', 2, 1], ['Vigor', 2, 1], ['Ember', 1, 0]]);
});

test('toCSV quotes cells that need it', () => {
  const csv = PST.toCSV([run({ partner: 'Pika, "chu"', picks: [{ title: 'A' }, { title: 'B' }] })]);
  const [head, row] = csv.split('\n');
  assert.ok(head.startsWith('date,partner,level'));
  assert.ok(row.includes('"Pika, ""chu"""'));
  assert.ok(row.endsWith('A | B'));
});

test('every locale has the same keys, and every key used in the code exists', () => {
  const keys = Object.keys(en).sort();
  for (const lang of fs.readdirSync(path.join(ROOT, '_locales'))) {
    assert.deepEqual(Object.keys(locale(lang)).sort(), keys, lang);
  }
  const src = ['stats.js', 'content.js', 'popup.js', 'background.js', 'popup.html', 'manifest.json']
    .map((f) => fs.readFileSync(path.join(ROOT, f), 'utf8')).join('\n');
  const used = new Set([
    ...[...src.matchAll(/\bt\('(\w+)'/g)].map((m) => m[1]),
    ...[...src.matchAll(/data-i18n(?:-title)?="(\w+)"/g)].map((m) => m[1]),
    ...[...src.matchAll(/__MSG_(\w+)__/g)].map((m) => m[1]),
    ...PST.STATS.map((s) => `stat_${s.id}`),
    ...Object.keys(PST.KIND_LABEL).map((k) => `kind_${k}`),
    'pin', 'unpin',
  ]);
  for (const key of used) assert.ok(en[key], `missing message: ${key}`);
});
