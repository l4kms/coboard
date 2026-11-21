'use strict';

(() => {

// ============================================================
// 1. DOM и контексты
// ============================================================
const $ = (id) => document.getElementById(id);
const lobbyEl = $('lobby');
const editorEl = $('editor');
const board = $('board');
const overlay = $('overlay');
const ctx = board.getContext('2d', { willReadFrequently: true });
const octx = overlay.getContext('2d', { alpha: true });

const colorInput = $('colorInput');
const sizeInput = $('sizeInput');
const opacityInput = $('opacityInput');
const statusRoom = $('statusRoom');
const statusUsers = $('statusUsers');
const statusCoords = $('statusCoords');

// Мобильные фиксы
document.addEventListener('gesturestart', (e) => e.preventDefault());
document.addEventListener('gesturechange', (e) => e.preventDefault());
document.addEventListener('gestureend', (e) => e.preventDefault());

// ============================================================
// 2. Сезонное оформление (Снег, листья, гирлянда)
// ============================================================
function initSeasonDecor() {
  const month = new Date().getMonth();
  const container = $('seasonDecor');
  const garland = $('garland');
  if (!container) return;

  const isWinter = (month === 11 || month <= 1);
  const isAutumn = (month >= 8 && month <= 10);

  if (isWinter) {
    for (let i = 0; i < 50; i++) {
      const flake = document.createElement('div');
      flake.className = 'particle snow'; flake.textContent = '❄';
      flake.style.left = Math.random() * 100 + 'vw';
      flake.style.fontSize = (Math.random() * 10 + 10) + 'px';
      flake.style.animationDuration = (Math.random() * 4 + 4) + 's';
      flake.style.animationDelay = (Math.random() * 5) + 's';
      container.appendChild(flake);
    }
    if (garland) {
      const icons = ['🎄', '🎁', '❄', '🔔'];
      for (let i = 0; i < 8; i++) {
        const span = document.createElement('span');
        span.textContent = icons[i % icons.length];
        span.style.animationDelay = (i * 0.2) + 's';
        garland.appendChild(span);
      }
    }
  } else if (isAutumn) {
    for (let i = 0; i < 30; i++) {
      const leaf = document.createElement('div');
      leaf.className = 'particle leaf'; leaf.textContent = '🍂';
      leaf.style.left = Math.random() * 100 + 'vw';
      leaf.style.fontSize = (Math.random() * 15 + 15) + 'px';
      leaf.style.animationDuration = (Math.random() * 5 + 5) + 's';
      leaf.style.animationDelay = (Math.random() * 5) + 's';
      container.appendChild(leaf);
    }
  } else if (month >= 2 && month <= 4) {
    for (let i = 0; i < 20; i++) {
      const petal = document.createElement('div');
      petal.className = 'particle leaf'; petal.textContent = '🌸';
      petal.style.left = Math.random() * 100 + 'vw';
      petal.style.fontSize = (Math.random() * 12 + 12) + 'px';
      petal.style.animationDuration = (Math.random() * 6 + 6) + 's';
      petal.style.animationDelay = (Math.random() * 5) + 's';
      container.appendChild(petal);
    }
  } else {
    const sun = document.createElement('div');
    sun.textContent = '☀️';
    sun.style.cssText = 'position:absolute; top:30px; right:40px; font-size:48px; animation: float 4s infinite;';
    container.appendChild(sun);
  }
}
initSeasonDecor();

// ============================================================
// 3. Состояние
// ============================================================
let socket = null;
let roomId = null;
let authorId = null;
let maxUsers = 2;

let tool = 'pen';
let color = '#000000';
let size = 4;
let opacity = 1;

let zoom = 1;
let panX = 0, panY = 0;
let gridOn = false;

let isDrawing = false;
let isPanning = false;
let panStart = null;

let lastPoint = null;
let shapeStart = null;
let activePointerId = null;
let spaceDown = false;

let strokePoints = []; // Перенесено сюда во избежание ошибки TDZ
let selection = null;
let clipCanvas = null;
let localEvents = [];

// Синхронизация
let lastSeq = 0;
const pendingEvents = new Map();
const imageCache = new Map();
let applyQueue = Promise.resolve();

// Заливка
const fillWorker = new Worker('/fill-worker.js');
const fillResolvers = [];
fillWorker.onmessage = (e) => {
  const r = fillResolvers.shift();
  if (r) r(e.data);
};

// История (Undo/Redo)
const MAX_HISTORY = 60;
const history = [];
let historyIndex = -1;
let pendingBBox = null;

// ============================================================
// 4. Overlay и статус
// ============================================================
const remoteCursors = new Map();
let cursorsDirty = false;
let gridDirty = false;
let selectionDirty = false;
let overlayScheduled = false;
let lastCursorDraw = 0;
let lastCursorSend = 0;

function scheduleOverlay() {
  if (overlayScheduled) return;
  overlayScheduled = true;
  requestAnimationFrame(renderOverlay);
}
function renderOverlay(ts) {
  overlayScheduled = false;
  const now = ts || performance.now();
  const needCursor = cursorsDirty && (now - lastCursorDraw > 33);
  const any = needCursor || gridDirty || selection || selectionDirty;
  if (!any) return;
  octx.clearRect(0, 0, overlay.width, overlay.height);
  if (gridDirty) drawGrid();
  if (selection) drawSelectionRect();
  if (needCursor) {
    drawRemoteCursors(now);
    lastCursorDraw = now;
    cursorsDirty = false;
  }
  selectionDirty = false;
}
function drawGrid() {
  if (!gridOn) { gridDirty = false; return; }
  octx.save(); octx.strokeStyle = 'rgba(0,0,0,0.08)'; octx.lineWidth = 1 / zoom;
  const step = 40;
  octx.beginPath();
  for (let x = 0; x <= board.width; x += step) { octx.moveTo(x, 0); octx.lineTo(x, board.height); }
  for (let y = 0; y <= board.height; y += step) { octx.moveTo(0, y); octx.lineTo(board.width, y); }
  octx.stroke(); octx.restore(); gridDirty = false;
}
function drawSelectionRect() {
  if (!selection) return;
  octx.save(); octx.strokeStyle = '#2563eb'; octx.lineWidth = 1.5 / zoom;
  octx.setLineDash([6 / zoom, 4 / zoom]);
  octx.strokeRect(selection.x, selection.y, selection.w, selection.h);
  octx.restore();
}
function drawRemoteCursors(now) {
  for (const [id, cur] of remoteCursors) {
    if (now - cur.t > 10000) { remoteCursors.delete(id); continue; }
    const sx = cur.x, sy = cur.y;
    octx.save(); octx.fillStyle = '#e11d48';
    octx.beginPath();
    octx.moveTo(sx, sy); octx.lineTo(sx + 12 / zoom, sy + 16 / zoom);
    octx.lineTo(sx + 6 / zoom, sy + 16 / zoom); octx.lineTo(sx + 10 / zoom, sy + 22 / zoom);
    octx.lineTo(sx + 6 / zoom, sy + 24 / zoom); octx.lineTo(sx + 2 / zoom, sy + 17 / zoom);
    octx.lineTo(sx - 2 / zoom, sy + 21 / zoom); octx.closePath(); octx.fill();
    octx.font = `${12 / zoom}px sans-serif`; octx.fillStyle = '#fff';
    octx.strokeStyle = '#000'; octx.lineWidth = 0.5 / zoom;
    octx.strokeText(id, sx + 14 / zoom, sy + 14 / zoom);
    octx.fillText(id, sx + 14 / zoom, sy + 14 / zoom);
    octx.restore();
  }
}
function sendCursorThrottled(x, y) {
  const now = performance.now();
  if (now - lastCursorSend < 66) return;
  lastCursorSend = now;
  if (socket && roomId) socket.emit('cursor', { x, y, zoom });
}
function updateStatus() {
  statusRoom.textContent = roomId ? `Комната: ${roomId}` : '—';
  statusUsers.textContent = `Участники: ${remoteCursors.size + (roomId ? 1 : 0)} / ${maxUsers}`;
}

// ============================================================
// 5. История (Undo/Redo)
// ============================================================
function bboxExpand(x, y, pad = 0) {
  const x1 = x - pad, y1 = y - pad, x2 = x + pad, y2 = y + pad;
  if (!pendingBBox) pendingBBox = { x1, y1, x2, y2 };
  else {
    if (x1 < pendingBBox.x1) pendingBBox.x1 = x1;
    if (y1 < pendingBBox.y1) pendingBBox.y1 = y1;
    if (x2 > pendingBBox.x2) pendingBBox.x2 = x2;
    if (y2 > pendingBBox.y2) pendingBBox.y2 = y2;
  }
}
function beginHistory() { pendingBBox = null; }
function commitHistory() {
  if (!pendingBBox) return;
  const b = pendingBBox; pendingBBox = null;
  const x = Math.max(0, Math.floor(b.x1)); const y = Math.max(0, Math.floor(b.y1));
  const w = Math.min(board.width - x, Math.ceil(b.x2 - x)); const h = Math.min(board.height - y, Math.ceil(b.y2 - y));
  if (w <= 0 || h <= 0) return;
  try {
    const img = ctx.getImageData(x, y, w, h);
    if (historyIndex < history.length - 1) history.length = historyIndex + 1;
    history.push({ img, x, y, w, h });
    if (history.length > MAX_HISTORY) history.shift();
    historyIndex = history.length - 1;
  } catch (e) {}
}
function undo() {
  if (historyIndex < 0) return;
  const h = history[historyIndex];
  try {
    const cur = ctx.getImageData(h.x, h.y, h.w, h.h);
    ctx.putImageData(h.img, h.x, h.y); h.img = cur; historyIndex--;
  } catch (e) {}
}
function redo() {
  if (historyIndex >= history.length - 1) return;
  historyIndex++;
  const h = history[historyIndex];
  try {
    const cur = ctx.getImageData(h.x, h.y, h.w, h.h);
    ctx.putImageData(h.img, h.x, h.y); h.img = cur;
  } catch (e) {}
}

// ============================================================
// 6. Viewport
// ============================================================
function applyViewport() {
  const t = `translate(${panX}px, ${panY}px) scale(${zoom})`;
  board.style.transform = t; overlay.style.transform = t;
}
function zoomAt(factor, clientX, clientY) {
  const rect = board.getBoundingClientRect();
  const worldX = (clientX - rect.left) / zoom; const worldY = (clientY - rect.top) / zoom;
  zoom = Math.max(0.25, Math.min(6, zoom * factor));
  panX = clientX - worldX * zoom; panY = clientY - worldY * zoom;
  applyViewport(); gridDirty = true; selectionDirty = true; scheduleOverlay();
}
function getBoardPoint(e) {
  const rect = board.getBoundingClientRect();
  return { x: (e.clientX - rect.left) / zoom, y: (e.clientY - rect.top) / zoom };
}
function pointInRect(x, y, r) {
  return x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h;
}
function simplifyPoints(points, tol = 0.8) {
  if (points.length <= 2) return points;
  const out = [points[0]]; let last = points[0];
  for (let i = 1; i < points.length - 1; i++) {
    const p = points[i];
    if ((p[0]-last[0])**2 + (p[1]-last[1])**2 >= tol*tol) { out.push(p); last = p; }
  }
  out.push(points[points.length - 1]); return out;
}
function setActiveTool(t) {
  tool = t;
  const map = { pen: 'btnPen', eraser: 'btnEraser', 'eraser-line': 'btnEraserLine', fill: 'btnFill', picker: 'btnPicker', line: 'btnLine', rect: 'btnRect', ellipse: 'btnEllipse', text: 'btnText', select: 'btnSelect', move: 'btnMove' };
  for (const k of Object.keys(map)) { const el = $(map[k]); if (el) el.classList.toggle('active', k === t); }
  board.classList.toggle('pan', t === 'move');
}

// ============================================================
// 7. Заливка
// ============================================================
function hexToRgba(hex) {
  let h = hex.replace('#', '');
  if (h.length === 3) h = h.split('').map(c => c + c).join('');
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16), 255];
}
function floodFillAsync(x, y, colorHex, op) {
  return new Promise((resolve) => {
    let img;
    try { img = ctx.getImageData(0, 0, board.width, board.height); }
    catch (e) { resolve(null); return; }
    const [fr, fg, fb] = hexToRgba(colorHex);
    const fa = Math.round(255 * (op != null ? op : opacity));
    fillResolvers.push((res) => {
      if (!res || !res.bbox) { resolve(null); return; }
      const { x: bx, y: by, w, h } = res.bbox;
      const u8 = new Uint8ClampedArray(res.buffer);
      const region = new ImageData(w, h);
      for (let row = 0; row < h; row++) {
        const srcOff = ((by + row) * board.width + bx) * 4;
        region.data.set(u8.subarray(srcOff, srcOff + w * 4), row * w * 4);
      }
      ctx.putImageData(region, bx, by);
      resolve(res.bbox);
    });
    fillWorker.postMessage({ data: img.data, W: board.width, H: board.height, x: Math.floor(x), y: Math.floor(y), fill: [fr, fg, fb, fa], tol: 16 }, [img.data.buffer]);
  });
}

