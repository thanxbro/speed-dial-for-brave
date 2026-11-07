'use strict';

const $ = (id) => document.getElementById(id);

let tiles = [];
let existingIndex = -1;
let shot = '';

// уменьшаем скриншот до 480×300 (верх страницы), чтобы не занимать много места
async function makeThumb(dataUrl) {
  const img = new Image();
  img.src = dataUrl;
  await img.decode();
  const W = 480, H = 300;
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const srcH = Math.min(img.height, img.width * H / W);
  canvas.getContext('2d').drawImage(img, 0, 0, img.width, srcH, 0, 0, W, H);
  return canvas.toDataURL('image/jpeg', 0.8);
}

async function init() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

  if (!tab || !/^https?:/i.test(tab.url || '')) {
    $('error').hidden = false;
    return;
  }

  $('form').hidden = false;
  $('url').value = tab.url;
  $('title').value = tab.title || '';

  tiles = await loadTiles();
  existingIndex = tiles.findIndex(t => urlKey(t.url) === urlKey(tab.url));
  if (existingIndex !== -1) {
    $('exists').hidden = false;
    $('addBtn').textContent = msg('updateTile');
    if (tiles[existingIndex].title) $('title').value = tiles[existingIndex].title;
  }

  try {
    const raw = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'jpeg', quality: 85 });
    shot = await makeThumb(raw);
    $('preview').src = shot;
    $('shotBox').hidden = false;
    $('shotRow').hidden = false;
  } catch {
    // некоторые страницы (например, магазин расширений) снимать нельзя — тогда будет значок сайта
  }

  $('title').focus();
  $('title').select();
}

$('useShot').addEventListener('change', (e) => {
  $('shotBox').style.opacity = e.target.checked ? '1' : '.35';
});

$('form').addEventListener('submit', async (e) => {
  e.preventDefault();

  const tile = {
    url: normalizeUrl($('url').value),
    title: $('title').value.trim(),
    shot: shot && $('useShot').checked ? shot : '',
  };

  // перечитываем плитки на случай, если их изменили, пока окошко было открыто
  tiles = await loadTiles();
  const i = tiles.findIndex(t => urlKey(t.url) === urlKey(tile.url));
  if (i === -1) tiles.push({ ...tile, image: '' });
  else tiles[i] = { ...tiles[i], ...tile };

  await chrome.storage.local.set({ tiles });

  $('addBtn').hidden = true;
  $('done').hidden = false;
  setTimeout(() => window.close(), 800);
});

localizePage();
init();
