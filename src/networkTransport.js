class NetworkDeadlineError extends Error {
  constructor(timeoutMs) {
    super(`请求超过总时限 (${timeoutMs}ms)`);
    this.name = 'NetworkDeadlineError';
    this.code = 'ETIMEDOUT';
    this.hardTimeout = true;
  }
}

function normalizeResponseHeaders(headers = {}) {
  const normalized = {};
  for (const [key, value] of Object.entries(headers || {})) {
    normalized[String(key).toLowerCase()] = Array.isArray(value) ? value.join(', ') : String(value ?? '');
  }
  return normalized;
}

function fetchWithElectronRequest(netModule, url, options = {}) {
  if (!netModule || typeof netModule.request !== 'function') throw new Error('Electron net.request 不可用');
  const timeoutMs = Math.max(1000, Number(options.timeout) || 15000);
  const maximumBytes = Math.max(64 * 1024, Number(options.maximumBytes) || 8 * 1024 * 1024);
  const redirectMode = options.redirectMode === 'follow' ? 'follow' : 'manual';
  const startedAt = Date.now();

  return new Promise((resolve, reject) => {
    let request;
    let response;
    let timer;
    let settled = false;
    let timedOut = false;
    let finalUrl = url;
    let wasRedirected = false;

    const cleanup = () => {
      if (timer) clearTimeout(timer);
      timer = null;
    };
    const finishResolve = result => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve({
        ...result,
        durationMs: Date.now() - startedAt,
      });
    };
    const finishReject = error => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };

    try {
      request = netModule.request({
        method: options.method || 'GET',
        url,
        headers: options.headers || {},
        redirect: 'manual',
        cache: options.cache || 'no-store',
        ...(options.networkSession ? {
          session: options.networkSession,
          credentials: 'include',
        } : {}),
      });
    } catch (error) {
      finishReject(error);
      return;
    }

    timer = setTimeout(() => {
      timedOut = true;
      try { response?.destroy?.(); } catch {}
      try { request.abort(); } catch {}
      finishReject(new NetworkDeadlineError(timeoutMs));
    }, timeoutMs);

    request.on('redirect', (statusCode, _method, redirectUrl, responseHeaders) => {
      if (redirectMode === 'follow') {
        finalUrl = redirectUrl;
        wasRedirected = true;
        try {
          request.followRedirect();
        } catch (error) {
          finishReject(error);
        }
        return;
      }
      try { request.abort(); } catch {}
      finishResolve({
        redirected: true,
        redirectUrl,
        statusCode: Number(statusCode || 0),
        headers: normalizeResponseHeaders(responseHeaders),
        body: '',
        finalUrl: redirectUrl || url,
        responseBytes: 0,
        transport: options.networkSession ? 'electron-client-session' : 'electron-client',
      });
    });

    request.on('response', incoming => {
      response = incoming;
      const chunks = [];
      let responseBytes = 0;
      incoming.on('data', chunk => {
        if (settled) return;
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        responseBytes += buffer.length;
        if (responseBytes > maximumBytes) {
          try { request.abort(); } catch {}
          finishReject(new Error(`响应正文超过安全上限 (${maximumBytes} bytes)`));
          return;
        }
        chunks.push(buffer);
      });
      incoming.on('end', () => finishResolve({
        redirected: false,
        wasRedirected,
        statusCode: Number(incoming.statusCode || 0),
        headers: normalizeResponseHeaders(incoming.headers),
        body: Buffer.concat(chunks).toString('utf8'),
        finalUrl,
        responseBytes,
        transport: options.networkSession ? 'electron-client-session' : 'electron-client',
      }));
      incoming.on('aborted', () => {
        if (!timedOut) finishReject(new Error('响应在完成前被中断'));
      });
      incoming.on('error', error => {
        if (!timedOut) finishReject(error);
      });
    });

    request.on('error', error => {
      if (!timedOut) finishReject(error);
    });
    request.end();
  });
}

module.exports = {
  NetworkDeadlineError,
  normalizeResponseHeaders,
  fetchWithElectronRequest,
};
