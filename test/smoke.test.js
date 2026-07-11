#!/usr/bin/env node
const WebSocket = require('ws');
const { server, setText, getUpdatedAt } = require('../server');

function connect(port) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    const t = setTimeout(() => reject(new Error('connect timeout')), 5000);
    ws.on('message', (raw) => {
      const msg = JSON.parse(raw.toString());
      if (msg.type === 'sync') {
        clearTimeout(t);
        resolve(ws);
      }
    });
    ws.on('error', (e) => { clearTimeout(t); reject(e); });
  });
}

async function run() {
  setText('');

  const port = await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve(server.address().port);
    });
  });

  const a = await connect(port);
  const b = await connect(port);

  const synced = new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('ws sync failed')), 3000);
    b.on('message', (raw) => {
      const msg = JSON.parse(raw.toString());
      if (msg.type === 'sync' && msg.text === 'hello') {
        clearTimeout(t);
        resolve();
      }
    });
  });

  a.send(JSON.stringify({ type: 'update', text: 'hello' }));
  await synced;

  // HTTP 轮询兜底
  setText('world');
  const pollRes = await fetch(`http://127.0.0.1:${port}/api/text`);
  const pollData = await pollRes.json();
  if (pollData.text !== 'world') throw new Error('poll failed');

  a.close();
  b.close();
  await new Promise((r) => server.close(r));
  console.log('OK: all tests passed');
}

run()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error('FAIL:', e.message);
    process.exit(1);
  });
