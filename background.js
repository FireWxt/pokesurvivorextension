// Chrome loads this file as a service worker; Firefox (see scripts/package.js) loads stats.js first as a background script.
if (typeof PST === 'undefined') importScripts('stats.js');

const GAME_URLS = ['https://pokesurvivor.com/*', 'https://www.pokesurvivor.com/*'];

// Chrome only injects content scripts into pages loaded after install,
// so inject them ourselves into PokéSurvivor tabs that are already open.
chrome.runtime.onInstalled.addListener(async () => {
  const tabs = await chrome.tabs.query({ url: GAME_URLS });
  for (const tab of tabs) {
    chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['stats.js', 'content.js'] }).catch(() => {});
  }
});

// The overlay shows the shortcut, but content scripts can't read it: keep a copy in storage.
async function storeShortcut() {
  const commands = await chrome.commands.getAll();
  const cmd = commands.find((c) => c.name === 'toggle-overlay');
  chrome.storage.local.set({ [PST.SHORTCUT_KEY]: cmd?.shortcut || '' });
}

chrome.commands.onCommand.addListener(async (name) => {
  if (name !== 'toggle-overlay') return;
  const res = await chrome.storage.local.get(PST.SETTINGS_KEY);
  const settings = { ...PST.DEFAULT_SETTINGS, ...res[PST.SETTINGS_KEY] };
  settings.visible = !settings.visible;
  chrome.storage.local.set({ [PST.SETTINGS_KEY]: settings });
});

// Badge: the level of the run in progress.
function updateBadge(state) {
  const run = state?.current;
  const live = run && !run.ended;
  chrome.action.setBadgeText({ text: live ? String(run.lastLevel || '') : '' });
  chrome.action.setBadgeBackgroundColor({ color: '#ffd23f' });
  chrome.action.setBadgeTextColor?.({ color: '#0a1430' });
  chrome.action.setTitle({
    title: live ? PST.t('badgeTitle', run.lastLevel, run.tickets?.t1 || 0, run.tickets?.t10 || 0) : PST.t('extName'),
  });
}

// Daily goal: notify once per day when today's ticket value reaches it.
async function checkGoal(state, settings) {
  const goal = settings?.goal || 0;
  if (!(goal > 0)) return;
  const value = PST.todayValue(state);
  if (value < goal) return;
  const today = PST.dayKey(Date.now());
  const res = await chrome.storage.local.get(PST.GOAL_NOTIFIED_KEY);
  if (res[PST.GOAL_NOTIFIED_KEY] === today) return;
  chrome.storage.local.set({ [PST.GOAL_NOTIFIED_KEY]: today });
  chrome.notifications.create(`goal-${today}`, {
    type: 'basic',
    iconUrl: 'icons/icon128.png',
    title: PST.t('goalReachedTitle'),
    message: PST.t('goalReachedMessage', value, goal),
  });
}

async function refresh() {
  const res = await chrome.storage.local.get([PST.STORAGE_KEY, PST.SETTINGS_KEY]);
  updateBadge(res[PST.STORAGE_KEY]);
  checkGoal(res[PST.STORAGE_KEY], res[PST.SETTINGS_KEY]);
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && (changes[PST.STORAGE_KEY] || changes[PST.SETTINGS_KEY])) refresh();
});

storeShortcut();
refresh();
