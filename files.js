const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const Busboy = require('busboy');

const FILE_MAX_BYTES = Number(process.env.FILE_MAX_BYTES) || 200 * 1024 * 1024;
const FILE_MAX_COUNT = Number(process.env.FILE_MAX_COUNT) || 10;
const FILE_TOTAL_MAX_BYTES = Number(process.env.FILE_TOTAL_MAX_BYTES) || 500 * 1024 * 1024;
const FILE_SMALL_THRESHOLD = 50 * 1024 * 1024;
const FILE_TTL_SMALL_MS = 10 * 60 * 1000;
const FILE_TTL_LARGE_MS = 5 * 60 * 1000;
const TMP_DIR = path.join(__dirname, 'tmp');

let files = [];

function fileTtl(size) {
  return size >= FILE_SMALL_THRESHOLD ? FILE_TTL_LARGE_MS : FILE_TTL_SMALL_MS;
}

function fileList() {
  return files.map(({ id, name, size, mime, createdAt, expiresAt }) => ({
    id, name, size, mime, createdAt, expiresAt,
  }));
}

function initFiles() {
  fs.mkdirSync(TMP_DIR, { recursive: true });
}

function removeFile(id) {
  const idx = files.findIndex((f) => f.id === id);
  if (idx < 0) return;
  const [meta] = files.splice(idx, 1);
  fs.unlink(path.join(TMP_DIR, meta.id), () => {});
}

function purgeExpiredFiles() {
  const now = Date.now();
  let changed = false;
  for (const f of [...files]) {
    if (f.expiresAt <= now) {
      removeFile(f.id);
      changed = true;
    }
  }
  return changed;
}

function enforceFileBudget() {
  purgeExpiredFiles();
  while (files.length > FILE_MAX_COUNT) removeFile(files[files.length - 1].id);
  let total = files.reduce((sum, f) => sum + f.size, 0);
  while (files.length && total > FILE_TOTAL_MAX_BYTES) {
    const last = files[files.length - 1];
    total -= last.size;
    removeFile(last.id);
  }
}

function canAcceptUpload() {
  purgeExpiredFiles();
  if (files.length >= FILE_MAX_COUNT) return { ok: false, error: 'too_many_files' };
  const total = files.reduce((sum, f) => sum + f.size, 0);
  if (total >= FILE_TOTAL_MAX_BYTES) return { ok: false, error: 'quota_exceeded' };
  return { ok: true };
}

// 修复中文等非 ASCII 文件名乱码（UTF-8 被当成 latin1 解析）
function fixFilename(raw) {
  if (!raw) return 'file';
  const base = path.basename(raw);
  if (/^[\x20-\x7E]+$/.test(base)) return base;
  const utf8 = Buffer.from(base, 'latin1').toString('utf8');
  return utf8.includes('\uFFFD') ? base : utf8;
}

function resolveFilename(req, info) {
  const hdr = req.get('x-filename');
  if (hdr) {
    try {
      return path.basename(decodeURIComponent(hdr));
    } catch { /* fallback */ }
  }
  return fixFilename(info.filename);
}

function registerRoutes(app, pinOk, broadcast) {
  app.use('/api/files', (req, res, next) => {
    if (!pinOk(req)) return res.status(401).json({ error: 'unauthorized' });
    next();
  });

  app.get('/api/files', (_req, res) => {
    res.json({ files: fileList() });
  });

  app.post('/api/files', (req, res) => {
    const check = canAcceptUpload();
    if (!check.ok) return res.status(413).json({ error: check.error });

    const bb = Busboy({
      headers: req.headers,
      limits: { files: 1, fileSize: FILE_MAX_BYTES },
      defParamCharset: 'utf8',
    });
    let done = false;
    let gotFile = false;

    const fail = (status, error, id) => {
      if (id) fs.unlink(path.join(TMP_DIR, id), () => {});
      if (!done) {
        done = true;
        res.status(status).json({ error });
      }
    };

    bb.on('file', (_field, stream, info) => {
      gotFile = true;
      const id = crypto.randomBytes(8).toString('hex');
      const name = resolveFilename(req, info);
      const mime = info.mimeType || 'application/octet-stream';
      const dest = path.join(TMP_DIR, id);
      const out = fs.createWriteStream(dest);
      let size = 0;

      stream.on('data', (chunk) => { size += chunk.length; });
      stream.on('limit', () => {
        stream.resume();
        out.destroy();
        fail(413, 'file_too_large', id);
      });
      stream.on('error', () => fail(500, 'upload_failed', id));
      out.on('error', () => fail(500, 'upload_failed', id));

      stream.pipe(out);
      out.on('finish', () => {
        if (done) {
          fs.unlink(dest, () => {});
          return;
        }
        const expiresAt = Date.now() + fileTtl(size);
        files.unshift({ id, name, size, mime, createdAt: Date.now(), expiresAt });
        enforceFileBudget();
        done = true;
        broadcast({ type: 'files', files: fileList() });
        res.json({ ok: true, files: fileList() });
      });
    });

    bb.on('error', () => fail(400, 'upload_failed'));
    bb.on('finish', () => { if (!gotFile && !done) fail(400, 'no_file'); });
    req.pipe(bb);
  });

  app.get('/api/files/:id', (req, res) => {
    const meta = files.find((f) => f.id === req.params.id);
    if (!meta || meta.expiresAt <= Date.now()) return res.status(404).json({ error: 'not_found' });
    const filePath = path.join(TMP_DIR, meta.id);
    if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'not_found' });
    res.setHeader('Content-Type', meta.mime);
    res.setHeader('Content-Disposition', `inline; filename*=UTF-8''${encodeURIComponent(meta.name)}`);
    fs.createReadStream(filePath).pipe(res);
  });

  app.delete('/api/files/:id', (req, res) => {
    const meta = files.find((f) => f.id === req.params.id);
    if (!meta) return res.status(404).json({ error: 'not_found' });
    removeFile(req.params.id);
    broadcast({ type: 'files', files: fileList() });
    res.json({ ok: true, files: fileList() });
  });
}

function startCleanup(broadcast) {
  return setInterval(() => {
    if (purgeExpiredFiles()) broadcast({ type: 'files', files: fileList() });
  }, 90 * 1000);
}

function clearAllFiles() {
  for (const f of [...files]) removeFile(f.id);
}

module.exports = {
  initFiles,
  fileList,
  registerRoutes,
  startCleanup,
  clearAllFiles,
  limits: {
    fileMaxMb: Math.round(FILE_MAX_BYTES / (1024 * 1024)),
    fileMaxCount: FILE_MAX_COUNT,
    fileTotalMaxMb: Math.round(FILE_TOTAL_MAX_BYTES / (1024 * 1024)),
    fileTtlSmallMin: FILE_TTL_SMALL_MS / 60000,
    fileTtlLargeMin: FILE_TTL_LARGE_MS / 60000,
  },
};
