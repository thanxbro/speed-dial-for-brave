'use strict';

// DEFAULT_TILES, loadTiles, normalizeUrl, urlKey, msg и localizePage — в defaults.js

const DEFAULT_SETTINGS = {
  columns: 5,
  size: 180,
  showTitles: true,
  bgMode: 'interval',      // 'tab' — при каждой новой вкладке, 'interval' — через bgInterval минут
  bgInterval: 30,          // минуты, 1–10080
  bgOrder: 'sequential',   // 'sequential' — по очереди, 'random' — случайно
  exportBackgrounds: true, // включать фоны в резервную копию
};
const BG_INTERVAL_MIN = 1;
const BG_INTERVAL_MAX = 10080; // неделя

let tiles = [];
let settings = { ...DEFAULT_SETTINGS };
let backgrounds = [];                    // data URL картинок фона
let bgState = { index: 0, changedAt: 0 }; // какой фон показан и когда он сменился
let editingIndex = null; // null — новая плитка, число — редактирование
let dragIndex = null;

const $ = (id) => document.getElementById(id);
const grid = $('grid');

// метка этой вкладки: по ней она узнаёт свои записи в хранилище и не применяет их повторно
const TAB_ID = Math.random().toString(36).slice(2);

// ---------- Проверка данных ----------
function clampInt(value, min, max, fallback) {
  const n = Math.round(Number(value));
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
}

function sanitizeSettings(raw) {
  const s = { ...DEFAULT_SETTINGS, ...(raw && typeof raw === 'object' ? raw : {}) };
  delete s.bg; // старое поле: один фон в настройках (до версии 1.3.0)
  s.columns = clampInt(s.columns, 3, 10, DEFAULT_SETTINGS.columns);
  s.size = clampInt(s.size, 120, 280, DEFAULT_SETTINGS.size);
  s.showTitles = s.showTitles !== false;
  s.bgMode = s.bgMode === 'tab' ? 'tab' : 'interval';
  s.bgInterval = clampInt(s.bgInterval, BG_INTERVAL_MIN, BG_INTERVAL_MAX, DEFAULT_SETTINGS.bgInterval);
  s.bgOrder = s.bgOrder === 'random' ? 'random' : 'sequential';
  s.exportBackgrounds = s.exportBackgrounds !== false;
  return s;
}

function isImageDataUrl(s) {
  return typeof s === 'string' && /^data:image\/[a-z0-9+.-]+;base64,[a-z0-9+/=]+$/i.test(s);
}

// фон из старого формата настроек ({ bg: 'data:…' }), если он есть
function legacyBg(rawSettings) {
  const bg = rawSettings && rawSettings.bg;
  return isImageDataUrl(bg) ? bg : '';
}

// ---------- Хранилище ----------
async function load() {
  const data = await chrome.storage.local.get(['settings', 'backgrounds', 'bgState']);
  tiles = await loadTiles();
  settings = sanitizeSettings(data.settings);
  bgState = { ...bgState, ...(data.bgState || {}) };

  if (Array.isArray(data.backgrounds)) {
    backgrounds = data.backgrounds.filter(isImageDataUrl);
  } else {
    // переход со старой версии: единственный фон становится первым в списке
    const old = legacyBg(data.settings);
    backgrounds = old ? [old] : [];
    await chrome.storage.local.set({ backgrounds, settings });
  }
  normalizeBgState();
}

function save() {
  return chrome.storage.local.set({ tiles, settings });
}

