import { spawn } from 'node:child_process';
import { access, mkdir } from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const outDir = path.join(root, 'docs/screenshots');
const url = process.env.CB_URL || 'http://127.0.0.1:3456/';

const chromePaths = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  'google-chrome',
  'chromium',
];

async function findChrome() {
  for (const candidate of chromePaths) {
    try {
      if (candidate.includes('/')) await access(candidate, constants.X_OK);
      return candidate;
    } catch { /* try next */ }
  }
  throw new Error('未找到 Chrome，请安装 Google Chrome 或 Chromium');
}

function shot(chrome, out, width, height) {
  return new Promise((resolve, reject) => {
    const proc = spawn(chrome, [
      '--headless=new',
      '--disable-gpu',
      '--hide-scrollbars',
      `--window-size=${width},${height}`,
      `--screenshot=${out}`,
      url,
    ], { stdio: 'ignore' });
    proc.on('error', reject);
    proc.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`chrome exit ${code}`))));
  });
}

await mkdir(outDir, { recursive: true });
const chrome = await findChrome();

await shot(chrome, path.join(outDir, 'mobile.png'), 390, 1500);
await shot(chrome, path.join(outDir, 'desktop.png'), 960, 1200);
console.log('screenshots saved to docs/screenshots/');
