'use strict';

// DEFAULT_TILES, loadTiles, normalizeUrl, urlKey, msg и localizePage — в defaults.js

const DEFAULT_SETTINGS = { columns: 5, size: 180, showTitles: true, bg: '' };

let tiles = [];
let settings = { ...DEFAULT_SETTINGS };
let editingIndex = null; // null — новая плитка, число — редактирование
let dragIndex = null;

const $ = (id) => document.getElementById(id);
const grid = $('grid');

// ---------- Хранилище ----------
async function load() {
  const data = await chrome.storage.local.get('settings');
  tiles = await loadTiles();
  settings = { ...DEFAULT_SETTINGS, ...(data.settings || {}) };
}

function save() {
  return chrome.storage.local.set({ tiles, settings });
}

// ---------- Вспомогательные функции ----------
function hostOf(url) {
  try { return new URL(url).hostname.replace(/^www\./, ''); }
  catch { return url; }
}

function faviconUrl(pageUrl) {
  const u = new URL(chrome.runtime.getURL('/_favicon/'));
  u.searchParams.set('pageUrl', pageUrl);
  u.searchParams.set('size', '64');
  return u.toString();
}

// стабильный цвет фона плитки по домену
function colorFor(str) {
  let h = 0;
  for (const ch of str) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return `hsl(${h % 360} 42% 32%)`;
}

// ---------- Отрисовка ----------
function applySettings() {
  const root = document.documentElement.style;
  root.setProperty('--cols', settings.columns);
  root.setProperty('--tile', settings.size + 'px');
  document.body.classList.toggle('no-titles', !settings.showTitles);
  document.body.style.backgroundImage = settings.bg ? `url("${settings.bg}")` : '';
}

function render() {
  grid.textContent = '';

  tiles.forEach((tile, i) => {
    const a = document.createElement('a');
    a.className = 'tile';
    a.href = tile.url;
    a.draggable = true;
    a.dataset.index = i;

    const host = hostOf(tile.url);
    const thumb = document.createElement('div');
    thumb.className = 'thumb';
    thumb.style.background = colorFor(host);

    const img = document.createElement('img');
    img.alt = '';
    if (tile.image || tile.shot) {
      img.className = 'cover';
      img.src = tile.image || tile.shot;
    } else {
      img.className = 'icon';
      img.src = faviconUrl(tile.url);
    }
    img.onerror = () => {
      const letter = document.createElement('span');
      letter.className = 'letter';
      letter.textContent = (tile.title || host).charAt(0);
      img.replaceWith(letter);
    };
    thumb.append(img);

    const title = document.createElement('div');
    title.className = 'title';
    title.textContent = tile.title || host;

    const actions = document.createElement('div');
    actions.className = 'actions';
    actions.append(
      actionButton('✎', msg('edit'), () => openTileDialog(i)),
      actionButton('✕', msg('delete'), () => removeTile(i)),
    );

    a.append(thumb, title, actions);
    addDragHandlers(a);
    grid.append(a);
  });

  // плитка «+»
  const add = document.createElement('a');
  add.className = 'tile add';
  add.href = '#';
  const addThumb = document.createElement('div');
  addThumb.className = 'thumb';
  addThumb.textContent = '+';
  const addTitle = document.createElement('div');
  addTitle.className = 'title';
  addTitle.textContent = msg('addSite');
  add.append(addThumb, addTitle);
  add.addEventListener('click', (e) => { e.preventDefault(); openTileDialog(null); });
  grid.append(add);
}

function actionButton(text, label, onClick) {
  const b = document.createElement('button');
  b.type = 'button';
  b.textContent = text;
  b.title = label;
  b.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    onClick();
  });
  return b;
}

// ---------- Перетаскивание ----------
function addDragHandlers(el) {
  el.addEventListener('dragstart', (e) => {
    dragIndex = Number(el.dataset.index);
    el.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
  });
  el.addEventListener('dragend', () => {
    el.classList.remove('dragging');
    grid.querySelectorAll('.drop-target').forEach(t => t.classList.remove('drop-target'));
    dragIndex = null;
  });
  el.addEventListener('dragover', (e) => {
    if (dragIndex === null) return;
    e.preventDefault();
    el.classList.add('drop-target');
  });
  el.addEventListener('dragleave', () => el.classList.remove('drop-target'));
  el.addEventListener('drop', (e) => {
    e.preventDefault();
    const to = Number(el.dataset.index);
    if (dragIndex === null || dragIndex === to) return;
    const [moved] = tiles.splice(dragIndex, 1);
    tiles.splice(to, 0, moved);
    save();
    render();
  });
}

