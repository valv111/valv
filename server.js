const express = require('express');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const QRCode = require('qrcode');
const { WebSocketServer } = require('ws');

const PORT = Number(process.env.PORT) || 3456;
const HOST = process.env.HOST || '0.0.0.0';
const ROOM_START = Number(process.env.ROOM_START) || 1;
const MAX_TEXT_BYTES = Number(process.env.MAX_TEXT_BYTES) || 512 * 1024;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '.data');
const DATA_FILE = path.join(DATA_DIR, 'rooms.json');
const STATE_FILE = path.join(DATA_DIR, 'state.json');
const ROOM_TTL_MS = 7 * 24 * 60 * 60 * 1000;

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server, maxPayload: MAX_TEXT_BYTES + 4096 });

/** @type {Map<string, { text: string, pin: string, updatedAt: number, history: Array<{ text: string, at: number }> }>} */
const rooms = new Map();

/** @type {Map<WebSocket, { room: string, clientId: string, alive: boolean }>} */
const clients = new Map();

let saveTimer = null;
let nextRoomId = ROOM_START;

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
}

function loadState() {
  ensureDataDir();
  if (fs.existsSync(STATE_FILE)) {
    try {
      const state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
      if (Number.isFinite(state.nextRoomId)) {
        nextRoomId = state.nextRoomId;
      }
    } catch {
      // ignore
    }
  }

  for (const id of rooms.keys()) {
    if (/^\d+$/.test(id)) {
      nextRoomId = Math.max(nextRoomId, parseInt(id, 10) + 1);
    }
  }
}

function saveState() {
  ensureDataDir();
  fs.writeFileSync(STATE_FILE, JSON.stringify({ nextRoomId }));
}

function loadRooms() {
  ensureDataDir();
  if (!fs.existsSync(DATA_FILE)) return;
  try {
    const raw = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    const now = Date.now();
    for (const [id, data] of Object.entries(raw)) {
      if (now - (data.updatedAt || 0) > ROOM_TTL_MS) continue;
      rooms.set(id, {
        text: String(data.text || ''),
        pin: String(data.pin || ''),
        updatedAt: data.updatedAt || now,
        history: Array.isArray(data.history) ? data.history.slice(0, 20) : [],
      });
    }
  } catch {
    // ignore corrupt cache
  }
}

function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    ensureDataDir();
    const payload = Object.fromEntries(rooms.entries());
    fs.writeFile(DATA_FILE, JSON.stringify(payload), () => {});
  }, 800);
}

function getLocalIPs() {
  const ips = [];
  const nets = os.networkInterfaces();
  for (const iface of Object.values(nets)) {
    for (const net of iface || []) {
      if (net.family === 'IPv4' && !net.internal) {
        ips.push(net.address);
      }
    }
  }
  return ips.length ? ips : ['127.0.0.1'];
}

function getPrimaryIP() {
  return getLocalIPs()[0];
}

function sanitizeRoom(room) {
  const raw = String(room || '').trim();
  if (/^\d+$/.test(raw)) {
    return raw.slice(0, 8);
  }
  return raw.replace(/[^\w\u4e00-\u9fff-]/g, '').slice(0, 32);
}

function getRoom(room) {
  const id = sanitizeRoom(room);
  if (!id) {
    return { id: '', data: null };
  }
  if (!rooms.has(id)) {
    rooms.set(id, { text: '', pin: '', updatedAt: Date.now(), history: [] });
  }
  return { id, data: rooms.get(id) };
}

function allocRoomId() {
  let id = ROOM_START;
  while (rooms.has(String(id))) {
    id += 1;
  }
  nextRoomId = id + 1;
  saveState();
  return String(id);
}

function pushHistory(roomData, text) {
  if (!text.trim()) return;
  const last = roomData.history[0];
  if (last && last.text === text) return;
  roomData.history.unshift({ text, at: Date.now() });
  roomData.history = roomData.history.slice(0, 20);
}

function countPeers(roomId) {
  let n = 0;
  for (const [, meta] of clients) {
    if (meta.room === roomId) n += 1;
  }
  return n;
}

function broadcast(roomId, payload, except) {
  const msg = JSON.stringify(payload);
  for (const [ws, meta] of clients) {
    if (meta.room === roomId && ws !== except && ws.readyState === ws.OPEN) {
      ws.send(msg);
    }
  }
}

function broadcastPeers(roomId) {
  const peers = countPeers(roomId);
  broadcast(roomId, { type: 'peers', peers });
}

function normalizePin(pin) {
  return String(pin || '').trim();
}

function checkPin(data, pin) {
  if (!data.pin) return true;
  return normalizePin(pin) === normalizePin(data.pin);
}

function trimText(text) {
  const buf = Buffer.from(String(text ?? ''), 'utf8');
  if (buf.length <= MAX_TEXT_BYTES) return buf.toString('utf8');
  return buf.subarray(0, MAX_TEXT_BYTES).toString('utf8');
}

