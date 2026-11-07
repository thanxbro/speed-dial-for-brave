'use strict';

// Общие данные и функции для новой вкладки и окошка на значке расширения.

// ---------- Перевод (строки в _locales/<язык>/messages.json) ----------
function msg(key, ...subs) {
  return chrome.i18n.getMessage(key, subs.map(String)) || key;
}

// подставляет переводы в элементы с атрибутами data-i18n, data-i18n-placeholder,
// data-i18n-title и data-i18n-alt
function localizePage() {
  document.documentElement.lang = msg('htmlLang');
  for (const el of document.querySelectorAll('[data-i18n]')) {
    el.textContent = msg(el.dataset.i18n);
  }
  for (const attr of ['placeholder', 'title', 'alt']) {
    for (const el of document.querySelectorAll(`[data-i18n-${attr}]`)) {
      el.setAttribute(attr, msg(el.getAttribute(`data-i18n-${attr}`)));
    }
  }
}

const DEFAULT_TILES = [
  { title: 'YouTube',   url: 'https://www.youtube.com/' },
  { title: msg('wikipedia'), url: `https://${msg('htmlLang')}.wikipedia.org/` },
  { title: 'GitHub',    url: 'https://github.com/' },
  { title: 'Gmail',     url: 'https://mail.google.com/' },
  { title: 'Reddit',    url: 'https://www.reddit.com/' },
];

async function loadTiles() {
  const { tiles } = await chrome.storage.local.get('tiles');
  return Array.isArray(tiles) ? tiles : DEFAULT_TILES.map(t => ({ ...t }));
}

function normalizeUrl(input) {
  let s = input.trim();
  if (!/^[a-z][a-z0-9+.-]*:/i.test(s)) s = 'https://' + s;
  return s;
}

// адреса считаются одинаковыми без учёта www, конечного «/» и #якоря
function urlKey(url) {
  try {
    const u = new URL(url);
    return (u.hostname.replace(/^www\./, '') + u.pathname.replace(/\/$/, '') + u.search).toLowerCase();
  } catch {
    return url.toLowerCase();
  }
}