// ---------- Добавление / редактирование ----------
const tileDialog = $('tileDialog');
const tileForm = $('tileForm');

function openTileDialog(index) {
  editingIndex = index;
  const t = index === null ? { url: '', title: '', image: '' } : tiles[index];
  $('tileDialogTitle').textContent = msg(index === null ? 'tileDialogNew' : 'tileDialogEdit');
  tileForm.url.value = t.url || '';
  tileForm.title.value = t.title || '';
  tileForm.image.value = t.image || '';
  tileForm.removeShot.checked = false;
  $('removeShotRow').hidden = !t.shot;
  tileDialog.returnValue = '';
  tileDialog.showModal();
}

tileDialog.addEventListener('close', () => {
  if (tileDialog.returnValue !== 'ok') return;
  const tile = {
    url: normalizeUrl(tileForm.url.value),
    title: tileForm.title.value.trim(),
    image: tileForm.image.value.trim(),
  };
  if (editingIndex === null) {
    tiles.push(tile);
  } else {
    const old = tiles[editingIndex];
    tile.shot = tileForm.removeShot.checked ? '' : (old.shot || '');
    tiles[editingIndex] = tile;
  }
  save();
  render();
});

function removeTile(index) {
  const t = tiles[index];
  if (!confirm(msg('confirmDelete', t.title || hostOf(t.url)))) return;
  tiles.splice(index, 1);
  save();
  render();
}

// ---------- Настройки ----------
const settingsDialog = $('settingsDialog');

function syncSettingsForm() {
  $('cols').value = settings.columns;
  $('colsOut').textContent = settings.columns;
  $('size').value = settings.size;
  $('sizeOut').textContent = settings.size + ' px';
  $('showTitles').checked = settings.showTitles;
}

$('settingsBtn').addEventListener('click', () => {
  syncSettingsForm();
  settingsDialog.showModal();
});

$('cols').addEventListener('input', (e) => {
  settings.columns = Number(e.target.value);
  syncSettingsForm(); applySettings(); save();
});
$('size').addEventListener('input', (e) => {
  settings.size = Number(e.target.value);
  syncSettingsForm(); applySettings(); save();
});
$('showTitles').addEventListener('change', (e) => {
  settings.showTitles = e.target.checked;
  applySettings(); save();
});

$('bgFile').addEventListener('change', (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    settings.bg = reader.result;
    applySettings(); save();
  };
  reader.readAsDataURL(file);
  e.target.value = '';
});
$('bgReset').addEventListener('click', () => {
  settings.bg = '';
  applySettings(); save();
});

// экспорт / импорт (резервная копия плиток и настроек)
$('exportBtn').addEventListener('click', () => {
  const blob = new Blob([JSON.stringify({ tiles, settings }, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'speed-dial-backup.json';
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
});
$('importBtn').addEventListener('click', () => $('importFile').click());
$('importFile').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  try {
    const data = JSON.parse(await file.text());
    if (!Array.isArray(data.tiles)) throw new Error(msg('importNoTiles'));
    tiles = data.tiles.filter(t => t && typeof t.url === 'string');
    settings = { ...DEFAULT_SETTINGS, ...(data.settings || {}) };
    await save();
    applySettings(); syncSettingsForm(); render();
  } catch (err) {
    alert(msg('importFailed', err.message));
  }
});

// ---------- Поиск ----------
$('searchForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const text = $('searchInput').value.trim();
  if (!text) return;
  if (chrome.search?.query) {
    chrome.search.query({ text, disposition: 'CURRENT_TAB' });
  } else {
    location.href = 'https://search.brave.com/search?q=' + encodeURIComponent(text);
  }
});

// ---------- Обновление при добавлении сайта через значок расширения ----------
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || !changes.tiles) return;
  if (dragIndex !== null) return; // не мешаем перетаскиванию
  tiles = changes.tiles.newValue || [];
  render();
});

// ---------- Старт ----------
localizePage();
(async () => {
  await load();
  applySettings();
  render();
})();
