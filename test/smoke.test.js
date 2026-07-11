#!/usr/bin/env node
process.env.HISTORY_DELAY = '100';
const WebSocket = require('ws');
const { server, setText } = require('../server');

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

  // 历史：POST 更新后，防抖窗口过后应入列
  await fetch(`http://127.0.0.1:${port}/api/text`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: 'note-1' }),
  });
  await new Promise((r) => setTimeout(r, 300));
  const histRes = await fetch(`http://127.0.0.1:${port}/api/text`);
  const histData = await histRes.json();
  if (!histData.history?.some((h) => h.text === 'note-1')) {
    throw new Error('history failed');
  }

  const delRes = await fetch(`http://127.0.0.1:${port}/api/history`, { method: 'DELETE' });
  const delData = await delRes.json();
  if (delData.history?.length) throw new Error('clear history failed');

  const boundary = 'clipbridge-test';
  const body = [
    `--${boundary}`,
    'Content-Disposition: form-data; name="file"; filename="test.txt"',
    'Content-Type: text/plain',
    '',
    'file-ok',
    `--${boundary}--`,
    '',
  ].join('\r\n');
  const upRes = await fetch(`http://127.0.0.1:${port}/api/files`, {
    method: 'POST',
    headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}` },
    body,
  });
  const upData = await upRes.json();
  if (!upRes.ok || !upData.files?.some((f) => f.name === 'test.txt')) {
    throw new Error('file upload failed');
  }

  const dlRes = await fetch(`http://127.0.0.1:${port}/api/files/${upData.files[0].id}`);
  if ((await dlRes.text()) !== 'file-ok') throw new Error('file download failed');

  const cnName = '新建文档.txt';
  const cnBody = [
    `--${boundary}`,
    `Content-Disposition: form-data; name="file"; filename="${cnName}"`,
    'Content-Type: text/plain',
    '',
    'cn-ok',
    `--${boundary}--`,
    '',
  ].join('\r\n');
  const cnRes = await fetch(`http://127.0.0.1:${port}/api/files`, {
    method: 'POST',
    headers: {
      'Content-Type': `multipart/form-data; boundary=${boundary}`,
      'x-filename': encodeURIComponent(cnName),
    },
    body: cnBody,
  });
  const cnData = await cnRes.json();
  if (!cnData.files?.some((f) => f.name === cnName)) throw new Error('filename encoding failed');

  const fileId = cnData.files.find((f) => f.name === cnName).id;
  const rmRes = await fetch(`http://127.0.0.1:${port}/api/files/${fileId}`, { method: 'DELETE' });
  const rmData = await rmRes.json();
  if (rmData.files?.some((f) => f.id === fileId)) throw new Error('file delete failed');

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
