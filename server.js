'use strict';

const path = require('path');
const fs = require('fs');
const http = require('http');
const express = require('express');
const { Server } = require('socket.io');

const PORT = process.env.PORT || 3000;
const DATA_DIR = path.join(__dirname, 'data');
const ROOMS_FILE = path.join(DATA_DIR, 'rooms.json');

const MAX_EVENTS_PER_ROOM = 20000;
const MAX_ROOM_BYTES = 50 * 1024 * 1024;
const MAX_USERS_PER_ROOM = 4;
const MAX_ROOMS = 500;
const ROOM_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 дней
const SAVE_DEBOUNCE_MS = 3000;

// ====== Загрузка комнат с диска при старте ======
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const rooms = new Map();

function loadRoomsFromDisk() {
  try {
    if (!fs.existsSync(ROOMS_FILE)) return;
    const raw = fs.readFileSync(ROOMS_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    for (const [id, room] of Object.entries(parsed)) {
      rooms.set(id, {
        password: room.password || '',
        maxUsers: room.maxUsers || 2,
        events: room.events || [],
        users: new Set(),
        seq: room.seq || 0,
        bytes: room.bytes || 0,
        lastActivity: room.lastActivity || Date.now()
      });
    }
    console.log(`Loaded ${rooms.size} rooms from disk`);
  } catch (e) {
    console.error('Failed to load rooms:', e.message);
  }
}
loadRoomsFromDisk();

let saveTimer = null;
function scheduleDiskSave() {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(saveRoomsToDisk, SAVE_DEBOUNCE_MS);
}
function saveRoomsToDisk() {
  try {
    const obj = {};
    for (const [id, room] of rooms) {
      obj[id] = {
        password: room.password,
        maxUsers: room.maxUsers,
        events: room.events,
        seq: room.seq,
        bytes: room.bytes,
        lastActivity: room.lastActivity
      };
    }
    fs.writeFileSync(ROOMS_FILE, JSON.stringify(obj));
  } catch (e) {
    console.error('Failed to save rooms:', e.message);
  }
}

// ====== Express ======
const app = express();
app.disable('x-powered-by');

app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  res.setHeader(
    'Content-Security-Policy',
    [
      "default-src 'self'",
      "script-src 'self'",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: blob:",
      "connect-src 'self' ws: wss: data:",
      "font-src 'self'",
      "worker-src 'self' blob:",
      "object-src 'none'",
      "base-uri 'self'",
      "frame-ancestors 'self'"
    ].join('; ')
  );
  next();
});

app.use(express.static(path.join(__dirname, 'public'), {
  setHeaders: (res, p) => {
    if (/\.(js|css|html)$/.test(p)) res.setHeader('Cache-Control', 'no-cache');
  }
}));

const server = http.createServer(app);
const io = new Server(server, {
  maxHttpBufferSize: 5e6,
  pingInterval: 20000,
  pingTimeout: 25000,
  // Добавь эту строку:
  cors: { origin: "*" } // Для теста. Позже можно заменить "*" на твой домен Render
});

// ====== Валидация ======
const ID_RE = /^[A-Za-z0-9_-]{1,40}$/;
const PW_RE = /^[\x20-\x7E]{0,64}$/;
const isNum = (n) => typeof n === 'number' && Number.isFinite(n);
const clampN = (n, a, b) => Math.max(a, Math.min(b, n));