// ============================================================
// 8. Применение событий
// ============================================================
function decodeImage(src) {
  if (imageCache.has(src)) return imageCache.get(src);
  const p = fetch(src).then(r => r.blob()).then(b => createImageBitmap(b)).catch(() => null);
  imageCache.set(src, p);
  if (imageCache.size > 40) imageCache.delete(imageCache.keys().next().value);
  return p;
}

function drawShapeOnCtx(c, ev) {
  c.save(); c.globalAlpha = 1; c.globalCompositeOperation = 'source-over';
  c.strokeStyle = ev.color; c.fillStyle = ev.color;
  c.lineWidth = ev.size; c.lineCap = 'round'; c.lineJoin = 'round';
  if (ev.type === 'line') { c.beginPath(); c.moveTo(ev.x1, ev.y1); c.lineTo(ev.x2, ev.y2); c.stroke(); }
  else if (ev.type === 'rect') {
    const x = Math.min(ev.x1, ev.x2), y = Math.min(ev.y1, ev.y2); const w = Math.abs(ev.x2 - ev.x1), h = Math.abs(ev.y2 - ev.y1);
    if (ev.filled) c.fillRect(x, y, w, h); else c.strokeRect(x, y, w, h);
  } else if (ev.type === 'ellipse') {
    const cx = (ev.x1 + ev.x2) / 2, cy = (ev.y1 + ev.y2) / 2; const rx = Math.abs(ev.x2 - ev.x1) / 2, ry = Math.abs(ev.y2 - ev.y1) / 2;
    c.beginPath(); c.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2);
    if (ev.filled) c.fill(); else c.stroke();
  }
  c.restore();
}

