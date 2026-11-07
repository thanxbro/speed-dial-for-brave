# Speed Dial for Brave

**English** | [Русский](README.ru.md)

A speed dial for the new tab page: your favorite sites as tiles with page snapshots. Built for Brave, works in any Chromium-based browser (Chrome, Edge, Vivaldi, Opera). Manifest V3, plain HTML/CSS/JS, no dependencies.

## Features

**New tab page**
- Grid of site tiles. Each tile shows your own image if you set one, otherwise a page snapshot, otherwise the site icon on a colored background (the color is derived from the domain).
- The **+** tile adds a site. Hover a tile to edit (✎) or delete (✕) it.
- Drag and drop tiles to reorder them.
- Search box that uses your browser's default search engine.
- Settings (⚙): number of columns (3–10), tile size (120–280 px), show or hide titles, background images, backup export and import (JSON).

**Changing backgrounds**
- Add one or more of your own images as backgrounds. Large images are scaled down to your screen size and compressed when added, so they don't bloat storage.
- With two or more images, the background changes automatically: **on every new tab** or **after a set time**, where you enter the interval in minutes (1 to 10,080, i.e. up to a week).
- Order: in sequence or random. The new image fades in smoothly.
- Click a thumbnail in the settings to show that image right away; ✕ removes it.

**Toolbar button**
- Adds the current page to the dial in one click, together with a snapshot of the visible part of the page.
- If the site is already on the dial, its tile is updated instead of duplicated.
- Only regular websites (http/https) can be added; browser pages such as `brave://` cannot.

**Languages:** English and Russian. The language follows your browser's interface language.

## Installation

The extension is not in a store yet, so it is installed as an unpacked extension:

1. Download or clone this repository.
2. Open `brave://extensions` (or `chrome://extensions`).
3. Turn on **Developer mode**.
4. Click **Load unpacked** and select the project folder.
5. Open a new tab. If the browser asks whether to keep the changed new tab page, choose to keep it.

> **Do not move the folder after installing.** The ID of an unpacked extension depends on the folder path. If the path changes, the browser treats it as a new extension with empty storage, and your tiles are gone. Export a backup in the settings before moving or reinstalling.

To update, replace the files and click ↻ on the extension card in `brave://extensions`.

## Privacy and permissions

All tiles, snapshots and settings are stored locally in the browser (`chrome.storage.local`). The extension does not send data anywhere and has no servers of its own.

| Permission | Why |
|---|---|
| `storage`, `unlimitedStorage` | Store tiles, snapshots, background images and settings locally |
| `favicon` | Show site icons from the browser's own cache |
| `search` | Search with your default search engine |
| `activeTab` | Read the address and title of the current tab and take its snapshot, only when you click the toolbar button |

## Backup

Settings → **Export** saves tiles, settings and, if the checkbox is on, background images to a JSON file. With backgrounds the file is larger. **Import** restores everything from such a file and replaces the current tiles. If the file has no backgrounds, your current backgrounds stay. Backups from older versions with a single background image are still supported.

## Development

There is no build step: edit the files and click ↻ on the extension card.

| File | Purpose |
|---|---|
| `manifest.json` | Extension manifest (MV3) |
| `defaults.js` | Shared code: translations, default tiles, URL helpers |
| `newtab.html` / `.css` / `.js` | New tab page |
| `popup.html` / `.css` / `.js` | Toolbar popup |
| `_locales/{en,ru}/messages.json` | Interface texts |
| `icons/` | Extension icons |

Syntax check:

```bash
cat defaults.js newtab.js | node --check -
cat defaults.js popup.js | node --check -
```

To add a new interface text, add a key with the same name to both `_locales/en/messages.json` and `_locales/ru/messages.json`. In HTML, mark the element with `data-i18n` (or `data-i18n-placeholder`, `data-i18n-title`, `data-i18n-alt`); in JS, use `msg('key')`. To test English in a Russian browser, start Brave with `--lang=en`.
