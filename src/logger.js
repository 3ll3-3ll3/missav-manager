const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_MAX_BYTES = 5 * 1024 * 1024;
const DEFAULT_RECENT_BYTES = 256 * 1024;
const SENSITIVE_KEY = /(?:authorization|token|password|passwd|cookie|session|secret)/i;

function cleanString(value) {
  return String(value || '')
    .replace(/\bBearer\s+[A-Za-z0-9._~+\/-]{8,}/gi, 'Bearer [redacted]')
    .replace(/https:\/\/api\.telegram\.org\/bot[^/\s]+/gi, 'https://api.telegram.org/bot[redacted]')
    .replace(/\b\d{5,20}:[A-Za-z0-9_-]{20,}\b/g, '[redacted-bot-token]')
    .replace(/((?:access[_-]?token|authorization|password|passwd|secret)\s*[:=]\s*)[^\s,;]+/gi, '$1[redacted]');
}

function cleanValue(value, depth = 0) {
  if (value === null || value === undefined) return value ?? null;
  if (depth > 3) return '[truncated]';
  if (typeof value === 'string') {
    const cleaned = cleanString(value);
    return cleaned.length > 2000 ? cleaned.slice(0, 2000) + '…' : cleaned;
  }
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (Array.isArray(value)) return value.slice(0, 100).map(item => cleanValue(item, depth + 1));
  if (typeof value === 'object') {
    const result = {};
    for (const [key, item] of Object.entries(value).slice(0, 100)) {
      result[key] = SENSITIVE_KEY.test(key) ? '[redacted]' : cleanValue(item, depth + 1);
    }
    return result;
  }
  return String(value);
}

function createRuntimeLogger(directory, options = {}) {
  const logDirectory = path.resolve(String(directory || ''));
  const logPath = path.join(logDirectory, options.fileName || 'missav-manager.log');
  const rotatedPath = path.join(logDirectory, options.rotatedFileName || 'missav-manager.previous.log');
  const maxBytes = Math.max(64 * 1024, Number(options.maxBytes || DEFAULT_MAX_BYTES));

  function ensureDirectory() {
    fs.mkdirSync(logDirectory, { recursive: true });
  }

  function rotateIfNeeded(incomingBytes = 0) {
    ensureDirectory();
    let size = 0;
    try { size = fs.statSync(logPath).size; } catch {}
    if (size + incomingBytes <= maxBytes) return;
    try { fs.rmSync(rotatedPath, { force: true }); } catch {}
    try { fs.renameSync(logPath, rotatedPath); } catch {}
  }

  function append(entry = {}) {
    const normalized = {
      time: entry.time || new Date().toISOString(),
      level: String(entry.level || 'info').toLowerCase(),
      event: String(entry.event || 'runtime'),
      data: cleanValue(entry.data || {}),
    };
    const line = `${normalized.time} [${normalized.level.toUpperCase()}] ${normalized.event} ${JSON.stringify(normalized.data)}\n`;
    const bytes = Buffer.byteLength(line);
    rotateIfNeeded(bytes);
    fs.appendFileSync(logPath, line, 'utf8');
    return true;
  }

  function readRecent(maxReadBytes = DEFAULT_RECENT_BYTES) {
    ensureDirectory();
    if (!fs.existsSync(logPath)) return '';
    const size = fs.statSync(logPath).size;
    const length = Math.min(size, Math.max(4096, Number(maxReadBytes || DEFAULT_RECENT_BYTES)));
    const buffer = Buffer.alloc(length);
    const fd = fs.openSync(logPath, 'r');
    try { fs.readSync(fd, buffer, 0, length, size - length); } finally { fs.closeSync(fd); }
    let text = buffer.toString('utf8');
    if (size > length) {
      const firstBreak = text.indexOf('\n');
      if (firstBreak >= 0) text = text.slice(firstBreak + 1);
    }
    return text;
  }

  function info() {
    ensureDirectory();
    let size = 0;
    try { size = fs.statSync(logPath).size; } catch {}
    return { directory: logDirectory, filePath: logPath, rotatedFilePath: rotatedPath, size, maxBytes };
  }

  return { append, readRecent, info };
}

module.exports = { createRuntimeLogger, cleanValue };