function applyEventSync(ev) {
  switch (ev.type) {
    case 'stroke': {
      ctx.save();
      if (ev.erase) { ctx.globalCompositeOperation = 'destination-out'; ctx.strokeStyle = '#000'; ctx.fillStyle = '#000'; ctx.globalAlpha = 1; }
      else { ctx.globalCompositeOperation = 'source-over'; ctx.globalAlpha = ev.opacity != null ? ev.opacity : 1; ctx.strokeStyle = ev.color; ctx.fillStyle = ev.color; }
      ctx.lineWidth = ev.size; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
      const pts = ev.points;
      if (pts.length === 1) { ctx.beginPath(); ctx.arc(pts[0][0], pts[0][1], ev.size / 2, 0, Math.PI * 2); ctx.fill(); }
      else { ctx.beginPath(); ctx.moveTo(pts[0][0], pts[0][1]); for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]); ctx.stroke(); }
      ctx.restore(); break;
    }
    case 'line': case 'rect': case 'ellipse': drawShapeOnCtx(ctx, ev); break;
    case 'text': {
      ctx.save(); ctx.globalAlpha = 1; ctx.fillStyle = ev.color; ctx.font = `${ev.size}px -apple-system, "Segoe UI", Roboto, sans-serif`; ctx.textBaseline = 'top';
      ev.text.split('\n').forEach((ln, i) => ctx.fillText(ln, ev.x, ev.y + i * ev.size * 1.25));
      ctx.restore(); break;
    }
    case 'deleteSelection': ctx.clearRect(ev.x, ev.y, ev.w, ev.h); break;
    case 'clearArea': ctx.clearRect(ev.x, ev.y, ev.w, ev.h); break;
    case 'clear': ctx.clearRect(0, 0, board.width, board.height); break;
  }
}

async function applyEventSerialized(ev) {
  if (!ev || typeof ev.type !== 'string') return;
  if (ev.type === 'cutSelection') { ctx.clearRect(ev.x, ev.y, ev.w, ev.h); if (ev.src) { decodeImage(ev.src).then(bmp => { if (!bmp) return; const clip = document.createElement('canvas'); clip.width = ev.w; clip.height = ev.h; clip.getContext('2d').drawImage(bmp, 0, 0, ev.w, ev.h); clipCanvas = clip; }).catch(() => {}); } return; }
  if (ev.type === 'fill') { if (ev.src) { let bmp; try { bmp = await decodeImage(ev.src); } catch (e) { return; } if (bmp) ctx.drawImage(bmp, ev.x, ev.y, ev.w, ev.h); } else { await floodFillAsync(ev.x, ev.y, ev.color, ev.opacity); } return; }
  if (ev.type === 'pasteImage' || ev.type === 'moveSelection') { let bmp; try { bmp = await decodeImage(ev.src); } catch (e) { return; } if (!bmp) return; if (ev.type === 'moveSelection') { ctx.clearRect(ev.fromX, ev.fromY, ev.w, ev.h); ctx.drawImage(bmp, ev.x, ev.y, ev.w, ev.h); } else { ctx.drawImage(bmp, ev.x, ev.y, ev.w, ev.h); } return; }
  applyEventSync(ev);
}

