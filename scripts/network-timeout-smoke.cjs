const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { app, net, session } = require('electron');
const { fetchWithElectronRequest } = require('../src/networkTransport');

const testUserData = fs.mkdtempSync(path.join(os.tmpdir(), 'missav-network-timeout-'));
app.disableHardwareAcceleration();
app.commandLine.appendSwitch('disable-gpu');
app.commandLine.appendSwitch('disable-gpu-compositing');
app.setPath('userData', testUserData);
app.once('quit', () => {
  try { fs.rmSync(testUserData, { recursive: true, force: true }); } catch {}
});

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return server.address().port;
}

async function close(server) {
  await new Promise(resolve => server.close(resolve));
}

async function run() {
  await app.whenReady();
  const server = http.createServer((req, res) => {
    if (req.url === '/slow-body') {
      res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
      res.write('started');
      setTimeout(() => res.end('finished'), 4000);
      return;
    }
    if (req.url === '/redirect') {
      res.writeHead(302, { location: '/ok' });
      res.end();
      return;
    }
    res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('ok');
  });
  const port = await listen(server);
  const origin = `http://127.0.0.1:${port}`;

  try {
    const normal = await fetchWithElectronRequest(net, `${origin}/ok`, { timeout: 2000 });
    assert.equal(normal.statusCode, 200);
    assert.equal(normal.body, 'ok');
    assert.equal(normal.transport, 'electron-client');

    const sessionResult = await fetchWithElectronRequest(net, `${origin}/ok`, {
      timeout: 2000,
      networkSession: session.fromPartition('persist:network-timeout-smoke'),
    });
    assert.equal(sessionResult.statusCode, 200);
    assert.equal(sessionResult.transport, 'electron-client-session');

    const redirected = await fetchWithElectronRequest(net, `${origin}/redirect`, {
      timeout: 2000,
      redirectMode: 'follow',
    });
    assert.equal(redirected.statusCode, 200);
    assert.equal(redirected.body, 'ok');
    assert.equal(redirected.wasRedirected, true);

    const startedAt = Date.now();
    await assert.rejects(
      fetchWithElectronRequest(net, `${origin}/slow-body`, { timeout: 1000 }),
      error => error?.code === 'ETIMEDOUT' && error?.hardTimeout === true,
    );
    const elapsedMs = Date.now() - startedAt;
    assert.ok(elapsedMs >= 850 && elapsedMs < 2200, `硬超时耗时异常: ${elapsedMs}ms`);
    process.stdout.write(`${JSON.stringify({ normal: true, redirected: true, hardTimeoutMs: elapsedMs })}\n`);
  } finally {
    await close(server);
    app.quit();
  }
}

run().catch(error => {
  process.stderr.write(`${error.stack || error}\n`);
  app.exit(1);
});
