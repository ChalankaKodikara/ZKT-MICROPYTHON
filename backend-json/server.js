'use strict';
// Append-only JSON-lines storage. Every committed batch is one line in attendance.jsonl.
// The last committed cursor is reconstructed from durable lines when the server restarts.
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const readline = require('node:readline');

// Lightweight .env loader; no dotenv dependency required.
const envPath = path.join(__dirname, '.env');
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const m = /^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (m && !Object.hasOwn(process.env, m[1])) process.env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
  }
}

const TOKEN = process.env.DEVICE_API_KEY;
if (!TOKEN || TOKEN.length < 16 || TOKEN === 'replace-with-a-long-random-secret') {
  console.error('Set a DEVICE_API_KEY of at least 16 characters in .env');
  process.exit(1);
}
const PORT = Number(process.env.PORT || 3000);
const DATA_DIR = path.resolve(__dirname, process.env.DATA_DIR || './data');
fs.mkdirSync(DATA_DIR, { recursive: true });
const LOG_PATH = path.join(DATA_DIR, 'attendance.jsonl');
const state = new Map(); // latest committed cursor and inserted record count per device
let unhealthy = false;

function isDevice(s) { return typeof s === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(s); }
function indexOf(cursor) {
  if (cursor === null) return 0;
  if (typeof cursor !== 'string') return null;
  const match = /^(\d+)\.([a-fA-F0-9]{80})$/.exec(cursor);
  if (!match) return null;
  const idx = Number(match[1]);
  return Number.isSafeInteger(idx) && idx > 0 ? idx : null;
}
const savedFor = device => state.get(device) || { cursor: null, count: 0 };
function validateBatch(b) {
  if (!b || !isDevice(b.device_id)) return false;
  const start = indexOf(b.cursor), end = indexOf(b.next_cursor);
  if (start === null || end === null || !Array.isArray(b.records) ||
      b.records.length < 1 || b.records.length > 20 || end - start !== b.records.length) return false;
  return b.records.every(r => r && Number.isSafeInteger(r.user_sn) && r.user_sn >= 0 &&
    typeof r.device_user_id === 'string' && r.device_user_id.length <= 64 &&
    typeof r.record_time === 'string' && r.record_time.length <= 32 &&
    (r.ip === undefined || (typeof r.ip === 'string' && r.ip.length <= 100)));
}

function replayJournal() {
  if (!fs.existsSync(LOG_PATH)) return;
  const raw = fs.readFileSync(LOG_PATH);
  let position = 0;
  let safePosition = 0;
  while (position < raw.length) {
    const newline = raw.indexOf(10, position);
    if (newline < 0) break; // incomplete trailing line after power failure
    let batch;
    try { batch = JSON.parse(raw.subarray(position, newline).toString('utf8')); }
    catch (_) { break; }
    if (!validateBatch(batch)) break;
    const saved = savedFor(batch.device_id);
    if (saved.cursor !== batch.cursor) break;
    state.set(batch.device_id, { cursor: batch.next_cursor, count: saved.count + batch.records.length });
    safePosition = newline + 1;
    position = newline + 1;
  }
  if (safePosition !== raw.length) {
    console.warn('Trimming incomplete/invalid journal tail:', raw.length - safePosition, 'bytes');
    fs.truncateSync(LOG_PATH, safePosition);
  }
}
replayJournal();