function validateEvent(ev) {
  if (!ev || typeof ev !== 'object') return false;
  const t = ev.type;
  if (typeof t !== 'string') return false;

  switch (t) {
    case 'stroke': {
      if (!Array.isArray(ev.points) || ev.points.length === 0 || ev.points.length > 8000) return false;
      for (const p of ev.points) {
        if (!Array.isArray(p) || p.length !== 2) return false;
        if (!isNum(p[0]) || !isNum(p[1])) return false;
        if (Math.abs(p[0]) > 1e6 || Math.abs(p[1]) > 1e6) return false;
      }
      if (!isNum(ev.size) || ev.size < 1 || ev.size > 200) return false;
      if (typeof ev.color !== 'string' || ev.color.length > 32) return false;
      if (typeof ev.erase !== 'boolean') return false;
      if (!isNum(ev.opacity) || ev.opacity < 0 || ev.opacity > 1) return false;
      return true;
    }
    case 'fill': {
      if (!isNum(ev.x) || !isNum(ev.y)) return false;
      if (!isNum(ev.w) || ev.w <= 0 || ev.w > 4000) return false;
      if (!isNum(ev.h) || ev.h <= 0 || ev.h > 4000) return false;
      if (typeof ev.color !== 'string' || ev.color.length > 32) return false;
      if (!isNum(ev.opacity) || ev.opacity < 0 || ev.opacity > 1) return false;
      if (typeof ev.src !== 'string' || ev.src.length > 4_800_000) return false;
      if (!ev.src.startsWith('data:image/')) return false;
      return true;
    }
    case 'line': case 'rect': case 'ellipse': {
      if (!isNum(ev.x1) || !isNum(ev.y1) || !isNum(ev.x2) || !isNum(ev.y2)) return false;
      if (!isNum(ev.size) || ev.size < 1 || ev.size > 200) return false;
      if (typeof ev.color !== 'string' || ev.color.length > 32) return false;
      if (typeof ev.filled !== 'boolean') return false;
      return true;
    }
    case 'text': {
      if (!isNum(ev.x) || !isNum(ev.y)) return false;
      if (!isNum(ev.size) || ev.size < 6 || ev.size > 400) return false;
      if (typeof ev.color !== 'string' || ev.color.length > 32) return false;
      if (typeof ev.text !== 'string' || ev.text.length === 0 || ev.text.length > 2000) return false;
      return true;
    }
    case 'pasteImage': case 'moveSelection': case 'cutSelection': {
      if (!isNum(ev.x) || !isNum(ev.y)) return false;
      if (!isNum(ev.w) || ev.w <= 0 || ev.w > 4000) return false;
      if (!isNum(ev.h) || ev.h <= 0 || ev.h > 4000) return false;
      if (typeof ev.src !== 'string' || ev.src.length > 4_800_000) return false;
      if (!ev.src.startsWith('data:image/')) return false;
      if (t === 'moveSelection' && (!isNum(ev.fromX) || !isNum(ev.fromY))) return false;
      return true;
    }
    case 'deleteSelection': {
      if (!isNum(ev.x) || !isNum(ev.y)) return false;
      if (!isNum(ev.w) || ev.w <= 0 || ev.w > 4000) return false;
      if (!isNum(ev.h) || ev.h <= 0 || ev.h > 4000) return false;
      return true;
    }
    case 'clear': return true;
    default: return false;
  }
}

function makeRoomId() {
  let id;
  do { id = Math.random().toString(36).slice(2, 8); } while (rooms.has(id));
  return id;
}

// ====== Очистка старых комнат ======
setInterval(() => {
  const now = Date.now();
  let removed = 0;
  for (const [id, room] of rooms) {
    if (room.users.size === 0 && now - room.lastActivity > ROOM_TTL_MS) {
      rooms.delete(id);
      removed++;
    }
  }
  if (removed > 0) {
    console.log(`Cleaned ${removed} old rooms`);
    scheduleDiskSave();
  }
}, 60 * 60 * 1000);