function enqueueApply(ev) { applyQueue = applyQueue.then(() => applyEventSerialized(ev)).catch(() => {}); }
function drainPending() { while (pendingEvents.has(lastSeq + 1)) { const ev = pendingEvents.get(lastSeq + 1); pendingEvents.delete(lastSeq + 1); enqueueApply(ev); lastSeq++; } }

function handleIncoming(ev) {
  if (!ev || typeof ev.seq !== 'number') return;
  if (ev.seq > lastSeq) lastSeq = ev.seq;
  if (ev.authorId && ev.authorId === authorId) { drainPending(); return; }
  enqueueApply(ev); drainPending();
}

// ============================================================
// 9. Сеть
// ============================================================
function connect() {
  if (socket) return;
  socket = io({ transports: ['websocket', 'polling'] });
  socket.on('draw', handleIncoming);
  socket.on('cursor', (data) => { if (!data || typeof data.authorId !== 'string') return; remoteCursors.set(data.authorId, { x: data.x, y: data.y, t: performance.now() }); cursorsDirty = true; scheduleOverlay(); });
  socket.on('userJoined', () => updateStatus());
  socket.on('userLeft', (data) => { if (data && data.authorId) remoteCursors.delete(data.authorId); cursorsDirty = true; scheduleOverlay(); updateStatus(); });
  socket.on('fullSync', async (data) => {
    if (!data || !Array.isArray(data.events)) return;
    board.style.pointerEvents = 'none';
    try {
      ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, board.width, board.height);
      lastSeq = 0; pendingEvents.clear(); applyQueue = Promise.resolve();
      localEvents = [];
      for (const ev of data.events) {
        if (typeof ev.seq !== 'number') continue;
        if (ev.authorId === authorId) { lastSeq = Math.max(lastSeq, ev.seq); continue; }
        await applyEventSerialized(ev); lastSeq = Math.max(lastSeq, ev.seq);
        if (['stroke','line','rect','ellipse'].includes(ev.type)) localEvents.push(ev);
      }
      history.length = 0; historyIndex = -1;
    } finally { board.style.pointerEvents = ''; }
  });
  socket.on('disconnect', () => { remoteCursors.clear(); updateStatus(); });
}

function sendDraw(ev) {
  if (!socket || !roomId) return;
  socket.emit('draw', ev, (res) => { if (res && typeof res.seq === 'number') { if (res.seq > lastSeq) lastSeq = res.seq; drainPending(); } });
}

// ============================================================
// 10. Инструменты
// ============================================================
function startStroke(pt) {
  beginHistory(); bboxExpand(pt.x, pt.y, size + 2);
  isDrawing = true; lastPoint = pt;
  strokePoints = [[pt.x, pt.y]];
  
  ctx.save();
  if (tool === 'eraser') { ctx.globalCompositeOperation = 'destination-out'; ctx.strokeStyle = '#000'; ctx.fillStyle = '#000'; ctx.globalAlpha = 1; }
  else { ctx.globalCompositeOperation = 'source-over'; ctx.globalAlpha = opacity; ctx.strokeStyle = color; ctx.fillStyle = color; }
  ctx.lineWidth = size; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  ctx.beginPath(); ctx.arc(pt.x, pt.y, size / 2, 0, Math.PI * 2); ctx.fill();
  ctx.restore();
}

function continueStroke(pt) {
  ctx.save();
  if (tool === 'eraser') { ctx.globalCompositeOperation = 'destination-out'; ctx.strokeStyle = '#000'; ctx.globalAlpha = 1; }
  else { ctx.globalCompositeOperation = 'source-over'; ctx.globalAlpha = opacity; ctx.strokeStyle = color; }
  ctx.lineWidth = size; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  ctx.beginPath(); ctx.moveTo(lastPoint.x, lastPoint.y); ctx.lineTo(pt.x, pt.y); ctx.stroke();
  ctx.restore();
  strokePoints.push([pt.x, pt.y]); bboxExpand(pt.x, pt.y, size + 2); lastPoint = pt;
}

function finishStroke() {
  isDrawing = false;
  if (strokePoints.length === 0) return;
  commitHistory();
  const ev = { type: 'stroke', points: simplifyPoints(strokePoints), color: tool === 'eraser' ? '#000' : color, size, erase: tool === 'eraser', opacity: tool === 'eraser' ? 1 : opacity };
  sendDraw(ev);
  localEvents.push(ev);
  strokePoints = [];
}

function previewShape(pt) {
  octx.clearRect(0, 0, overlay.width, overlay.height);
  drawShapeOnCtx(octx, { type: tool, x1: shapeStart.x, y1: shapeStart.y, x2: pt.x, y2: pt.y, size, color, filled: false });
  lastPoint = pt;
}

function finishShape() {
  isDrawing = false;
  octx.clearRect(0, 0, overlay.width, overlay.height);
  if (!shapeStart || !lastPoint) { shapeStart = null; return; }
  if (shapeStart.x === lastPoint.x && shapeStart.y === lastPoint.y) { shapeStart = null; return; }
  beginHistory(); bboxExpand(shapeStart.x, shapeStart.y, size + 2); bboxExpand(lastPoint.x, lastPoint.y, size + 2);
  const ev = { type: tool, x1: shapeStart.x, y1: shapeStart.y, x2: lastPoint.x, y2: lastPoint.y, size, color, filled: false };
  drawShapeOnCtx(ctx, ev); commitHistory(); sendDraw(ev);
  localEvents.push(ev);
  shapeStart = null;
}

async function pushFillHistory(pt) {
  beginHistory();
  const bbox = await floodFillAsync(pt.x, pt.y, color, opacity);
  if (bbox) {
    bboxExpand(bbox.x, bbox.y, 0); bboxExpand(bbox.x + bbox.w, bbox.y + bbox.h, 0); commitHistory();
    const region = ctx.getImageData(bbox.x, bbox.y, bbox.w, bbox.h);
    const tmp = document.createElement('canvas'); tmp.width = bbox.w; tmp.height = bbox.h;
    tmp.getContext('2d').putImageData(region, 0, 0);
    sendDraw({ type: 'fill', x: bbox.x, y: bbox.y, w: bbox.w, h: bbox.h, src: tmp.toDataURL('image/png'), color, opacity });
  }
}

