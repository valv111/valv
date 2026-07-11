const express = require('express');
const http = require('http');
const os = require('os');
const path = require('path');
const QRCode = require('qrcode');
const { WebSocketServer } = require('ws');
const files = require('./files');

const PORT = Number(process.env.PORT) || 3456;
const HOST = process.env.HOST || '0.0.0.0';
const MAX_TEXT_BYTES = Number(process.env.MAX_TEXT_BYTES) || 512 * 1024;
const PIN = String(process.env.PIN || '').trim();
const HISTORY_MAX = 10;
const HISTORY_DELAY = Number(process.env.HISTORY_DELAY) || 1500;
const HISTORY_ITEM_MAX_BYTES = Number(process.env.HISTORY_ITEM_MAX_BYTES) || 64 * 1024;
const HISTORY_TOTAL_MAX_BYTES = Number(process.env.HISTORY_TOTAL_MAX_BYTES) || 512 * 1024;
const HISTORY_TTL_MS = Number(process.env.HISTORY_TTL_MS) || 24 * 60 * 60 * 1000;

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server, maxPayload: MAX_TEXT_BYTES + 4096 });

let text = '';
let updatedAt = 0;
let history = []; // 最新在前，最多 HISTORY_MAX 条
let historyTimer = null;
const clients = new Set();

function getLocalIPs() {
  const ips = [];
  for (const iface of Object.values(os.networkInterfaces())) {
    for (const net of iface || []) {
      if (net.family === 'IPv4' && !net.internal) ips.push(net.address);
    }
  }
  return ips.length ? ips : ['127.0.0.1'];
}

function trimText(value) {
  const buf = Buffer.from(String(value ?? ''), 'utf8');
  if (buf.length <= MAX_TEXT_BYTES) return buf.toString('utf8');
  return buf.subarray(0, MAX_TEXT_BYTES).toString('utf8');
}

function snapshot() {
  return { type: 'sync', text, ts: updatedAt };
}

// 更新全局文本，返回是否有变化；变化时安排历史入列（防抖）
function applyUpdate(next) {
  if (next === text) return false;
  text = next;
  updatedAt = Date.now();
  clearTimeout(historyTimer);
  historyTimer = setTimeout(commitHistory, HISTORY_DELAY);
  return true;
}

// 内容稳定后记一条历史，去重、跳过空内容
function commitHistory() {
  purgeExpiredHistory();
  if (!text.trim() || history[0]?.text === text) return;
  history.unshift(historyEntry(text, updatedAt));
  trimHistoryBudget();
  broadcast({ type: 'history', history });
}

function historyEntry(value, ts) {
  const buf = Buffer.from(value, 'utf8');
  if (buf.length <= HISTORY_ITEM_MAX_BYTES) return { text: value, ts };
  return { text: buf.subarray(0, HISTORY_ITEM_MAX_BYTES).toString('utf8'), ts, truncated: true };
}

function historyBytes() {
  return history.reduce((sum, item) => sum + Buffer.byteLength(item.text, 'utf8'), 0);
}

// 条数 + 总字节双上限，超出删最旧的
function trimHistoryBudget() {
  while (history.length > HISTORY_MAX) history.pop();
  while (history.length && historyBytes() > HISTORY_TOTAL_MAX_BYTES) history.pop();
}

function purgeExpiredHistory() {
  const cutoff = Date.now() - HISTORY_TTL_MS;
  const before = history.length;
  history = history.filter((item) => item.ts >= cutoff);
  return before !== history.length;
}

function clearHistory() {
  history = [];
  clearTimeout(historyTimer);
  broadcast({ type: 'history', history });
}

function broadcast(payload, except) {
  const msg = JSON.stringify(payload);
  for (const ws of clients) {
    if (ws !== except && ws.readyState === ws.OPEN) ws.send(msg);
  }
}

function broadcastPeers() {
  const n = clients.size;
  const msg = JSON.stringify({ type: 'peers', count: n });
  for (const ws of clients) {
    if (ws.readyState === ws.OPEN) ws.send(msg);
  }
}

