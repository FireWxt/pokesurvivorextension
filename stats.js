// Definitions of the PokéSurvivor level-up stat cards.
// Values taken from the game code (LevelUp module): each card applies its bonus once per pick.
var PST = (() => {
  const pct = (x) => `${Math.round(x * 100)}%`;

  const STATS = [
    { id: 'atk',  label: 'Damage',      game: 'Power · Potencia',          max: 40, effect: (n) => `+${pct(1.1 ** n - 1)} damage` },
    { id: 'def',  label: 'Armor',       game: 'Armor · Coraza',            max: 12, effect: (n) => `-${Math.min(70, 6 * n)}% damage taken` },
    { id: 'hp',   label: 'Max HP',      game: 'Vigor',                     max: 0,  effect: (n) => `+${20 * n} max HP` },
    { id: 'rgn',  label: 'Regen',       game: 'Synthesis · Síntesis',      max: 0,  effect: (n) => `+${(0.9 * n).toFixed(1)} HP/s` },
    { id: 'xp',   label: 'XP',          game: 'Learning · Aprendizaje',    max: 8,  effect: (n) => `+${pct(1.12 ** n - 1)} XP` },
    { id: 'spd',  label: 'Speed',       game: 'Sprint · Carrera',          max: 8,  effect: (n) => `+${pct(1.07 ** n - 1)} move speed` },
    { id: 'cd',   label: 'Cooldown',    game: 'Reflexes · Reflejos',       max: 10, effect: (n) => `-${pct(1 - 0.92 ** n)} cooldown` },
    { id: 'mag',  label: 'Magnet',      game: 'Magnet · Imán',             max: 6,  effect: (n) => `+${pct(1.3 ** n - 1)} pickup radius` },
    { id: 'heal', label: 'Heal',        game: 'Sitrus Berry · Baya Zidra', max: 0,  effect: (n) => `${n} × 45% HP restored` },
  ];

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

  const KIND_LABEL = { stat: 'Stat', new: 'New move', up: 'Move +', evo: 'Evolution', other: 'Other' };

  return { STATS, BY_ID, statIdFromTitle, emptyCounts, norm, KIND_LABEL, STORAGE_KEY: 'pst_state', SETTINGS_KEY: 'pst_settings' };
})();