function pickColor(pt) {
  try { const d = ctx.getImageData(Math.floor(pt.x), Math.floor(pt.y), 1, 1).data; color = '#' + [d[0], d[1], d[2]].map(v => v.toString(16).padStart(2, '0')).join(''); colorInput.value = color; } catch (e) {}
}

function startTextInput(pt) {
  if (isDrawing) return;
  isDrawing = true; const text = prompt('Введите текст:'); if (!text) { isDrawing = false; return; }
  beginHistory(); bboxExpand(pt.x, pt.y, 400);
  const ev = { type: 'text', x: pt.x, y: pt.y, size: Math.max(12, size * 4), color, text };
  applyEventSync(ev); commitHistory(); sendDraw(ev); isDrawing = false;
}

// === УМНЫЙ ЛАСТИК ===
function eraseLineAt(pt) {
  const x = pt.x, y = pt.y;
  const tolerance = Math.max(20, size * 3);
  let erased = false;
  for (let i = localEvents.length - 1; i >= 0; i--) {
    const ev = localEvents[i];
    let isHit = false;
    if (ev.type === 'stroke' && ev.points) {
      for (const p of ev.points) { if (Math.hypot(p[0] - x, p[1] - y) < tolerance) { isHit = true; break; } }
    } else if (ev.type === 'line') {
      if (distToSegment({x, y}, {x: ev.x1, y: ev.y1}, {x: ev.x2, y: ev.y2}) < tolerance) isHit = true;
    } else if (ev.type === 'rect') {
      const rx = Math.min(ev.x1, ev.x2), ry = Math.min(ev.y1, ev.y2); const rw = Math.abs(ev.x2 - ev.x1), rh = Math.abs(ev.y2 - ev.y1);
      if (x >= rx - tolerance && x <= rx + rw + tolerance && y >= ry - tolerance && y <= ry + rh + tolerance) isHit = true;
    } else if (ev.type === 'ellipse') {
      const cx = (ev.x1 + ev.x2) / 2, cy = (ev.y1 + ev.y2) / 2; const rx = Math.abs(ev.x2 - ev.x1) / 2, ry = Math.abs(ev.y2 - ev.y1) / 2;
      if (((x - cx) ** 2) / ((rx + tolerance) ** 2) + ((y - cy) ** 2) / ((ry + tolerance) ** 2) <= 1) isHit = true;
    }
    if (isHit) {
      localEvents.splice(i, 1);
      redrawAll();
      const bbox = getEventBBox(ev);
      beginHistory(); bboxExpand(bbox.x, bbox.y, 2); bboxExpand(bbox.x + bbox.w, bbox.y + bbox.h, 2); commitHistory();
      sendDraw({ type: 'clearArea', x: bbox.x, y: bbox.y, w: bbox.w, h: bbox.h });
      erased = true; break;
    }
  }
}

function distToSegment(p, v, w) {
  const l2 = (w.x - v.x) ** 2 + (w.y - v.y) ** 2; if (l2 === 0) return Math.hypot(p.x - v.x, p.y - v.y);
  let t = ((p.x - v.x) * (w.x - v.x) + (p.y - v.y) * (w.y - v.y)) / l2; t = Math.max(0, Math.min(1, t));
  const proj = { x: v.x + t * (w.x - v.x), y: v.y + t * (w.y - v.y) }; return Math.hypot(p.x - proj.x, p.y - proj.y);
}

function getEventBBox(ev) {
  if (ev.type === 'stroke' && ev.points) {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const p of ev.points) { minX = Math.min(minX, p[0]); maxX = Math.max(maxX, p[0]); minY = Math.min(minY, p[1]); maxY = Math.max(maxY, p[1]); }
    const pad = ev.size || 4; return { x: minX - pad, y: minY - pad, w: maxX - minX + pad * 2, h: maxY - minY + pad * 2 };
  } else if (ev.type === 'line' || ev.type === 'rect' || ev.type === 'ellipse') {
    const minX = Math.min(ev.x1, ev.x2), minY = Math.min(ev.y1, ev.y2); const pad = ev.size || 4;
    return { x: minX - pad, y: minY - pad, w: Math.abs(ev.x2 - ev.x1) + pad * 2, h: Math.abs(ev.y2 - ev.y1) + pad * 2 };
  }
  return { x: 0, y: 0, w: 0, h: 0 };
}

function redrawAll() {
  ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, board.width, board.height);
  for (const ev of localEvents) applyEventSync(ev);
}

