'use strict';

// DEFAULT_TILES, loadTiles, normalizeUrl, urlKey, msg и localizePage — в defaults.js
// bgdb*, bgStoreImage, bgDataUrlToBlob, bgBlobToDataUrl и withBgLock — в bgstore.js

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
const EXPORT_WARN_MB = 100;    // предупреждать о большой резервной копии

let tiles = [];
let settings = { ...DEFAULT_SETTINGS };
let bgIds = [];                           // порядок фоновых картинок (id записей в IndexedDB)
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

function cleanIds(value) {
  return Array.isArray(value) ? value.filter((id) => typeof id === 'string') : [];
}

// ---------- Хранилище ----------
async function load() {
  const data = await chrome.storage.local.get(['settings', 'bgIds', 'bgState']);
  tiles = await loadTiles();
  settings = sanitizeSettings(data.settings);
  bgState = { ...bgState, ...(data.bgState || {}) };
  bgIds = cleanIds(data.bgIds);
  normalizeBgState();
}

function save() {
  return chrome.storage.local.set({ tiles, settings });
}

// состояние фона (и, при необходимости, другие ключи) всегда пишется с меткой вкладки
function saveBg(extra = {}) {
  return chrome.storage.local.set({ ...extra, bgState: { ...bgState, by: TAB_ID } });
}

async function readBgIds() {
  const { bgIds: ids } = await chrome.storage.local.get('bgIds');
  return cleanIds(ids);
}

// Перенос фонов из старых версий в IndexedDB:
// 1.3.0 хранила список data URL в ключе backgrounds, версии до 1.3.0 — один фон в settings.bg.
// Отметка bgMigrated пишется одной записью с новым списком: если вкладку закроют
// до удаления старого ключа, перенос не повторится и дублей не будет.
async function migrateBackgrounds() {
  const quick = await chrome.storage.local.get(['backgrounds', 'settings', 'bgMigrated']);
  const hasOld = Array.isArray(quick.backgrounds) || legacyBg(quick.settings);
  if (!hasOld) return;
  if (quick.bgMigrated) {
    await chrome.storage.local.remove('backgrounds'); // остаток прерванного переноса
    return;
  }

  await withBgLock(async () => {
    // перечитываем под блокировкой: другая вкладка могла уже всё перенести
    const d = await chrome.storage.local.get(['backgrounds', 'settings', 'bgIds', 'bgState', 'bgMigrated']);
    if (d.bgMigrated) return;
    // номер текущей картинки берём из хранилища: при загрузке список был пуст и номер обнулился
    bgState = { ...bgState, ...(d.bgState || {}) };
    const urls = Array.isArray(d.backgrounds)
      ? d.backgrounds.filter(isImageDataUrl)
      : (legacyBg(d.settings) ? [legacyBg(d.settings)] : []);

    const ids = cleanIds(d.bgIds);
    for (const url of urls) {
      try { ids.push(await bgStoreImage(await bgDataUrlToBlob(url))); }
      catch { /* битую картинку пропускаем */ }
    }
    bgIds = ids;
    normalizeBgState();
    await chrome.storage.local.set({ bgIds, bgMigrated: true, settings: sanitizeSettings(d.settings) });
    await chrome.storage.local.remove('backgrounds');
  });
}

