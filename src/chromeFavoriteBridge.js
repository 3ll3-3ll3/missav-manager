const http = require('http');
const crypto = require('crypto');

const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PORTS = Object.freeze([17831, 17832, 17833, 17834, 17835, 17836, 17837, 17838, 17839]);
const MAX_BODY_BYTES = 64 * 1024;

function jsonResponse(response, statusCode, value) {
  const body = JSON.stringify(value);
  response.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Cache-Control': 'no-store',
  });
  response.end(body);
}

function readJsonBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    request.on('data', chunk => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('请求内容过大'));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => {
      try {
        resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {});
      } catch {
        reject(new Error('JSON 格式无效'));
      }
    });
    request.on('error', reject);
  });
}

function safeText(value, maxLength = 500) {
  return String(value == null ? '' : value).trim().slice(0, maxLength);
}

function sanitizeExtensionResult(value = {}) {
  const allowedStatuses = new Set([
    'ready', 'succeeded', 'already_saved', 'verify_required', 'network_error',
    'manual', 'not_logged_in', 'failed',
  ]);
  const metadata = value && typeof value.metadata === 'object' && !Array.isArray(value.metadata)
    ? value.metadata
    : {};
  return {
    status: allowedStatuses.has(String(value.status)) ? String(value.status) : 'failed',
    url: safeText(value.url, 800),
    error: safeText(value.error, 1000),
    requiresUserAction: value.requiresUserAction === true,
    metadata: {
      responseKind: safeText(metadata.responseKind, 64),
      accountLabel: safeText(metadata.accountLabel, 64),
      pageUrl: safeText(metadata.pageUrl, 800),
      remoteState: safeText(metadata.remoteState, 32),
      clickAttempted: metadata.clickAttempted === true,
      retryAfterMs: Math.max(0, Math.min(10 * 60 * 1000, Number(metadata.retryAfterMs) || 0)),
      confirmationPolls: Math.max(0, Math.min(100, Number(metadata.confirmationPolls) || 0)),
      confirmationWaitMs: Math.max(0, Math.min(60000, Number(metadata.confirmationWaitMs) || 0)),
      transport: 'local_chrome_extension',
    },
  };
}

class ChromeFavoriteBridge {
  constructor(options = {}) {
    this.host = String(options.host || DEFAULT_HOST);
    this.ports = Array.isArray(options.ports) && options.ports.length ? options.ports : DEFAULT_PORTS;
    this.token = String(options.token || crypto.randomBytes(32).toString('hex'));
    this.log = typeof options.log === 'function' ? options.log : () => {};
    this.server = null;
    this.port = 0;
    this.lastSeenAt = 0;
    this.extensionVersion = '';
    this.accountLabel = '';
    this.queue = [];
    this.pending = new Map();
    this.closed = false;
  }