function send(res, status, obj) {
  const body = Buffer.from(JSON.stringify(obj));
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': body.length, 'Cache-Control': 'no-store' });
  res.end(body);
}
function auth(req) { return req.headers.authorization === 'Bearer ' + TOKEN; }
function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0, pieces = [];
    req.on('data', chunk => {
      size += chunk.length;
      if (size > 24576) { reject(Object.assign(new Error('Body too large'), { status: 413 })); req.destroy(); }
      else pieces.push(chunk);
    });
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(pieces).toString('utf8'))); }
      catch (_) { reject(Object.assign(new Error('Invalid JSON'), { status: 400 })); }
    });
    req.on('error', reject);
  });
}
async function handle(req, res) {
  const url = new URL(req.url, 'http://localhost');
  if (req.method === 'GET' && url.pathname === '/health') {
    return send(res, 200, { success: true, storage: unhealthy ? 'unhealthy' : 'ok' });
  }
  if (!url.pathname.startsWith('/api/attendance/')) return send(res, 404, { success: false, error: 'NOT_FOUND' });
  if (!auth(req)) return send(res, 401, { success: false, error: 'UNAUTHORIZED' });

  if (req.method === 'GET' && url.pathname === '/api/attendance/sync-state') {
    const device = url.searchParams.get('device_id');
    if (!isDevice(device)) return send(res, 400, { success: false, error: 'BAD_DEVICE' });
    const saved = savedFor(device);
    return send(res, 200, { success: true, cursor: saved.cursor, total_saved: saved.count });
  }

  if (req.method === 'POST' && url.pathname === '/api/attendance/batches') {
    if (unhealthy) return send(res, 503, { success: false, error: 'STORAGE_UNAVAILABLE' });
    const batch = await readBody(req);
    if (!validateBatch(batch)) return send(res, 400, { success: false, error: 'INVALID_BATCH' });
    const saved = savedFor(batch.device_id);
    if (saved.cursor === batch.next_cursor) {
      return send(res, 200, { success: true, replay: true, inserted: 0, committed_cursor: saved.cursor });
    }
    if (saved.cursor !== batch.cursor) {
      return send(res, 409, { success: false, error: 'CURSOR_MISMATCH', committed_cursor: saved.cursor });
    }
    const bytes = Buffer.from(JSON.stringify(batch) + '\n');
    let fd;
    try {
      fd = fs.openSync(LOG_PATH, 'a');
      let pos = 0;
      while (pos < bytes.length) {
        const written = fs.writeSync(fd, bytes, pos, bytes.length - pos);
        if (written <= 0) throw new Error('Short disk write');
        pos += written;
      }
      fs.fsyncSync(fd);
      fs.closeSync(fd); fd = undefined;
      state.set(batch.device_id, { cursor: batch.next_cursor, count: saved.count + batch.records.length });
      console.log('Saved', batch.records.length, 'records from', batch.device_id, '| total:', saved.count + batch.records.length);
      return send(res, 200, { success: true, inserted: batch.records.length, committed_cursor: batch.next_cursor });
    } catch (err) {
      if (fd !== undefined) { try { fs.closeSync(fd); } catch (_) {} }
      unhealthy = true;
      console.error('Storage error:', err);
      return send(res, 500, { success: false, error: 'WRITE_FAILED' });
    }
  }

  if (req.method === 'GET' && url.pathname === '/api/attendance/records') {
    const device = url.searchParams.get('device_id');
    if (!isDevice(device)) return send(res, 400, { success: false, error: 'BAD_DEVICE' });
    const rawOffset = url.searchParams.get('offset') || '0';
    const rawLimit = url.searchParams.get('limit') || '20';
    const offset = Number(rawOffset), limit = Number(rawLimit);
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
      return send(res, 400, { success: false, error: 'BAD_PAGINATION' });
    }
    if (!fs.existsSync(LOG_PATH)) return send(res, 200, { success: true, records: [], count: 0, offset, total_saved: 0 });
    const results = [];
    let scanned = 0;
    const stream = fs.createReadStream(LOG_PATH, { encoding: 'utf8' });
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
    try {
      for await (const line of rl) {
        const batch = JSON.parse(line);
        if (batch.device_id !== device) continue;
        for (const record of batch.records) {
          if (scanned++ < offset) continue;
          results.push(record);
          if (results.length === limit) break;
        }
        if (results.length === limit) break;
      }
      return send(res, 200, { success: true, records: results, count: results.length, offset, total_saved: savedFor(device).count });
    } finally { rl.close(); stream.destroy(); }
  }
  return send(res, 404, { success: false, error: 'NOT_FOUND' });
}
const server = http.createServer((req, res) => {
  handle(req, res).catch(err => {
    console.error('Request failed:', err.message);
    if (!res.headersSent) send(res, err.status || 500, { success: false, error: err.status === 400 ? 'INVALID_JSON' : 'SERVER_ERROR' });
  });
});
if (require.main === module) server.listen(PORT, '0.0.0.0', () => console.log('ZKT JSON backend on port', PORT, '| data:', LOG_PATH));
module.exports = { server, state, indexOf, validateBatch };