// ====== Socket.IO ======
io.on('connection', (socket) => {
  socket.roomId = null;
  socket.authorId = null;

  socket.on('createRoom', (payload, ack) => {
    try {
      if (typeof ack !== 'function') return;
      if (rooms.size >= MAX_ROOMS) return ack({ ok: false, error: 'Сервер перегружен' });

      const rawId = payload && payload.roomId;
      const rawPw = payload && payload.password;
      const rawMax = payload && payload.maxUsers;

      let roomId = rawId == null || rawId === '' ? makeRoomId() : String(rawId);
      if (!ID_RE.test(roomId)) return ack({ ok: false, error: 'Неверный ID комнаты' });
      if (rooms.has(roomId)) return ack({ ok: false, error: 'Комната уже существует' });

      const password = rawPw == null ? '' : String(rawPw);
      if (!PW_RE.test(password)) return ack({ ok: false, error: 'Неверный пароль' });

      const maxUsers = Math.max(2, Math.min(MAX_USERS_PER_ROOM, Number(rawMax) || 2));

      rooms.set(roomId, {
        password, maxUsers, events: [], users: new Set(),
        seq: 0, bytes: 0, lastActivity: Date.now()
      });
      scheduleDiskSave();
      ack({ ok: true, roomId });
    } catch (e) {
      if (typeof ack === 'function') ack({ ok: false, error: 'Внутренняя ошибка' });
    }
  });

  socket.on('joinRoom', (payload, ack) => {
    try {
      if (typeof ack !== 'function') return;
      const roomId = String((payload && payload.roomId) || '');
      const password = String((payload && payload.password) || '');
      if (!ID_RE.test(roomId)) return ack({ ok: false, error: 'Неверный ID комнаты' });

      const room = rooms.get(roomId);
      if (!room) return ack({ ok: false, error: 'Комната не найдена' });
      if (room.password !== password) return ack({ ok: false, error: 'Неверный пароль' });
      if (room.users.size >= room.maxUsers) return ack({ ok: false, error: 'Комната заполнена' });

      const authorId = 'u' + Math.random().toString(36).slice(2, 10);

      socket.join(roomId);
      socket.roomId = roomId;
      socket.authorId = authorId;
      room.users.add(socket.id);
      room.lastActivity = Date.now();

      ack({
        ok: true, roomId, authorId,
        maxUsers: room.maxUsers,
        events: room.events,
        seq: room.seq
      });

      socket.to(roomId).emit('userJoined', { authorId });
    } catch (e) {
      if (typeof ack === 'function') ack({ ok: false, error: 'Внутренняя ошибка' });
    }
  });

  socket.on('draw', (ev, ack) => {
    if (!socket.roomId || !socket.authorId) {
      if (typeof ack === 'function') ack({ ok: false });
      return;
    }
    const room = rooms.get(socket.roomId);
    if (!room) {
      if (typeof ack === 'function') ack({ ok: false });
      return;
    }
    if (!validateEvent(ev)) {
      if (typeof ack === 'function') ack({ ok: false });
      return;
    }

    const safe = { ...ev, authorId: socket.authorId, seq: ++room.seq };
    const size = JSON.stringify(safe).length;
    room.events.push(safe);
    room.bytes += size;
    room.lastActivity = Date.now();

    while ((room.events.length > MAX_EVENTS_PER_ROOM || room.bytes > MAX_ROOM_BYTES) && room.events.length > 0) {
      const removed = room.events.shift();
      room.bytes -= JSON.stringify(removed).length;
    }

    socket.to(socket.roomId).emit('draw', safe);
    if (typeof ack === 'function') ack({ ok: true, seq: safe.seq });
    scheduleDiskSave();
  });

  socket.on('cursor', (pos) => {
    if (!socket.roomId || !socket.authorId) return;
    if (!pos || !isNum(pos.x) || !isNum(pos.y)) return;
    socket.to(socket.roomId).emit('cursor', {
      authorId: socket.authorId,
      x: clampN(pos.x, -1e6, 1e6),
      y: clampN(pos.y, -1e6, 1e6),
      zoom: isNum(pos.zoom) ? clampN(pos.zoom, 0.1, 8) : 1
    });
  });

  socket.on('requestSync', () => {
    if (!socket.roomId) return;
    const room = rooms.get(socket.roomId);
    if (!room) return;
    socket.emit('fullSync', { events: room.events, seq: room.seq });
  });

  socket.on('leaveRoom', () => {
    if (!socket.roomId) return;
    const room = rooms.get(socket.roomId);
    if (room) room.users.delete(socket.id);
    socket.to(socket.roomId).emit('userLeft', { authorId: socket.authorId });
    socket.leave(socket.roomId);
    socket.roomId = null;
    socket.authorId = null;
  });

  socket.on('disconnect', () => {
    if (!socket.roomId) return;
    const room = rooms.get(socket.roomId);
    if (!room) return;
    room.users.delete(socket.id);
    socket.to(socket.roomId).emit('userLeft', { authorId: socket.authorId });
    room.lastActivity = Date.now();
    scheduleDiskSave();
  });
});

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('\nSaving rooms before shutdown...');
  saveRoomsToDisk();
  process.exit(0);
});
process.on('SIGTERM', () => {
  saveRoomsToDisk();
  process.exit(0);
});

server.listen(PORT, () => {
  console.log(`CoBoard running on http://localhost:${PORT}`);
});