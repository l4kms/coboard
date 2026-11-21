'use strict';

const path = require('path');
const http = require('http');
const express = require('express');
const { Server } = require('socket.io');
const { createClient } = require('@supabase/supabase-js');

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseSecret = process.env.SUPABASE_SECRET;
if (!supabaseUrl || !supabaseSecret) { console.error('Нет ключей Supabase'); process.exit(1); }
const supabase = createClient(supabaseUrl, supabaseSecret);

const PORT = process.env.PORT || 3000;
const MAX_USERS_PER_ROOM = 4;
const MAX_ROOMS = 500;

const rooms = new Map();

async function loadRoomsFromDB() {
    try {
        const { data, error } = await supabase.from('coboard_rooms').select('*');
        if (error) throw error;
        for (const row of data) {
            rooms.set(row.id, {
                password: row.password || '',
                maxUsers: row.max_users || 2,
                events: row.events || [], // Оставляем для совместимости
                image: row.image || null, // <--- НОВОЕ ПОЛЕ
                users: new Set(),
                seq: row.seq || 0,
                bytes: row.bytes || 0,
                lastActivity: row.last_activity || Date.now()
            });
        }
        console.log(`Загружено ${rooms.size} комнат`);
    } catch (e) { console.error('Ошибка загрузки:', e.message); }
}
loadRoomsFromDB();

async function saveRoomToDB(roomId) {
    const room = rooms.get(roomId);
    if (!room) return;
    try {
        const { error } = await supabase.from('coboard_rooms').upsert({
            id: roomId,
            password: room.password,
            max_users: room.maxUsers,
            events: room.events,
            image: room.image, // <--- СОХРАНЯЕМ КАРТИНКУ
            seq: room.seq,
            bytes: room.bytes,
            last_activity: room.lastActivity
        });
        if (error) console.error('Ошибка сохранения:', error.message);
    } catch (e) { console.error('Ошибка записи:', e.message); }
}

// === Express ===
const app = express();
app.disable('x-powered-by');
app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'SAMEORIGIN');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self' ws: wss: data:; font-src 'self'; worker-src 'self' blob:; object-src 'none'; base-uri 'self'; frame-ancestors 'self'");
    next();
});
app.use(express.static(path.join(__dirname, 'public')));

const server = http.createServer(app);
const io = new Server(server, { maxHttpBufferSize: 5e6, cors: { origin: "*" } });

const ID_RE = /^[A-Za-z0-9_-]{1,40}$/;
const PW_RE = /^[\x20-\x7E]{0,64}$/;
const isNum = (n) => typeof n === 'number' && Number.isFinite(n);

function validateEvent(ev) {
    if (!ev || typeof ev !== 'object') return false;
    if (typeof ev.type !== 'string') return false;
    // Разрешаем все нужные типы
    if (!['stroke','fill','line','rect','ellipse','text','pasteImage','moveSelection','cutSelection','deleteSelection','clearArea','clear'].includes(ev.type)) return false;
    return true;
}

function makeRoomId() { let id; do { id = Math.random().toString(36).slice(2, 8); } while (rooms.has(id)); return id; }

io.on('connection', (socket) => {
    socket.roomId = null; socket.authorId = null;

    socket.on('createRoom', (payload, ack) => {
        try {
            const rawId = payload && payload.roomId;
            let roomId = rawId == null || rawId === '' ? makeRoomId() : String(rawId);
            if (!ID_RE.test(roomId)) return ack({ ok: false, error: 'Неверный ID' });
            if (rooms.has(roomId)) return ack({ ok: false, error: 'Уже есть' });
            const password = payload && payload.password ? String(payload.password) : '';
            if (!PW_RE.test(password)) return ack({ ok: false, error: 'Неверный пароль' });
            const maxUsers = Math.max(2, Math.min(MAX_USERS_PER_ROOM, Number(payload.maxUsers) || 2));
            
            rooms.set(roomId, { password, maxUsers, events: [], image: null, users: new Set(), seq: 0, bytes: 0, lastActivity: Date.now() });
            saveRoomToDB(roomId);
            ack({ ok: true, roomId });
        } catch (e) { ack({ ok: false, error: 'Ошибка' }); }
    });

    socket.on('joinRoom', (payload, ack) => {
        try {
            const roomId = String(payload.roomId || '');
            const password = String(payload.password || '');
            const room = rooms.get(roomId);
            if (!room) return ack({ ok: false, error: 'Не найдена' });
            if (room.password !== password) return ack({ ok: false, error: 'Неверный пароль' });
            if (room.users.size >= room.maxUsers) return ack({ ok: false, error: 'Заполнена' });

            const authorId = 'u' + Math.random().toString(36).slice(2, 10);
            socket.join(roomId); socket.roomId = roomId; socket.authorId = authorId;
            room.users.add(socket.id); room.lastActivity = Date.now();

            ack({ ok: true, roomId, authorId, maxUsers: room.maxUsers, events: room.events, image: room.image, seq: room.seq });
            socket.to(roomId).emit('userJoined', { authorId });
        } catch (e) { ack({ ok: false, error: 'Ошибка' }); }
    });

    socket.on('draw', (ev, ack) => {
        if (!socket.roomId || !socket.authorId) { if (ack) ack({ ok: false }); return; }
        const room = rooms.get(socket.roomId);
        if (!room || !validateEvent(ev)) { if (ack) ack({ ok: false }); return; }

        // Если это событие 'clear' — сбрасываем картинку
        if (ev.type === 'clear') room.image = null;
        // Если это картинка (рисование) — мы просто сохраняем её как новую версию
        if (ev.image) room.image = ev.image;

        const safe = { ...ev, authorId: socket.authorId, seq: ++room.seq };
        room.events.push(safe);
        room.lastActivity = Date.now();

        socket.to(socket.roomId).emit('draw', safe);
        if (ack) ack({ ok: true, seq: safe.seq });
        saveRoomToDB(socket.roomId);
    });

    // === НОВОЕ СОБЫТИЕ: синхронизация изображения ===
    socket.on('syncImage', (imageDataUrl) => {
        if (!socket.roomId) return;
        const room = rooms.get(socket.roomId);
        if (!room) return;
        room.image = imageDataUrl;
        saveRoomToDB(socket.roomId);
        // Рассылаем другим (они просто обновят холст)
        socket.to(socket.roomId).emit('imageSynced', imageDataUrl);
    });

    socket.on('cursor', (pos) => { if (socket.roomId && pos && isNum(pos.x)) socket.to(socket.roomId).emit('cursor', { authorId: socket.authorId, x: pos.x, y: pos.y }); });
    socket.on('requestSync', () => { if (socket.roomId) { const room = rooms.get(socket.roomId); if (room) socket.emit('fullSync', { events: room.events, image: room.image, seq: room.seq }); } });
    socket.on('leaveRoom', () => { if (socket.roomId) { const room = rooms.get(socket.roomId); if (room) room.users.delete(socket.id); socket.to(socket.roomId).emit('userLeft', { authorId: socket.authorId }); socket.leave(socket.roomId); socket.roomId = null; } });
    socket.on('disconnect', () => { if (socket.roomId) { const room = rooms.get(socket.roomId); if (room) room.users.delete(socket.id); socket.to(socket.roomId).emit('userLeft', { authorId: socket.authorId }); saveRoomToDB(socket.roomId); } });
});

server.listen(PORT, () => console.log(`CoBoard on ${PORT}`));