// ============================================================
// 11. Выделение
// ============================================================
let draggingSelection = false, dragBaseImage = null, dragClipOffset = null, dragCurrentRect = null, dragOldRect = null;
function startDragSelection(pt) {
  try { dragBaseImage = ctx.getImageData(0, 0, board.width, board.height); } catch (e) { return; }
  const sw = Math.max(1, Math.floor(selection.w)); const sh = Math.max(1, Math.floor(selection.h));
  const clip = document.createElement('canvas'); clip.width = sw; clip.height = sh;
  clip.getContext('2d').drawImage(board, selection.x, selection.y, sw, sh, 0, 0, sw, sh); clipCanvas = clip;
  dragOldRect = { x: selection.x, y: selection.y, w: sw, h: sh }; dragClipOffset = { x: pt.x - selection.x, y: pt.y - selection.y }; dragCurrentRect = { x: selection.x, y: selection.y, w: sw, h: sh };
  draggingSelection = true;
}
function dragSelectionMove(pt) {
  if (!dragBaseImage || !clipCanvas || !dragOldRect) return;
  ctx.putImageData(dragBaseImage, 0, 0);
  const newX = Math.round(pt.x - dragClipOffset.x); const newY = Math.round(pt.y - dragClipOffset.y);
  ctx.clearRect(dragOldRect.x, dragOldRect.y, dragOldRect.w, dragOldRect.h); ctx.drawImage(clipCanvas, newX, newY);
  dragCurrentRect = { x: newX, y: newY, w: clipCanvas.width, h: clipCanvas.height }; selectionDirty = true; scheduleOverlay();
}
function finishDragSelection() {
  draggingSelection = false;
  if (!dragCurrentRect || !clipCanvas || !dragOldRect) { dragBaseImage = null; dragCurrentRect = null; dragOldRect = null; return; }
  const oldR = dragOldRect, newR = dragCurrentRect;
  if (oldR.x === newR.x && oldR.y === newR.y) { dragBaseImage = null; dragCurrentRect = null; dragOldRect = null; selection = { x: oldR.x, y: oldR.y, w: oldR.w, h: oldR.h }; selectionDirty = true; scheduleOverlay(); return; }
  beginHistory(); bboxExpand(oldR.x, oldR.y, 2); bboxExpand(oldR.x + oldR.w, oldR.y + oldR.h, 2); bboxExpand(newR.x, newR.y, 2); bboxExpand(newR.x + newR.w, newR.y + newR.h, 2); commitHistory();
  selection = { x: newR.x, y: newR.y, w: newR.w, h: newR.h }; selectionDirty = true; scheduleOverlay();
  sendDraw({ type: 'moveSelection', fromX: oldR.x, fromY: oldR.y, x: newR.x, y: newR.y, w: newR.w, h: newR.h, src: clipCanvas.toDataURL('image/png') });
  dragBaseImage = null; dragCurrentRect = null; dragOldRect = null;
}
function cutSelection() {
  if (!selection) return; const w = Math.floor(selection.w), h = Math.floor(selection.h); if (w < 1 || h < 1) return;
  const clip = document.createElement('canvas'); clip.width = w; clip.height = h;
  clip.getContext('2d').drawImage(board, selection.x, selection.y, w, h, 0, 0, w, h); clipCanvas = clip;
  beginHistory(); bboxExpand(selection.x, selection.y, 2); bboxExpand(selection.x + w, selection.y + h, 2); ctx.clearRect(selection.x, selection.y, w, h); commitHistory();
  sendDraw({ type: 'cutSelection', x: selection.x, y: selection.y, w, h, src: clip.toDataURL('image/png') });
}
function deleteSelection() {
  if (!selection) return; const w = Math.floor(selection.w), h = Math.floor(selection.h); if (w < 1 || h < 1) return;
  beginHistory(); bboxExpand(selection.x, selection.y, 2); bboxExpand(selection.x + w, selection.y + h, 2); ctx.clearRect(selection.x, selection.y, w, h); commitHistory();
  sendDraw({ type: 'deleteSelection', x: selection.x, y: selection.y, w, h });
}
function pasteClipboard() {
  if (!clipCanvas) return; const w = clipCanvas.width, h = clipCanvas.height;
  const cx = (window.innerWidth / 2 - panX) / zoom - w / 2; const cy = (window.innerHeight / 2 - panY) / zoom - h / 2;
  beginHistory(); bboxExpand(cx, cy, 2); bboxExpand(cx + w, cy + h, 2); ctx.drawImage(clipCanvas, cx, cy); commitHistory();
  selection = { x: cx, y: cy, w, h }; selectionDirty = true; scheduleOverlay();
  sendDraw({ type: 'pasteImage', x: cx, y: cy, w, h, src: clipCanvas.toDataURL('image/png') });
}
document.addEventListener('paste', async (e) => {
  if (!roomId) return; const items = e.clipboardData && e.clipboardData.items; if (!items) return;
  for (const it of items) {
    if (it.type && it.type.startsWith('image/')) {
      e.preventDefault(); const file = it.getAsFile(); if (!file) continue; const url = URL.createObjectURL(file);
      try {
        const img = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = url; });
        let w = img.width, h = img.height; const k = Math.min(1, 1600 / Math.max(w, h)); w = Math.max(1, Math.round(w * k)); h = Math.max(1, Math.round(h * k));
        const clip = document.createElement('canvas'); clip.width = w; clip.height = h; clip.getContext('2d').drawImage(img, 0, 0, w, h); clipCanvas = clip;
        const cx = (window.innerWidth / 2 - panX) / zoom - w / 2; const cy = (window.innerHeight / 2 - panY) / zoom - h / 2;
        beginHistory(); bboxExpand(cx, cy, 2); bboxExpand(cx + w, cy + h, 2); ctx.drawImage(clip, cx, cy); commitHistory();
        selection = { x: cx, y: cy, w, h }; selectionDirty = true; scheduleOverlay();
        sendDraw({ type: 'pasteImage', x: cx, y: cy, w, h, src: clip.toDataURL('image/jpeg', 0.85) });
      } catch (err) {} finally { URL.revokeObjectURL(url); }
      return;
    }
  }
});

// ============================================================
// 12. Ввод
// ============================================================
board.addEventListener('pointerdown', (e) => {
  if (activePointerId !== null && activePointerId !== e.pointerId) return; activePointerId = e.pointerId;
  if (e.button === 2) return;
  if (e.button === 1 || (e.button === 0 && (tool === 'move' || spaceDown))) { isPanning = true; panStart = { x: e.clientX - panX, y: e.clientY - panY }; board.classList.add('panning'); e.preventDefault(); return; }
  if (e.button !== 0) return;
  const pt = getBoardPoint(e);
  if (selection && pointInRect(pt.x, pt.y, selection)) { startDragSelection(pt); return; }
  else if (selection && !pointInRect(pt.x, pt.y, selection)) { selection = null; selectionDirty = true; scheduleOverlay(); }
  
  switch (tool) {
    case 'pen': case 'eraser': startStroke(pt); break;
    case 'eraser-line': eraseLineAt(pt); break;
    case 'fill': pushFillHistory(pt); break;
    case 'picker': pickColor(pt); break;
    case 'line': case 'rect': case 'ellipse': shapeStart = pt; lastPoint = pt; isDrawing = true; break;
    case 'text': startTextInput(pt); break;
    case 'select': selection = { x: pt.x, y: pt.y, w: 0, h: 0 }; selectionDirty = true; scheduleOverlay(); isDrawing = true; break;
  }
});