  async start() {
    if (this.server) return this.status();
    this.closed = false;
    let lastError = null;
    for (const requestedPort of this.ports) {
      try {
        await this._listen(Number(requestedPort));
        this.log('info', 'chrome_favorite_bridge_started', { host: this.host, port: this.port });
        return this.status();
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError || new Error('无法启动本地 Chrome 收藏桥接');
  }

  _listen(port) {
    return new Promise((resolve, reject) => {
      const server = http.createServer((request, response) => this._handleRequest(request, response));
      const onError = error => {
        server.removeListener('listening', onListening);
        try { server.close(); } catch {}
        reject(error);
      };
      const onListening = () => {
        server.removeListener('error', onError);
        this.server = server;
        this.port = Number(server.address()?.port || port);
        resolve();
      };
      server.once('error', onError);
      server.once('listening', onListening);
      server.listen(port, this.host);
    });
  }

  isConnected(now = Date.now()) {
    return Boolean(this.lastSeenAt && now - this.lastSeenAt < 15000);
  }

  status() {
    return {
      running: Boolean(this.server?.listening),
      connected: this.isConnected(),
      port: this.port,
      lastSeenAt: this.lastSeenAt,
      extensionVersion: this.extensionVersion,
      accountLabel: this.accountLabel,
      queued: this.queue.length,
      active: this.pending.size - this.queue.length,
    };
  }

  pairingCode() {
    if (!this.port) throw new Error('Chrome 收藏桥接尚未启动');
    return `MMCB1:${this.port}:${this.token}`;
  }

  execute(command, payload = {}, options = {}) {
    if (!this.server?.listening) return Promise.reject(new Error('Chrome 收藏桥接尚未启动'));
    if (!this.isConnected()) {
      return Promise.resolve({
        status: 'manual',
        error: '本地 Chrome 扩展尚未连接，请先完成一次扩展配对',
        requiresUserAction: true,
        metadata: { responseKind: 'chrome_extension_required', transport: 'local_chrome_extension' },
      });
    }
    const id = crypto.randomUUID();
    const timeoutMs = Math.max(5000, Math.min(120000, Number(options.timeoutMs) || 45000));
    return new Promise(resolve => {
      const timer = setTimeout(() => {
        const pending = this.pending.get(id);
        if (!pending) return;
        this.pending.delete(id);
        this.queue = this.queue.filter(task => task.id !== id);
        resolve({
          status: 'verify_required',
          url: safeText(payload.url, 800),
          error: '本地 Chrome 扩展执行超时，需重新打开详情页核对远端状态',
          metadata: {
            responseKind: 'chrome_extension_timeout',
            clickAttempted: pending.delivered,
            transport: 'local_chrome_extension',
          },
        });
      }, timeoutMs);
      const task = {
        id,
        command: safeText(command, 64),
        payload: {
          code: safeText(payload.code, 100),
          url: safeText(payload.url, 800),
          verifyOnly: payload.verifyOnly === true,
          workerId: Math.max(0, Math.min(3, Number(payload.workerId) || 0)),
        },
        createdAt: Date.now(),
      };
      this.pending.set(id, { resolve, timer, delivered: false, task });
      this.queue.push(task);
    });
  }

  _authorized(request) {
    const header = String(request.headers.authorization || '');
    const supplied = header.startsWith('Bearer ') ? header.slice(7) : '';
    const expected = Buffer.from(this.token);
    const actual = Buffer.from(supplied);
    return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
  }

  async _handleRequest(request, response) {
    if (request.method === 'OPTIONS') {
      response.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Authorization, Content-Type',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Max-Age': '600',
      });
      response.end();
      return;
    }
    if (!this._authorized(request)) {
      jsonResponse(response, 401, { error: 'unauthorized' });
      return;
    }
    this.lastSeenAt = Date.now();
    try {
      const url = new URL(request.url, `http://${this.host}:${this.port}`);
      if (request.method === 'POST' && url.pathname === '/v1/hello') {
        const body = await readJsonBody(request);
        this.extensionVersion = safeText(body.version, 32);
        this.accountLabel = safeText(body.accountLabel, 64) || this.accountLabel;
        jsonResponse(response, 200, { ok: true, status: this.status() });
        return;
      }
      if (request.method === 'GET' && url.pathname === '/v1/next') {
        let task = null;
        while (this.queue.length && !task) {
          const candidate = this.queue.shift();
          const pending = this.pending.get(candidate.id);
          if (!pending) continue;
          pending.delivered = true;
          task = candidate;
        }
        if (!task) {
          response.writeHead(204, {
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Headers': 'Authorization, Content-Type',
            'Cache-Control': 'no-store',
          });
          response.end();
          return;
        }
        jsonResponse(response, 200, { task });
        return;
      }
      if (request.method === 'POST' && url.pathname === '/v1/result') {
        const body = await readJsonBody(request);
        const id = safeText(body.id, 80);
        const pending = this.pending.get(id);
        if (!pending) {
          jsonResponse(response, 409, { ok: false, error: 'task_not_pending' });
          return;
        }
        this.pending.delete(id);
        clearTimeout(pending.timer);
        const result = sanitizeExtensionResult(body.result);
        this.accountLabel = result.metadata.accountLabel || this.accountLabel;
        pending.resolve(result);
        jsonResponse(response, 200, { ok: true });
        return;
      }
      jsonResponse(response, 404, { error: 'not_found' });
    } catch (error) {
      jsonResponse(response, 400, { error: safeText(error.message, 300) });
    }
  }

  async close() {
    this.closed = true;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.resolve({
        status: 'verify_required',
        error: 'APP 已关闭，Chrome 收藏任务状态需要重新核对',
        metadata: { responseKind: 'bridge_closed', clickAttempted: pending.delivered, transport: 'local_chrome_extension' },
      });
    }
    this.pending.clear();
    this.queue = [];
    const server = this.server;
    this.server = null;
    this.port = 0;
    if (!server) return;
    await new Promise(resolve => server.close(() => resolve()));
  }
}

module.exports = {
  ChromeFavoriteBridge,
  sanitizeExtensionResult,
  DEFAULT_PORTS,
};