app.use((req, res, next) => {
  res.setHeader('Cache-Control', 'no-store');
  next();
});

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public'), { maxAge: 0 }));

function pinOk(req) {
  if (!PIN) return true;
  const provided = req.get('x-pin') || req.query.pin || '';
  return provided === PIN;
}

app.get('/api/config', (_req, res) => {
  res.json({
    needPin: Boolean(PIN),
    limits: {
      historyMax: HISTORY_MAX,
      historyTotalMaxKb: Math.round(HISTORY_TOTAL_MAX_BYTES / 1024),
      historyTtlHours: Math.round(HISTORY_TTL_MS / 3600000),
      ...files.limits,
    },
  });
});

app.use('/api/text', (req, res, next) => {
  if (!pinOk(req)) return res.status(401).json({ error: 'unauthorized' });
  next();
});

app.use('/api/history', (req, res, next) => {
  if (!pinOk(req)) return res.status(401).json({ error: 'unauthorized' });
  next();
});

app.get('/api/text', (_req, res) => {
  res.json({ text, ts: updatedAt, history });
});

app.post('/api/text', (req, res) => {
  if (applyUpdate(trimText(req.body?.text))) {
    broadcast({ ...snapshot(), from: 'peer' });
  }
  res.json({ text, ts: updatedAt });
});

app.delete('/api/history', (_req, res) => {
  clearHistory();
  res.json({ ok: true, history });
});

files.registerRoutes(app, pinOk, broadcast);
files.initFiles();

app.get('/api/qr', async (req, res) => {
  const host = req.get('host');
  const proto = req.get('x-forwarded-proto') || req.protocol || 'http';
  const url = host
    ? `${proto}://${host}/`
    : `http://${getLocalIPs()[0]}:${PORT}/`;
  try {
    const qr = await QRCode.toDataURL(url, { margin: 1, width: 220 });
    res.json({ url, qr, ips: getLocalIPs() });
  } catch {
    res.status(500).json({ error: 'qr_failed' });
  }
});

wss.on('connection', (ws, req) => {
  if (PIN) {
    const params = new URLSearchParams((req.url || '').split('?')[1] || '');
    if (params.get('pin') !== PIN) {
      ws.close(4001, 'unauthorized');
      return;
    }
  }
  clients.add(ws);
  ws.send(JSON.stringify(snapshot()));
  ws.send(JSON.stringify({ type: 'history', history }));
  ws.send(JSON.stringify({ type: 'files', files: files.fileList() }));
  broadcastPeers();

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }
    if (msg.type !== 'update') return;
    if (applyUpdate(trimText(msg.text))) {
      broadcast({ ...snapshot(), from: 'peer' }, ws);
    }
  });

  ws.on('close', () => {
    clients.delete(ws);
    broadcastPeers();
  });
});

// 心跳，防止移动浏览器断开 WebSocket
setInterval(() => {
  const msg = JSON.stringify({ type: 'ping' });
  for (const ws of clients) {
    if (ws.readyState === ws.OPEN) ws.send(msg);
  }
}, 25000);

// 定期清理过期历史，避免长期运行占内存
setInterval(() => {
  if (purgeExpiredHistory()) broadcast({ type: 'history', history });
}, 10 * 60 * 1000);

files.startCleanup(broadcast);

if (require.main === module) {
  server.listen(PORT, HOST, () => {
    console.log(`ClipBridge  http://localhost:${PORT}`);
    getLocalIPs().forEach((ip) => console.log(`  局域网  http://${ip}:${PORT}`));
    if (PIN) console.log('  已启用访问密码 (PIN)');
  });
}

module.exports = {
  app,
  server,
  wss,
  getText: () => text,
  setText: (v) => { text = v; updatedAt = Date.now(); },
  getUpdatedAt: () => updatedAt,
  getHistory: () => history,
  clearHistory,
  clearAllFiles: files.clearAllFiles,
  fileList: files.fileList,
};