function listRooms() {
  const items = [];
  for (const [id, data] of rooms.entries()) {
    items.push({
      id,
      peers: countPeers(id),
      hasPin: Boolean(data.pin),
      updatedAt: data.updatedAt,
      hasContent: Boolean(data.text.trim()),
    });
  }
  items.sort((a, b) => {
    const an = /^\d+$/.test(a.id);
    const bn = /^\d+$/.test(b.id);
    if (an && bn) return parseInt(b.id, 10) - parseInt(a.id, 10);
    if (an) return -1;
    if (bn) return 1;
    return b.updatedAt - a.updatedAt;
  });
  return items;
}

loadRooms();
loadState();

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/info', (_req, res) => {
  const ips = getLocalIPs();
  res.json({
    port: PORT,
    ip: ips[0],
    ips,
    url: `http://${ips[0]}:${PORT}`,
    maxTextBytes: MAX_TEXT_BYTES,
    roomStart: ROOM_START,
    nextRoomId: nextRoomId,
  });
});

app.get('/api/rooms', (_req, res) => {
  res.json({ rooms: listRooms() });
});

app.post('/api/rooms/create', (_req, res) => {
  const id = allocRoomId();
  const data = { text: '', pin: '', updatedAt: Date.now(), history: [] };
  rooms.set(id, data);
  scheduleSave();
  res.json({ room: id });
});

app.get('/api/qr', async (req, res) => {
  const ip = getPrimaryIP();
  const room = sanitizeRoom(req.query.room);
  if (!room) {
    return res.status(400).json({ error: 'room_required' });
  }
  const pin = String(req.query.pin || '');
  const qs = new URLSearchParams({ room });
  if (pin) qs.set('pin', pin);
  const url = `http://${ip}:${PORT}/?${qs}`;
  try {
    const dataUrl = await QRCode.toDataURL(url, { margin: 2, width: 280 });
    res.json({ url, qr: dataUrl, ips: getLocalIPs() });
  } catch {
    res.status(500).json({ error: 'QR generation failed' });
  }
});

app.get('/api/room/:room/meta', (req, res) => {
  const { id, data } = getRoom(req.params.room);
  if (!id || !data) {
    return res.status(404).json({ error: 'room_not_found' });
  }
  res.json({ room: id, hasPin: Boolean(data.pin), peers: countPeers(id) });
});

app.get('/api/room/:room', (req, res) => {
  const { id, data } = getRoom(req.params.room);
  if (!id || !data) {
    return res.status(404).json({ error: 'room_not_found' });
  }
  if (!checkPin(data, req.query.pin)) {
    return res.status(403).json({ error: 'invalid_pin' });
  }
  res.json({
    room: id,
    text: data.text,
    updatedAt: data.updatedAt,
    history: data.history,
    hasPin: Boolean(data.pin),
    peers: countPeers(id),
  });
});

wss.on('connection', (ws) => {
  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }

    if (msg.type === 'join') {
      const { id, data } = getRoom(msg.room);
      if (!id || !data) {
        ws.send(JSON.stringify({ type: 'error', code: 'room_not_found' }));
        return;
      }

      const pin = String(msg.pin || '');

      if (!checkPin(data, pin)) {
        ws.send(JSON.stringify({ type: 'error', code: 'invalid_pin' }));
        return;
      }

      if (msg.setPin && !data.pin) {
        data.pin = normalizePin(msg.setPin).slice(0, 16);
        scheduleSave();
      }

      clients.set(ws, {
        room: id,
        clientId: String(msg.clientId || ''),
        alive: true,
      });

      ws.send(JSON.stringify({
        type: 'sync',
        text: data.text,
        updatedAt: data.updatedAt,
        history: data.history,
        room: id,
        hasPin: Boolean(data.pin),
        peers: countPeers(id),
      }));
      broadcastPeers(id);
      return;
    }

    const meta = clients.get(ws);
    if (!meta) return;

    if (msg.type === 'update') {
      const { data } = getRoom(meta.room);
      if (!data) return;
      const text = trimText(msg.text);
      if (text !== data.text) {
        pushHistory(data, data.text);
      }
      data.text = text;
      data.updatedAt = Date.now();
      scheduleSave();
      broadcast(meta.room, {
        type: 'sync',
        text: data.text,
        updatedAt: data.updatedAt,
        history: data.history,
        from: 'peer',
        clientId: meta.clientId,
      }, ws);
    }
  });

  ws.on('close', () => {
    const meta = clients.get(ws);
    clients.delete(ws);
    if (meta) broadcastPeers(meta.room);
  });

  ws.on('pong', () => {
    const meta = clients.get(ws);
    if (meta) meta.alive = true;
  });
});

setInterval(() => {
  for (const [ws, meta] of clients) {
    if (!meta.alive) {
      ws.terminate();
      continue;
    }
    meta.alive = false;
    ws.ping();
  }
}, 30000);

server.listen(PORT, HOST, () => {
  const ips = getLocalIPs();
  console.log('');
  console.log('  ClipBridge 已启动');
  console.log(`  房间编号从 ${ROOM_START} 起自动递增`);
  console.log(`  本机访问:  http://localhost:${PORT}`);
  for (const ip of ips) {
    console.log(`  局域网访问: http://${ip}:${PORT}`);
  }
  console.log('');
});
