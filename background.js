// Chrome only injects content scripts into pages loaded after install,
// so inject them ourselves into PokéSurvivor tabs that are already open.
chrome.runtime.onInstalled.addListener(async () => {
  const tabs = await chrome.tabs.query({ url: ['https://pokesurvivor.com/*', 'https://www.pokesurvivor.com/*'] });
  for (const tab of tabs) {
    chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['stats.js', 'content.js'] }).catch(() => {});
  }
});
