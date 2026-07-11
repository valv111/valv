const express = require('express');
const http = require('http');
const os = require('os');
const path = require('path');
const QRCode = require('qrcode');
const { WebSocketServer } = require('ws');

const PORT = Number(process.env.PORT) || 3456;
const HOST = process.env.HOST || '0.0.0.0';
const MAX_TEXT_BYTES = Number(process.env.MAX_TEXT_BYTES) || 512 * 1024;
const PIN = String(process.env.PIN || '').trim();

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server, maxPayload: MAX_TEXT_BYTES + 4096 });

let text = '';
let updatedAt = 0;
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
  res.json({ needPin: Boolean(PIN) });
});

app.use('/api/text', (req, res, next) => {
  if (!pinOk(req)) return res.status(401).json({ error: 'unauthorized' });
  next();
});

app.get('/api/text', (_req, res) => {
  res.json({ text, ts: updatedAt });
});

app.post('/api/text', (req, res) => {
  const next = trimText(req.body?.text);
  if (next !== text) {
    text = next;
    updatedAt = Date.now();
    broadcast({ ...snapshot(), from: 'peer' });
  }
  res.json({ text, ts: updatedAt });
});

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
  broadcastPeers();

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }
    if (msg.type !== 'update') return;
    const next = trimText(msg.text);
    if (next === text) return;
    text = next;
    updatedAt = Date.now();
    broadcast({ ...snapshot(), from: 'peer' }, ws);
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
};
