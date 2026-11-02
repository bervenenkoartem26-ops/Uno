'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');
const Rules = require('./public/js/rules');

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');
const CODE_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // без похожих символов (I, L, O, 0, 1)
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
};

/** code -> { code, hostId, players: [{ id, name, ws }], state } */
const rooms = new Map();

// ---------- Статика ----------
const server = http.createServer((req, res) => {
  let pathname;
  try {
    pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  } catch {
    res.writeHead(400);
    return res.end('Bad request');
  }
  const filePath = path.normalize(path.join(PUBLIC_DIR, pathname === '/' ? 'index.html' : pathname));
  if (!filePath.startsWith(PUBLIC_DIR + path.sep)) {
    res.writeHead(403);
    return res.end('Forbidden');
  }
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('Не найдено');
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream' });
    res.end(data);
  });
});

// ---------- WebSocket ----------
const wss = new WebSocketServer({ server });

wss.on('connection', (ws) => {
  ws.id = crypto.randomUUID();
  ws.roomCode = null;

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return sendError(ws, 'Некорректное сообщение');
    }
    if (!msg || typeof msg !== 'object') return sendError(ws, 'Некорректное сообщение');
    handleMessage(ws, msg);
  });

  ws.on('close', () => leaveRoom(ws));
});

function handleMessage(ws, msg) {
  switch (msg.type) {
    case 'create': return createRoom(ws, msg.name);
    case 'join': return joinRoom(ws, msg.code, msg.name);
    case 'leave': return leaveRoom(ws);
    case 'start': return startGame(ws);
    case 'restart': return restartGame(ws);
    case 'play': return playCard(ws, msg);
    case 'draw': return drawCard(ws);
    default: return sendError(ws, 'Неизвестная команда');
  }
}

// ---------- Комнаты ----------
function newCode() {
  let code;
  do {
    code = Array.from({ length: 4 }, () => CODE_CHARS[crypto.randomInt(CODE_CHARS.length)]).join('');
  } while (rooms.has(code));
  return code;
}

function cleanName(name) {
  return String(name ?? '').trim().slice(0, 16);
}

function currentRoom(ws) {
  return ws.roomCode ? rooms.get(ws.roomCode) : undefined;
}

function createRoom(ws, rawName) {
  const name = cleanName(rawName);
  if (!name) return sendError(ws, 'Введите имя');
  leaveRoom(ws);
  const code = newCode();
  const room = { code, hostId: ws.id, players: [{ id: ws.id, name, ws }], state: null };
  rooms.set(code, room);
  ws.roomCode = code;
  broadcastRoom(room);
}

function joinRoom(ws, rawCode, rawName) {
  const name = cleanName(rawName);
  if (!name) return sendError(ws, 'Введите имя');
  const code = String(rawCode ?? '').trim().toUpperCase();
  const room = rooms.get(code);
  if (!room) return sendError(ws, 'Комната с таким кодом не найдена');
  if (ws.roomCode === code) return;
  if (room.state) return sendError(ws, 'Игра в этой комнате уже началась');
  if (room.players.length >= Rules.MAX_PLAYERS) return sendError(ws, 'В комнате уже нет мест');
  leaveRoom(ws);
  room.players.push({ id: ws.id, name, ws });
  ws.roomCode = code;
  broadcastRoom(room);
}

function startGame(ws) {
  const room = currentRoom(ws);
  if (!room) return sendError(ws, 'Вы не в комнате');
  if (room.hostId !== ws.id) return sendError(ws, 'Игру начинает создатель комнаты');
  if (room.state) return;
  if (room.players.length < Rules.MIN_PLAYERS) return sendError(ws, 'Нужно минимум два игрока');
  room.state = Rules.createGame(room.players.map((p) => p.name));
  broadcastState(room);
}

function restartGame(ws) {
  const room = currentRoom(ws);
  if (!room || room.hostId !== ws.id) return sendError(ws, 'Только создатель комнаты может начать новую игру');
  if (!room.state || room.state.winner === null) return;
  room.state = null;
  broadcastRoom(room);
}

function playCard(ws, msg) {
  const room = currentRoom(ws);
  if (!room || !room.state) return sendError(ws, 'Игра ещё не началась');
  const index = room.players.findIndex((p) => p.id === ws.id);
  const result = Rules.playCard(room.state, index, msg.cardId, msg.color);
  if (!result.ok) return sendError(ws, result.error);
  broadcastState(room);
}

function drawCard(ws) {
  const room = currentRoom(ws);
  if (!room || !room.state) return sendError(ws, 'Игра ещё не началась');
  const index = room.players.findIndex((p) => p.id === ws.id);
  const result = Rules.drawCard(room.state, index);
  if (!result.ok) return sendError(ws, result.error);
  broadcastState(room);
}

function leaveRoom(ws) {
  const room = currentRoom(ws);
  ws.roomCode = null;
  if (!room) return;
  const index = room.players.findIndex((p) => p.id === ws.id);
  if (index < 0) return;

  // Если партия уже закончилась, состояние больше не нужно.
  if (room.state && room.state.winner !== null) room.state = null;

  const [leaver] = room.players.splice(index, 1);

  if (room.players.length === 0) {
    rooms.delete(room.code);
    return;
  }

  // Игрок ушёл во время партии: партия не может продолжаться, комната закрывается.
  if (room.state) {
    room.players.forEach((p) => {
      p.ws.roomCode = null;
      send(p.ws, { type: 'closed', message: `${leaver.name} покинул(а) игру. Комната закрыта.` });
    });
    rooms.delete(room.code);
    return;
  }

  if (room.hostId === leaver.id) room.hostId = room.players[0].id;
  broadcastRoom(room);
}

// ---------- Отправка ----------
function send(ws, msg) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
}

function sendError(ws, message) {
  send(ws, { type: 'error', message });
}

function broadcastRoom(room) {
  const names = room.players.map((p) => p.name);
  const hostIndex = room.players.findIndex((p) => p.id === room.hostId);
  room.players.forEach((p, i) => {
    send(p.ws, {
      type: 'room',
      code: room.code,
      players: names,
      hostIndex,
      myIndex: i,
      isHost: p.id === room.hostId,
    });
  });
}

function broadcastState(room) {
  room.players.forEach((p, i) => {
    send(p.ws, { type: 'state', view: Rules.viewFor(room.state, i) });
  });
}

server.listen(PORT, () => {
  console.log(`UNO запущен: http://localhost:${PORT}`);
});