// состояние фона (и, при необходимости, список фонов) всегда пишется с меткой вкладки
function saveBg(extra = {}) {
  return chrome.storage.local.set({ ...extra, bgState: { ...bgState, by: TAB_ID } });
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

// 90 → «1 ч 30 мин»
function formatDuration(minutes) {
  const d = Math.floor(minutes / 1440);
  const h = Math.floor((minutes % 1440) / 60);
  const m = minutes % 60;
  return [d && msg('durDays', d), h && msg('durHours', h), m && msg('durMinutes', m)]
    .filter(Boolean).join(' ');
}

// ---------- Отрисовка ----------
function applySettings() {
  const root = document.documentElement.style;
  root.setProperty('--cols', settings.columns);
  root.setProperty('--tile', settings.size + 'px');
  document.body.classList.toggle('no-titles', !settings.showTitles);
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

// ---------- Фон ----------
const bgLayers = [$('bgA'), $('bgB')];
let bgFront = 0;   // слой, который сейчас виден
let bgShown = '';  // картинка, которая сейчас показана
let bgToken = 0;   // защита от гонок при быстрой смене
let bgTimer = null;

function normalizeBgState() {
  const n = backgrounds.length;
  const i = Math.round(Number(bgState.index)) || 0;
  bgState.index = n ? ((i % n) + n) % n : 0;
  bgState.changedAt = Number(bgState.changedAt) || 0;
}

function currentBg() {
  return backgrounds.length ? backgrounds[bgState.index] : '';
}

// новый фон проявляется поверх старого, затем старый слой прячется
async function showBackground(url, animate) {
  if (url === bgShown) return;
  bgShown = url;
  const token = ++bgToken;
  const front = bgLayers[bgFront];

  if (!url) {
    front.classList.toggle('instant', !animate);
    front.classList.remove('shown');
    return;
  }

  // ждём, пока картинка декодируется, чтобы переход не начался с пустого слоя
  const img = new Image();
  img.src = url;
  try { await img.decode(); } catch { /* покажем как есть */ }
  if (token !== bgToken) return;

  const back = bgLayers[1 - bgFront];
  back.style.zIndex = '-1';
  front.style.zIndex = '-2';
  back.classList.add('instant');
  back.classList.remove('shown');
  back.style.backgroundImage = `url("${url}")`;
  void back.offsetWidth; // применяем прозрачность до начала перехода
  back.classList.toggle('instant', !animate);
  back.classList.add('shown');
  bgFront = 1 - bgFront;

  setTimeout(() => {
    if (token !== bgToken) return;
    front.classList.add('instant');
    front.classList.remove('shown');
  }, animate ? 1300 : 0);
}

function nextBgIndex() {
  const n = backgrounds.length;
  if (n < 2) return 0;
  if (settings.bgOrder === 'random') {
    let i;
    do i = Math.floor(Math.random() * n); while (i === bgState.index);
    return i;
  }
  return (bgState.index + 1) % n;
}

function isBgDue() {
  const age = Date.now() - bgState.changedAt;
  return age < 0 || age >= settings.bgInterval * 60000;
}

async function advanceBackground() {
  bgState = { index: nextBgIndex(), changedAt: Date.now() };
  await saveBg();
}

function scheduleBackground() {
  clearTimeout(bgTimer);
  if (settings.bgMode !== 'interval' || backgrounds.length < 2) return;
  const wait = bgState.changedAt + settings.bgInterval * 60000 - Date.now();
  bgTimer = setTimeout(checkBackground, Math.max(1000, wait + 50));
}

async function checkBackground() {
  if (settings.bgMode === 'interval' && backgrounds.length >= 2) {
    // фон могла уже сменить другая вкладка — берём свежее состояние
    const { bgState: fresh } = await chrome.storage.local.get('bgState');
    if (fresh) { bgState = { ...bgState, ...fresh }; normalizeBgState(); }
    if (isBgDue()) await advanceBackground();
    showBackground(currentBg(), true);
    renderBgList();
  }
  scheduleBackground();
}

// при открытии вкладки
async function initBackground() {
  if (backgrounds.length >= 2) {
    if (settings.bgMode === 'tab') {
      await advanceBackground();
    } else if (!bgState.changedAt) {
      bgState.changedAt = Date.now();
      await saveBg();
    } else if (isBgDue()) {
      await advanceBackground();
    }
  }
  showBackground(currentBg(), false);
  scheduleBackground();
}

// после изменения списка фонов
function onBackgroundsChanged() {
  normalizeBgState();
  renderBgList();
  showBackground(currentBg(), true);
  scheduleBackground();
}

// вернулись на вкладку: настройки могли поменять в другой вкладке, фону могло подойти время
document.addEventListener('visibilitychange', async () => {
  if (document.hidden) return;
  const { settings: stored } = await chrome.storage.local.get('settings');
  settings = sanitizeSettings(stored);
  applySettings();
  checkBackground();
});

// уменьшаем картинку до размера экрана и сжимаем в JPEG, чтобы не раздувать хранилище
async function shrinkImage(file) {
  const bmp = await createImageBitmap(file);
  const dpr = window.devicePixelRatio || 1;
  const maxW = Math.min(3840, Math.round(screen.width * dpr));
  const maxH = Math.min(2160, Math.round(screen.height * dpr));
  // картинка растягивается на весь экран (cover), поэтому ей хватит покрыть экран по обеим сторонам
  const scale = Math.min(1, Math.max(maxW / bmp.width, maxH / bmp.height));
  const w = Math.max(1, Math.round(bmp.width * scale));
  const h = Math.max(1, Math.round(bmp.height * scale));
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#000'; // прозрачные места PNG станут чёрными, а не белыми
  ctx.fillRect(0, 0, w, h);
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(bmp, 0, 0, w, h);
  bmp.close();
  return canvas.toDataURL('image/jpeg', 0.85);
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

function updateIntervalHint(minutes) {
  $('bgIntervalHint').textContent = minutes >= 60 ? '= ' + formatDuration(minutes) : '';
}

function syncSettingsForm() {
  $('cols').value = settings.columns;
  $('colsOut').textContent = settings.columns;
  $('size').value = settings.size;
  $('sizeOut').textContent = settings.size + ' px';
  $('showTitles').checked = settings.showTitles;
  $('bgMode').value = settings.bgMode;
  $('bgInterval').value = settings.bgInterval;
  updateIntervalHint(settings.bgInterval);
  $('bgIntervalRow').hidden = settings.bgMode !== 'interval';
  $('bgOrder').value = settings.bgOrder;
  $('exportBgs').checked = settings.exportBackgrounds;
  renderBgList();
}

function renderBgList() {
  const list = $('bgList');
  list.textContent = '';
  backgrounds.forEach((url, i) => {
    const item = document.createElement('div');
    item.className = 'bg-item' + (i === bgState.index ? ' current' : '');
    item.style.backgroundImage = `url("${url}")`;
    item.title = msg('bgShowNow');
    item.addEventListener('click', () => setCurrentBackground(i));

    const del = document.createElement('button');
    del.type = 'button';
    del.textContent = '✕';
    del.title = msg('delete');
    del.addEventListener('click', (e) => {
      e.stopPropagation();
      removeBackground(i);
    });

    item.append(del);
    list.append(item);
  });

  const n = backgrounds.length;
  $('bgEmpty').hidden = n > 0;
  $('bgClear').hidden = n === 0;
  $('bgRotation').hidden = n < 2;
  $('bgOneNote').hidden = n !== 1;
}

async function setCurrentBackground(i) {
  bgState = { index: i, changedAt: Date.now() };
  onBackgroundsChanged();
  await saveBg();
}

async function removeBackground(i) {
  const cur = bgState.index;
  backgrounds.splice(i, 1);
  if (i < cur) {
    bgState.index = cur - 1;
  } else if (i === cur) {
    bgState.changedAt = Date.now(); // показанный фон удалён — следующий начинает свой интервал
  }
  onBackgroundsChanged();
  await saveBg({ backgrounds });
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

// фоны
$('bgAdd').addEventListener('click', () => $('bgFile').click());
$('bgFile').addEventListener('change', async (e) => {
  const files = [...e.target.files];
  e.target.value = '';
  if (!files.length) return;

  $('bgBusy').hidden = false;
  $('bgAdd').disabled = true;
  const added = [];
  let failed = 0;
  for (const file of files) {
    try { added.push(await shrinkImage(file)); }
    catch { failed++; }
  }
  $('bgBusy').hidden = true;
  $('bgAdd').disabled = false;

  if (added.length) {
    if (!backgrounds.length) bgState.index = 0;
    // пока картинок меньше двух, фон не меняется — интервал начинает отсчёт сейчас
    if (backgrounds.length < 2) bgState.changedAt = Date.now();
    backgrounds = [...backgrounds, ...added];
    onBackgroundsChanged();
    await saveBg({ backgrounds });
  }
  if (failed) alert(msg('bgLoadFailed', failed));
});

$('bgClear').addEventListener('click', async () => {
  if (!confirm(msg('confirmRemoveAllBackgrounds'))) return;
  backgrounds = [];
  bgState = { index: 0, changedAt: 0 };
  onBackgroundsChanged();
  await saveBg({ backgrounds });
});

$('bgMode').addEventListener('change', (e) => {
  settings.bgMode = e.target.value === 'tab' ? 'tab' : 'interval';
  if (settings.bgMode === 'interval') {
    bgState.changedAt = Date.now(); // интервал отсчитывается с момента переключения
    saveBg();
  }
  syncSettingsForm(); save(); scheduleBackground();
});

$('bgInterval').addEventListener('input', (e) => {
  const n = Number(e.target.value);
  if (e.target.value.trim() !== '' && Number.isFinite(n)) {
    updateIntervalHint(clampInt(n, BG_INTERVAL_MIN, BG_INTERVAL_MAX, settings.bgInterval));
  }
});

// пустое или неверное значение возвращается к прежнему, число зажимается в пределы
function commitInterval() {
  const field = $('bgInterval');
  const raw = field.value.trim();
  const n = Number(raw);
  const value = raw !== '' && Number.isFinite(n)
    ? clampInt(n, BG_INTERVAL_MIN, BG_INTERVAL_MAX, settings.bgInterval)
    : settings.bgInterval;
  field.value = value;
  updateIntervalHint(value);
  if (value === settings.bgInterval) return;
  settings.bgInterval = value;
  save();
  scheduleBackground();
}
$('bgInterval').addEventListener('change', commitInterval);
settingsDialog.addEventListener('close', commitInterval);

$('bgOrder').addEventListener('change', (e) => {
  settings.bgOrder = e.target.value === 'random' ? 'random' : 'sequential';
  save();
});

// экспорт / импорт (резервная копия плиток, настроек и фонов)
$('exportBgs').addEventListener('change', (e) => {
  settings.exportBackgrounds = e.target.checked;
  save();
});

$('exportBtn').addEventListener('click', () => {
  const data = { tiles, settings };
  if (settings.exportBackgrounds) data.backgrounds = backgrounds;
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
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
    settings = sanitizeSettings(data.settings);

    // фоны: новый формат — список, старый — один фон в settings.bg;
    // если фонов в файле нет, текущие остаются
    let imported = null;
    if (Array.isArray(data.backgrounds)) imported = data.backgrounds.filter(isImageDataUrl);
    else if (legacyBg(data.settings)) imported = [legacyBg(data.settings)];

    if (imported) {
      backgrounds = imported;
      bgState = { index: 0, changedAt: Date.now() };
      await saveBg({ tiles, settings, backgrounds });
    } else {
      await save();
    }
    applySettings(); syncSettingsForm(); render(); onBackgroundsChanged();
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

// ---------- Изменения из других вкладок и из окошка на значке ----------
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;

  // настройки из других вкладок подхватываются при возврате на вкладку (visibilitychange):
  // применять их здесь нельзя — запоздавшие уведомления о своих же записях откатили бы
  // только что сделанные изменения

  // свои записи фона уже применены, их пропускаем
  const ownBgWrite = changes.bgState?.newValue?.by === TAB_ID;
  if ((changes.backgrounds || changes.bgState) && !ownBgWrite) {
    if (changes.backgrounds) {
      backgrounds = (changes.backgrounds.newValue || []).filter(isImageDataUrl);
    }
    // в режиме «при каждой новой вкладке» открытые вкладки свой фон не меняют
    if (changes.bgState && (settings.bgMode === 'interval' || changes.backgrounds)) {
      bgState = { ...bgState, ...(changes.bgState.newValue || {}) };
    }
    onBackgroundsChanged();
  }

  if (changes.tiles && dragIndex === null) { // не мешаем перетаскиванию
    tiles = changes.tiles.newValue || [];
    render();
  }
});

// ---------- Старт ----------
localizePage();
(async () => {
  await load();
  applySettings();
  render();
  await initBackground();
})();