window.addEventListener('pointermove', (e) => {
  if (e.pointerId !== activePointerId) return;
  const pt = getBoardPoint(e);
  statusCoords.textContent = `${Math.round(pt.x)}, ${Math.round(pt.y)} | ${Math.round(zoom * 100)}%`;
  if (socket && roomId) sendCursorThrottled(pt.x, pt.y);
  if (isPanning) { panX = e.clientX - panStart.x; panY = e.clientY - panStart.y; applyViewport(); return; }
  if (draggingSelection) { dragSelectionMove(pt); return; }
  if (!isDrawing) return;
  if (tool === 'pen' || tool === 'eraser') continueStroke(pt);
  else if (tool === 'line' || tool === 'rect' || tool === 'ellipse') previewShape(pt);
  else if (tool === 'select') {
    selection.w = pt.x - selection.x; selection.h = pt.y - selection.y;
    if (selection.w < 0) { selection.x += selection.w; selection.w = -selection.w; }
    if (selection.h < 0) { selection.y += selection.h; selection.h = -selection.h; }
    selectionDirty = true; scheduleOverlay();
  }
});

window.addEventListener('pointerup', (e) => {
  if (e.pointerId !== activePointerId) return; activePointerId = null;
  if (isPanning) { isPanning = false; panStart = null; board.classList.remove('panning'); return; }
  if (draggingSelection) { finishDragSelection(); return; }
  if (!isDrawing) return;
  if (tool === 'pen' || tool === 'eraser') finishStroke();
  else if (tool === 'line' || tool === 'rect' || tool === 'ellipse') finishShape();
  else if (tool === 'select') {
    if (!selection || Math.abs(selection.w) < 2 || Math.abs(selection.h) < 2) selection = null;
    else { selection = { x: Math.floor(selection.x), y: Math.floor(selection.y), w: Math.floor(selection.w), h: Math.floor(selection.h) }; }
    selectionDirty = true; scheduleOverlay(); isDrawing = false;
  }
});

window.addEventListener('pointercancel', (e) => {
  if (e.pointerId !== activePointerId) return; activePointerId = null;
  if (isPanning) { isPanning = false; panStart = null; board.classList.remove('panning'); }
  if (draggingSelection) { finishDragSelection(); return; }
  if (isDrawing) {
    if (tool === 'pen' || tool === 'eraser') finishStroke();
    else if (tool === 'line' || tool === 'rect' || tool === 'ellipse') finishShape();
  }
});

board.addEventListener('wheel', (e) => {
  e.preventDefault(); zoomAt(e.deltaY < 0 ? 1.1 : 1 / 1.1, e.clientX, e.clientY);
}, { passive: false });

// ============================================================
// 13. Кнопки и клавиатура
// ============================================================
$('btnPen').addEventListener('click', () => setActiveTool('pen'));
$('btnEraser').addEventListener('click', () => setActiveTool('eraser'));
$('btnEraserLine').addEventListener('click', () => setActiveTool('eraser-line'));
$('btnFill').addEventListener('click', () => setActiveTool('fill'));
$('btnPicker').addEventListener('click', () => setActiveTool('picker'));
$('btnLine').addEventListener('click', () => setActiveTool('line'));
$('btnRect').addEventListener('click', () => setActiveTool('rect'));
$('btnEllipse').addEventListener('click', () => setActiveTool('ellipse'));
$('btnText').addEventListener('click', () => setActiveTool('text'));
$('btnSelect').addEventListener('click', () => setActiveTool('select'));
$('btnMove').addEventListener('click', () => setActiveTool('move'));
$('btnPaste').addEventListener('click', () => pasteClipboard());
$('btnUndo').addEventListener('click', undo);
$('btnRedo').addEventListener('click', redo);
$('btnGrid').addEventListener('click', () => { gridOn = !gridOn; $('btnGrid').classList.toggle('active', gridOn); gridDirty = true; scheduleOverlay(); });
$('btnZoomIn').addEventListener('click', () => zoomAt(1.2, window.innerWidth / 2, window.innerHeight / 2));
$('btnZoomOut').addEventListener('click', () => zoomAt(1 / 1.2, window.innerWidth / 2, window.innerHeight / 2));
$('btnZoomReset').addEventListener('click', () => { zoom = 1; panX = 0; panY = 0; applyViewport(); gridDirty = true; selectionDirty = true; scheduleOverlay(); });
$('btnClear').addEventListener('click', () => {
  if (!confirm('Очистить всю доску?')) return;
  beginHistory(); bboxExpand(0, 0, 0); bboxExpand(board.width, board.height, 0); ctx.clearRect(0, 0, board.width, board.height); commitHistory(); sendDraw({ type: 'clear' });
  localEvents.length = 0;
});
$('btnDownload').addEventListener('click', () => { const link = document.createElement('a'); link.download = `coboard-${roomId || 'canvas'}.png`; link.href = board.toDataURL('image/png'); link.click(); });
$('btnLeave').addEventListener('click', () => { if (socket && roomId) socket.emit('leaveRoom'); setTimeout(() => location.reload(), 100); });
$('btnHelp').addEventListener('click', () => $('helpModal').classList.remove('hidden'));
$('helpClose').addEventListener('click', () => $('helpModal').classList.add('hidden'));

colorInput.addEventListener('input', () => color = colorInput.value);
sizeInput.addEventListener('input', () => size = Math.max(1, parseInt(sizeInput.value, 10) || 4));
opacityInput.addEventListener('input', () => opacity = Math.max(0.05, (parseInt(opacityInput.value, 10) || 100) / 100));

