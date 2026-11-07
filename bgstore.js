'use strict';

// Хранилище фоновых картинок в IndexedDB.
// Запись: { id, full: Blob (JPEG размером с экран), thumb: Blob (JPEG 240×150) }.
// Порядок картинок хранится отдельно, в chrome.storage.local (ключ bgIds),
// поэтому новая вкладка читает из базы только одну нужную картинку.

const BGDB_NAME = 'speed-dial';
const BGDB_STORE = 'images';
let bgdbPromise = null;

function bgdbOpen() {
  if (!bgdbPromise) {
    bgdbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(BGDB_NAME, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(BGDB_STORE, { keyPath: 'id' });
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => { bgdbPromise = null; reject(req.error); };
    });
  }
  return bgdbPromise;
}

// выполняет работу в транзакции и ждёт её завершения (данные гарантированно записаны)
async function bgdbTx(mode, work) {
  const db = await bgdbOpen();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(BGDB_STORE, mode);
    let result;
    const req = work(tx.objectStore(BGDB_STORE));
    if (req) req.onsuccess = () => { result = req.result; };
    tx.oncomplete = () => resolve(result);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

const bgdbGet = (id) => bgdbTx('readonly', (s) => s.get(id));
const bgdbPut = (record) => bgdbTx('readwrite', (s) => s.put(record));
const bgdbKeys = () => bgdbTx('readonly', (s) => s.getAllKeys());
const bgdbClear = () => bgdbTx('readwrite', (s) => s.clear());
const bgdbDelete = (ids) => bgdbTx('readwrite', (s) => { ids.forEach((id) => s.delete(id)); });

// ---------- Подготовка картинок ----------
const BG_THUMB_W = 240;
const BG_THUMB_H = 150;

function bgCanvasToBlob(bmp, w, h, sx, sy, sw, sh, quality) {
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#000'; // прозрачные места PNG станут чёрными, а не белыми
  ctx.fillRect(0, 0, w, h);
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(bmp, sx, sy, sw, sh, 0, 0, w, h);
  return new Promise((resolve, reject) => {
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('toBlob'))), 'image/jpeg', quality);
  });
}

// картинка уменьшается до размера экрана (она растягивается на весь экран, cover)
// и сжимается в JPEG; плюс маленькая миниатюра для списка в настройках
async function bgProcessImage(blob) {
  const bmp = await createImageBitmap(blob);
  try {
    // размер экрана бывает неизвестен (0, например у скрытой страницы) —
    // тогда считаем Full HD; цель не меньше 1280×720 и не больше 3840×2160
    const dpr = window.devicePixelRatio > 0 ? window.devicePixelRatio : 1;
    const screenW = screen.width > 0 ? screen.width : 1920;
    const screenH = screen.height > 0 ? screen.height : 1080;
    const maxW = Math.min(3840, Math.max(1280, Math.round(screenW * dpr)));
    const maxH = Math.min(2160, Math.max(720, Math.round(screenH * dpr)));
    const scale = Math.min(1, Math.max(maxW / bmp.width, maxH / bmp.height));
    const w = Math.max(1, Math.round(bmp.width * scale));
    const h = Math.max(1, Math.round(bmp.height * scale));
    const full = await bgCanvasToBlob(bmp, w, h, 0, 0, bmp.width, bmp.height, 0.85);

    // миниатюра: обрезка по центру до пропорций 16:10
    const ratio = BG_THUMB_W / BG_THUMB_H;
    let sw = bmp.width, sh = bmp.height;
    if (sw / sh > ratio) sw = sh * ratio; else sh = sw / ratio;
    const thumb = await bgCanvasToBlob(bmp, BG_THUMB_W, BG_THUMB_H,
      (bmp.width - sw) / 2, (bmp.height - sh) / 2, sw, sh, 0.8);

    return { full, thumb };
  } finally {
    bmp.close();
  }
}

// обрабатывает картинку, сохраняет её в базу и возвращает её id
async function bgStoreImage(blob) {
  const { full, thumb } = await bgProcessImage(blob);
  const id = crypto.randomUUID();
  await bgdbPut({ id, full, thumb });
  return id;
}

async function bgDataUrlToBlob(dataUrl) {
  return (await fetch(dataUrl)).blob();
}

function bgBlobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

// все изменения списка фонов идут под одной блокировкой, общей для всех вкладок
function withBgLock(fn) {
  return navigator.locks ? navigator.locks.request('speed-dial-bg', fn) : fn();
}
