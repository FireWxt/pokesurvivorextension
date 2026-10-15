# PokeSurvivor Run Tracker

Browser extension for [PokeSurvivor](https://pokesurvivor.com) that tracks every run: stat cards picked at each level-up, moves learned, gacha tickets collected, duration and ticket rate.

## Features

- **In-game overlay** (draggable, collapsible, compact mode, adjustable opacity and size): stat cards with their effects, offense/toughness multipliers, moves and their levels, tickets, duration, tickets per minute, daily goal progress.
- **Popup**: current run, summary across runs (filterable by partner), cards offered vs picked, run history with level-over-time curve, pin/delete runs.
- **Daily goal** with a notification when it is reached.
- **Badge** on the extension icon with the level of the run in progress.
- **Export / import** of the history (JSON, plus CSV for spreadsheets).
- **Keyboard shortcut** to show/hide the overlay (Alt+T by default, configurable in `chrome://extensions/shortcuts`).
- English, French and Spanish, following the browser language.

Ticket value counts a ×10 ticket as 10 tickets.

## Install (development)

- **Chrome / Edge**: `chrome://extensions` → enable Developer mode → *Load unpacked* → select this folder.
- **Firefox (121+)**: `manifest.json` is Chrome's (Firefox doesn't run MV3 service workers). Run `npm run package`, then `about:debugging#/runtime/this-firefox` → *Load Temporary Add-on* → select `dist/pokesurvivor-run-tracker-<version>-firefox.zip`. In Firefox, site access is opt-in: allow the extension on pokesurvivor.com from the toolbar menu.

## Development

Requires Node 22+, no dependencies.

```sh
npm test         # unit tests for the shared logic (stats.js) and the translations
npm run package  # builds dist/pokesurvivor-run-tracker-<version>-{chrome,firefox}.zip for the stores
```

| File | Role |
| --- | --- |
| `stats.js` | Shared logic: stat cards, card classification, history, summaries, CSV, i18n helper |
| `content.js` | Reads the game DOM, records runs, draws the overlay |
| `popup.*` | Popup (also opens in a tab, which is where import happens) |
| `background.js` | Shortcut, badge, daily goal notification, injection on install |
| `_locales/` | Translations; every key must exist in every language (checked by the tests) |

The game doesn't expose its state: the tracker reads its screens (`#scr-levelup`, `#cards`, `#scr-over`, menus) and, for live ticket counts, the save the game keeps in `localStorage`. If the game's HTML changes, the overlay and popup show "Game not detected" instead of failing silently.