function isEditableFocused() { const el = document.activeElement; if (!el) return false; const t = el.tagName; return t === 'INPUT' || t === 'TEXTAREA' || t === 'SELECT' || el.isContentEditable; }
document.addEventListener('keydown', (e) => {
  const ctrl = e.ctrlKey || e.metaKey;
  if (ctrl && (e.key === 'z' || e.key === 'Z')) { if (!isEditableFocused()) { e.preventDefault(); if (e.shiftKey) redo(); else undo(); return; } }
  if (ctrl && (e.key === 'y' || e.key === 'Y')) { if (!isEditableFocused()) { e.preventDefault(); redo(); return; } }
  if (isEditableFocused()) return;
  if (e.key === ' ') { spaceDown = true; board.classList.add('pan'); e.preventDefault(); return; }
  if (!roomId) return;
  switch (e.key.toLowerCase()) {
    case 'b': setActiveTool('pen'); break; case 'e': setActiveTool('eraser'); break;
    case 'x': setActiveTool('eraser-line'); break; case 'f': setActiveTool('fill'); break;
    case 'p': setActiveTool('picker'); break; case 'l': setActiveTool('line'); break;
    case 'r': setActiveTool('rect'); break; case 'o': setActiveTool('ellipse'); break;
    case 't': setActiveTool('text'); break; case 's': setActiveTool('select'); break;
    case 'g': gridOn = !gridOn; $('btnGrid').classList.toggle('active', gridOn); gridDirty = true; scheduleOverlay(); break;
    case 'escape': selection = null; clipCanvas = null; selectionDirty = true; scheduleOverlay(); break;
    case 'delete': deleteSelection(); break;
  }
  if (ctrl && e.key === '0') { e.preventDefault(); zoom = 1; panX = 0; panY = 0; applyViewport(); }
  if (ctrl && (e.key === '+' || e.key === '=')) { e.preventDefault(); zoomAt(1.2, window.innerWidth / 2, window.innerHeight / 2); }
  if (ctrl && e.key === '-') { e.preventDefault(); zoomAt(1 / 1.2, window.innerWidth / 2, window.innerHeight / 2); }
});
document.addEventListener('keyup', (e) => { if (e.key === ' ') { spaceDown = false; board.classList.remove('pan'); } });

// Контекстное меню
const contextMenu = $('contextMenu');
board.addEventListener('contextmenu', (e) => {
  if (!selection) return;
  const pt = getBoardPoint(e);
  if (pointInRect(pt.x, pt.y, selection)) {
    e.preventDefault(); contextMenu.style.left = e.clientX + 'px'; contextMenu.style.top = e.clientY + 'px'; contextMenu.classList.remove('hidden');
  } else { contextMenu.classList.add('hidden'); selection = null; selectionDirty = true; scheduleOverlay(); }
});
document.addEventListener('click', (e) => { if (!contextMenu.classList.contains('hidden') && !contextMenu.contains(e.target)) contextMenu.classList.add('hidden'); });
$('ctxCut').addEventListener('click', () => { cutSelection(); contextMenu.classList.add('hidden'); });
$('ctxPaste').addEventListener('click', () => { pasteClipboard(); contextMenu.classList.add('hidden'); });
$('ctxDelete').addEventListener('click', () => { deleteSelection(); contextMenu.classList.add('hidden'); });

// ============================================================
// 14. Лобби
// ============================================================
$('tabCreate').addEventListener('click', () => { $('tabCreate').classList.add('active'); $('tabJoin').classList.remove('active'); $('paneCreate').classList.remove('hidden'); $('paneJoin').classList.add('hidden'); });
$('tabJoin').addEventListener('click', () => { $('tabJoin').classList.add('active'); $('tabCreate').classList.remove('active'); $('paneJoin').classList.remove('hidden'); $('paneCreate').classList.add('hidden'); });

$('btnCreate').addEventListener('click', () => {
  $('createError').textContent = ''; connect();
  const payload = { roomId: $('createRoomId').value.trim(), password: $('createPassword').value, maxUsers: parseInt($('createMaxUsers').value, 10) || 2 };
  socket.emit('createRoom', payload, (res) => {
    if (!res || !res.ok) { $('createError').textContent = (res && res.error) || 'Ошибка'; return; }
    $('joinRoomId').value = res.roomId; $('joinPassword').value = payload.password;
    $('tabJoin').click(); $('joinError').textContent = 'Комната создана. Нажмите «Войти».'; $('joinError').style.color = '#16a34a';
  });
});

$('btnJoin').addEventListener('click', () => {
  $('joinError').textContent = ''; $('joinError').style.color = '#dc2626'; connect();
  const payload = { roomId: $('joinRoomId').value.trim(), password: $('joinPassword').value };
  if (!payload.roomId) { $('joinError').textContent = 'Введите ID комнаты'; return; }
  socket.emit('joinRoom', payload, (res) => {
    if (!res || !res.ok) { $('joinError').textContent = (res && res.error) || 'Ошибка'; return; }
    enterRoom(res.roomId, res.authorId, res.maxUsers, res.events || []);
  });
});

async function enterRoom(rId, aId, mUsers, events) {
  roomId = rId; authorId = aId; maxUsers = mUsers;
  isDrawing = false; isPanning = false; panStart = null; draggingSelection = false;
  dragBaseImage = null; dragCurrentRect = null; dragOldRect = null;
  selection = null; clipCanvas = null; strokePoints = []; shapeStart = null; lastPoint = null; textInputActive = false;
  localEvents = [];

  lobbyEl.classList.add('hidden'); editorEl.classList.remove('hidden');
  ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, board.width, board.height);

  history.length = 0; historyIndex = -1; pendingBBox = null;
  lastSeq = 0; pendingEvents.clear(); applyQueue = Promise.resolve(); imageCache.clear();

  board.style.pointerEvents = 'none';
  try {
    for (const ev of events) {
      if (typeof ev.seq !== 'number') continue;
      if (ev.authorId === authorId) { lastSeq = Math.max(lastSeq, ev.seq); continue; }
      await applyEventSerialized(ev); lastSeq = Math.max(lastSeq, ev.seq);
      if (['stroke','line','rect','ellipse'].includes(ev.type)) localEvents.push(ev);
    }
  } catch (e) {} finally {
    board.style.pointerEvents = '';
    isDrawing = false;
  }

  applyViewport(); updateStatus(); gridDirty = true; selectionDirty = true; scheduleOverlay();
  setActiveTool('pen');
}

})();