// удаляет из базы картинки, которых нет в списке (остатки прерванных операций)
function cleanupOrphanBackgrounds() {
  if (!navigator.locks) return;
  navigator.locks.request('speed-dial-bg', { ifAvailable: true }, async (lock) => {
    if (!lock) return; // список сейчас меняет другая вкладка — уберём в другой раз
    const ids = new Set(await readBgIds());
    const extra = (await bgdbKeys()).filter((k) => !ids.has(k));
    if (extra.length) await bgdbDelete(extra);
  }).catch(() => {});
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
const bgLayerUrls = ['', ''];  // object URL картинки на каждом слое
let bgFront = 0;   // слой, который сейчас виден
let bgShown = '';  // id картинки, которая сейчас показана
let bgToken = 0;   // защита от гонок при быстрой смене
let bgTimer = null;

function normalizeBgState() {
  const n = bgIds.length;
  const i = Math.round(Number(bgState.index)) || 0;
  bgState.index = n ? ((i % n) + n) % n : 0;
  bgState.changedAt = Number(bgState.changedAt) || 0;
}

function currentBgId() {
  return bgIds.length ? bgIds[bgState.index] : '';
}

// ждём загрузки картинки, чтобы переход не начался с пустого слоя.
// img.decode() в некоторых состояниях страницы не завершается вовсе,
// поэтому ждём его недолго, а всё ожидание ограничено по времени.
function waitForImage(url) {
  return new Promise((resolve) => {
    const img = new Image();
    const done = () => resolve();
    img.onload = () => {
      img.decode().then(done, done);
      setTimeout(done, 300);
    };
    img.onerror = done;
    setTimeout(done, 3000);
    img.src = url;
  });
}

// новый фон проявляется поверх старого, затем старый слой прячется
async function showBackground(id, animate) {
  if (id === bgShown) return;
  bgShown = id;
  const token = ++bgToken;
  const front = bgLayers[bgFront];

  if (!id) {
    front.classList.toggle('instant', !animate);
    front.classList.remove('shown');
    return;
  }

  let url = '';
  try {
    const rec = await bgdbGet(id);
    if (rec) url = URL.createObjectURL(rec.full);
  } catch { /* базы нет или запись недоступна */ }
  if (!url) {
    if (token === bgToken) bgShown = '';
    return;
  }

  await waitForImage(url);
  if (token !== bgToken) {
    URL.revokeObjectURL(url);
    return;
  }

  const backIndex = 1 - bgFront;
  const back = bgLayers[backIndex];
  back.style.zIndex = '-1';
  front.style.zIndex = '-2';
  back.classList.add('instant');
  back.classList.remove('shown');
  back.style.backgroundImage = `url("${url}")`;
  if (bgLayerUrls[backIndex]) URL.revokeObjectURL(bgLayerUrls[backIndex]);
  bgLayerUrls[backIndex] = url;
  void back.offsetWidth; // применяем прозрачность до начала перехода
  back.classList.toggle('instant', !animate);
  back.classList.add('shown');
  bgFront = backIndex;

  setTimeout(() => {
    if (token !== bgToken) return;
    front.classList.add('instant');
    front.classList.remove('shown');
  }, animate ? 1300 : 0);
}

function nextBgIndex() {
  const n = bgIds.length;
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
  if (settings.bgMode !== 'interval' || bgIds.length < 2) return;
  const wait = bgState.changedAt + settings.bgInterval * 60000 - Date.now();
  bgTimer = setTimeout(checkBackground, Math.max(1000, wait + 50));
}

async function checkBackground() {
  if (settings.bgMode === 'interval' && bgIds.length >= 2) {
    // фон могла уже сменить другая вкладка — берём свежее состояние
    const { bgState: fresh, bgIds: freshIds } = await chrome.storage.local.get(['bgState', 'bgIds']);
    if (fresh) bgState = { ...bgState, ...fresh };
    bgIds = cleanIds(freshIds);
    normalizeBgState();
    if (bgIds.length >= 2 && isBgDue()) await advanceBackground();
    showBackground(currentBgId(), true);
    markCurrentBg();
  }
  scheduleBackground();
}

// при открытии вкладки
async function initBackground() {
  if (bgIds.length >= 2) {
    if (settings.bgMode === 'tab') {
      await advanceBackground();
    } else if (!bgState.changedAt) {
      bgState.changedAt = Date.now();
      await saveBg();
    } else if (isBgDue()) {
      await advanceBackground();
    }
  }
  showBackground(currentBgId(), false);
  scheduleBackground();
}

// после изменения списка фонов
function onBackgroundsChanged() {
  normalizeBgState();
  dropStaleThumbs();
  renderBgList();
  showBackground(currentBgId(), true);
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

// ---------- Список фонов в настройках ----------
// миниатюры загружаются из базы только когда попадают в видимую часть списка
const bgList = $('bgList');
const thumbUrls = new Map(); // id → Promise<object URL миниатюры>

const thumbObserver = new IntersectionObserver((entries) => {
  for (const entry of entries) {
    if (!entry.isIntersecting) continue;
    thumbObserver.unobserve(entry.target);
    loadThumb(entry.target);
  }
}, { root: bgList, rootMargin: '120px 0px' });

async function loadThumb(el) {
  const id = el.dataset.id;
  if (!thumbUrls.has(id)) {
    thumbUrls.set(id, bgdbGet(id)
      .then((rec) => (rec ? URL.createObjectURL(rec.thumb) : ''))
      .catch(() => ''));
  }
  const url = await thumbUrls.get(id);
  if (url) el.style.backgroundImage = `url("${url}")`;
}

// освобождаем миниатюры удалённых картинок
function dropStaleThumbs() {
  const ids = new Set(bgIds);
  for (const [id, promise] of thumbUrls) {
    if (ids.has(id)) continue;
    thumbUrls.delete(id);
    promise.then((url) => url && URL.revokeObjectURL(url));
  }
}

function renderBgList() {
  thumbObserver.disconnect();
  bgList.textContent = '';
  const current = currentBgId();

  for (const id of bgIds) {
    const item = document.createElement('div');
    item.className = 'bg-item' + (id === current ? ' current' : '');
    item.dataset.id = id;
    item.title = msg('bgShowNow');
    item.addEventListener('click', () => setCurrentBackground(id));

    const del = document.createElement('button');
    del.type = 'button';
    del.textContent = '✕';
    del.title = msg('delete');
    del.addEventListener('click', (e) => {
      e.stopPropagation();
      removeBackground(id);
    });

    item.append(del);
    bgList.append(item);
    thumbObserver.observe(item);
  }

  const n = bgIds.length;
  $('bgCount').textContent = n ? `(${n})` : '';
  $('bgEmpty').hidden = n > 0;
  $('bgClear').hidden = n === 0;
  $('bgRotation').hidden = n < 2;
  $('bgOneNote').hidden = n !== 1;
}

function markCurrentBg() {
  const current = currentBgId();
  for (const el of bgList.children) el.classList.toggle('current', el.dataset.id === current);
}

async function setCurrentBackground(id) {
  const i = bgIds.indexOf(id);
  if (i === -1) return;
  bgState = { index: i, changedAt: Date.now() };
  markCurrentBg();
  showBackground(id, true);
  scheduleBackground();
  await saveBg();
}

async function removeBackground(id) {
  await withBgLock(async () => {
    const ids = await readBgIds();
    const i = ids.indexOf(id);
    if (i === -1) return;
    const currentId = currentBgId();
    ids.splice(i, 1);
    bgIds = ids;
    const ci = bgIds.indexOf(currentId);
    if (ci !== -1) {
      bgState.index = ci;
    } else {
      bgState.index = i; // показанный фон удалён — следующий начинает свой интервал
      bgState.changedAt = Date.now();
    }
    normalizeBgState();
    await saveBg({ bgIds });
    await bgdbDelete([id]);
  });
  onBackgroundsChanged();
}

function setBusy(text) {
  $('bgBusy').hidden = !text;
  $('bgBusy').textContent = text || '';
  $('bgAdd').disabled = !!text;
  $('bgClear').disabled = !!text;
  $('importBtn').disabled = !!text;
}

// добавляет картинки по одной: каждая сразу сохраняется и появляется в списке
async function addBackgrounds(blobs) {
  let failed = 0;
  await withBgLock(async () => {
    for (let k = 0; k < blobs.length; k++) {
      setBusy(msg('bgProcessingProgress', k + 1, blobs.length));
      let id;
      try { id = await bgStoreImage(blobs[k]); }
      catch { failed++; continue; }

      const ids = await readBgIds();
      if (!ids.length) bgState.index = 0;
      // пока картинок меньше двух, фон не меняется — интервал начинает отсчёт сейчас
      if (ids.length < 2) bgState.changedAt = Date.now();
      ids.push(id);
      bgIds = ids;
      normalizeBgState();
      await saveBg({ bgIds });
      onBackgroundsChanged();
    }
  });
  setBusy('');
  return failed;
}

$('settingsBtn').addEventListener('click', () => {
  settingsDialog.showModal();
  syncSettingsForm();
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
  const failed = await addBackgrounds(files);
  if (failed) alert(msg('bgLoadFailed', failed));
});

$('bgClear').addEventListener('click', async () => {
  if (!confirm(msg('confirmRemoveAllBackgrounds'))) return;
  await withBgLock(async () => {
    bgIds = [];
    bgState = { index: 0, changedAt: 0 };
    await saveBg({ bgIds });
    await bgdbClear();
  });
  onBackgroundsChanged();
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

// ---------- Экспорт / импорт (плитки, настройки и фоны) ----------
$('exportBgs').addEventListener('change', (e) => {
  settings.exportBackgrounds = e.target.checked;
  save();
});

// файл собирается из частей, а не одной строкой: с сотнями фонов строка была бы слишком длинной
$('exportBtn').addEventListener('click', async () => {
  const parts = ['{"tiles":', JSON.stringify(tiles), ',"settings":', JSON.stringify(settings)];

  if (settings.exportBackgrounds && bgIds.length) {
    const blobs = [];
    for (const id of bgIds) {
      const rec = await bgdbGet(id).catch(() => null);
      if (rec) blobs.push(rec.full);
    }
    // в JSON картинки записываются как base64 — это на треть больше их размера
    const mb = Math.round(blobs.reduce((sum, b) => sum + b.size, 0) * 4 / 3 / 1048576);
    if (mb >= EXPORT_WARN_MB && !confirm(msg('exportLarge', mb))) return;

    setBusy(msg('exportPreparing'));
    parts.push(',"backgrounds":[');
    for (let k = 0; k < blobs.length; k++) {
      parts.push((k ? ',' : '') + JSON.stringify(await bgBlobToDataUrl(blobs[k])));
    }
    parts.push(']');
    setBusy('');
  }
  parts.push('}');

  const blob = new Blob(parts, { type: 'application/json' });
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

    // фоны: список data URL (1.3.0 и новее) или один фон в settings.bg (до 1.3.0);
    // если фонов в файле нет, текущие остаются
    let urls = null;
    if (Array.isArray(data.backgrounds)) urls = data.backgrounds.filter(isImageDataUrl);
    else if (legacyBg(data.settings)) urls = [legacyBg(data.settings)];

    if (urls) {
      await withBgLock(async () => {
        const oldIds = await readBgIds();
        const ids = [];
        for (let k = 0; k < urls.length; k++) {
          setBusy(msg('bgProcessingProgress', k + 1, urls.length));
          try { ids.push(await bgStoreImage(await bgDataUrlToBlob(urls[k]))); }
          catch { /* битую картинку пропускаем */ }
        }
        bgIds = ids;
        bgState = { index: 0, changedAt: Date.now() };
        await saveBg({ tiles, settings, bgIds });
        await bgdbDelete(oldIds);
      });
      setBusy('');
    } else {
      await save();
    }
    applySettings(); syncSettingsForm(); render(); onBackgroundsChanged();
  } catch (err) {
    setBusy('');
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
  if ((changes.bgIds || changes.bgState) && !ownBgWrite) {
    if (changes.bgIds) bgIds = cleanIds(changes.bgIds.newValue);
    // в режиме «при каждой новой вкладке» открытые вкладки свой фон не меняют
    if (changes.bgState && (settings.bgMode === 'interval' || changes.bgIds)) {
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
  await migrateBackgrounds();
  await initBackground();
  cleanupOrphanBackgrounds();
})();
