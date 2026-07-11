const $ = (id) => document.getElementById(id);
let ws = null;
let remote = false;
let timer = null;
let lastTs = 0;
let pageUrl = '';
let pollTimer = null;
let pin = localStorage.getItem('cb_pin') || '';
let needPin = false;

function toast(msg) {
  const el = $('toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(el._t);
  el._t = setTimeout(() => el.classList.remove('show'), 1800);
}

function setStatus(on, label) {
  $('dot').classList.toggle('on', on);
  $('statusText').textContent = label;
}

function notifyIncoming() {
  const btn = $('copyBtn');
  btn.classList.remove('flash');
  void btn.offsetWidth;
  btn.classList.add('flash');
  try { navigator.vibrate?.(60); } catch { /* ignore */ }
}

function applyRemote(value, ts, silent) {
  if (ts && ts < lastTs) return;
  if (ts) lastTs = ts;
  if ($('text').value === value) return;
  remote = true;
  $('text').value = value;
  remote = false;
  if (!silent) { toast('已同步'); notifyIncoming(); }
}

function withPin(url) {
  if (!pin) return url;
  return url + (url.includes('?') ? '&' : '?') + 'pin=' + encodeURIComponent(pin);
}

async function askPin() {
  const v = prompt('请输入访问密码');
  if (v == null) return false;
  pin = v.trim();
  localStorage.setItem('cb_pin', pin);
  return true;
}

function pushNow() {
  if (remote) return;
  const body = $('text').value;
  if (ws?.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'update', text: body }));
    return;
  }
  fetch('/api/text', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-pin': pin },
    body: JSON.stringify({ text: body }),
  }).catch(() => {});
}

function schedulePush() {
  clearTimeout(timer);
  timer = setTimeout(pushNow, 80);
}

async function poll() {
  try {
    const res = await fetch(`/api/text?_=${Date.now()}`, {
      cache: 'no-store',
      headers: { 'x-pin': pin },
    });
    if (res.status === 401) {
      if (await askPin()) { poll(); connect(); }
      return;
    }
    const data = await res.json();
    if (data.ts > lastTs) applyRemote(data.text, data.ts, document.hidden);
  } catch { /* ignore */ }
}

function startPolling() {
  if (pollTimer) return;
  pollTimer = setInterval(poll, 1500);
}

function stopPolling() {
  clearInterval(pollTimer);
  pollTimer = null;
}

async function loadConfig() {
  try {
    const res = await fetch('/api/config');
    const data = await res.json();
    needPin = Boolean(data.needPin);
    if (needPin && !pin) await askPin();
  } catch { /* ignore */ }
}

async function loadQr() {
  try {
    const res = await fetch('/api/qr');
    const data = await res.json();
    pageUrl = data.url;
    $('qrImg').src = data.qr;
    $('qrImg').hidden = false;
    $('pageUrl').textContent = data.url;
  } catch {
    pageUrl = location.origin + '/';
    $('pageUrl').textContent = pageUrl;
  }
}

function connect() {
  if (ws) { ws.onclose = null; ws.close(); }
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(withPin(`${proto}://${location.host}/`));

  ws.onopen = () => { setStatus(true, '已连接'); stopPolling(); };

  ws.onmessage = (e) => {
    let msg;
    try { msg = JSON.parse(e.data); } catch { return; }
    if (msg.type === 'ping') return;
    if (msg.type === 'peers') {
      setStatus(true, `已连接 · ${msg.count} 台设备`);
      return;
    }
    if (msg.type === 'sync') applyRemote(msg.text, msg.ts, !msg.from);
  };

  ws.onclose = async (e) => {
    setStatus(false, '重连中…');
    startPolling();
    if (e.code === 4001) {
      if (!(await askPin())) return;
    }
    setTimeout(connect, 1500);
  };
  ws.onerror = () => ws.close();
}

$('text').addEventListener('input', schedulePush);
$('text').addEventListener('compositionend', schedulePush);
$('text').addEventListener('paste', () => setTimeout(pushNow, 30));

$('copyBtn').addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText($('text').value);
    toast('已复制到本机');
  } catch {
    $('text').select();
    toast('请长按全选后复制');
  }
});

$('clearBtn').addEventListener('click', () => {
  $('text').value = '';
  pushNow();
  toast('已清空');
});

$('toggleQr').addEventListener('click', () => {
  const body = $('qrBody');
  body.hidden = !body.hidden;
  $('toggleQr').textContent = body.hidden ? '显示二维码' : '隐藏二维码';
});

$('copyUrlBtn').addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(pageUrl || $('pageUrl').textContent);
    toast('网址已复制');
  } catch {
    toast(pageUrl);
  }
});

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') {
    poll();
    if (!ws || ws.readyState !== WebSocket.OPEN) connect();
  }
});

// 桌面默认展开二维码方便手机扫；手机默认折叠留空间给输入框
if (!window.matchMedia('(pointer: coarse)').matches) {
  $('qrBody').hidden = false;
  $('toggleQr').textContent = '隐藏二维码';
}

(async () => {
  await loadConfig();
  loadQr();
  connect();
  poll();
})();
