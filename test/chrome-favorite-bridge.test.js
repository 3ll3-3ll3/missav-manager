const test = require('node:test');
const assert = require('node:assert/strict');

const { ChromeFavoriteBridge, sanitizeExtensionResult } = require('../src/chromeFavoriteBridge');

const TOKEN = 'a'.repeat(64);

function request(bridge, path, options = {}) {
  const headers = { ...(options.headers || {}), Authorization: `Bearer ${TOKEN}` };
  return fetch(`http://127.0.0.1:${bridge.port}${path}`, { ...options, headers });
}

test('Chrome favorite bridge binds locally, authenticates and returns a sanitized task result', async t => {
  const bridge = new ChromeFavoriteBridge({ token: TOKEN, ports: [0] });
  await bridge.start();
  t.after(() => bridge.close());

  const unauthorized = await fetch(`http://127.0.0.1:${bridge.port}/v1/next`);
  assert.equal(unauthorized.status, 401);

  const hello = await request(bridge, '/v1/hello', {
    method: 'POST',
    body: JSON.stringify({ version: '1.0.0', accountLabel: '2307402078' }),
  });
  assert.equal(hello.status, 200);
  assert.equal(bridge.status().connected, true);
  assert.equal(bridge.status().accountLabel, '2307402078');

  const pending = bridge.execute('favorite', {
    code: 'ABF-356',
    url: 'https://123av.com/cn/v/abf-356',
    workerId: 2,
  });
  const next = await request(bridge, '/v1/next');
  assert.equal(next.status, 200);
  const { task } = await next.json();
  assert.equal(task.command, 'favorite');
  assert.equal(task.payload.code, 'ABF-356');
  assert.equal(task.payload.workerId, 2);
  assert.equal(JSON.stringify(task).includes(TOKEN), false);

  const posted = await request(bridge, '/v1/result', {
    method: 'POST',
    body: JSON.stringify({
      id: task.id,
      result: {
        status: 'succeeded',
        url: task.payload.url,
        metadata: { responseKind: 'saved', clickAttempted: true, accountLabel: '2307402078', secret: 'discard-me' },
      },
    }),
  });
  assert.equal(posted.status, 200);
  const result = await pending;
  assert.equal(result.status, 'succeeded');
  assert.equal(result.metadata.transport, 'local_chrome_extension');
  assert.equal(result.metadata.clickAttempted, true);
  assert.equal('secret' in result.metadata, false);
});

test('Chrome favorite bridge refuses to queue account side effects before extension pairing', async t => {
  const bridge = new ChromeFavoriteBridge({ token: TOKEN, ports: [0] });
  await bridge.start();
  t.after(() => bridge.close());
  const result = await bridge.execute('favorite', { code: 'ABF-356', url: 'https://123av.com/cn/v/abf-356' });
  assert.equal(result.status, 'manual');
  assert.equal(result.requiresUserAction, true);
  assert.equal(result.metadata.responseKind, 'chrome_extension_required');
  assert.equal(bridge.status().queued, 0);
});

test('extension result sanitizer only keeps bounded account-operation fields', () => {
  const result = sanitizeExtensionResult({
    status: 'invented',
    error: 'x'.repeat(2000),
    metadata: { retryAfterMs: 999999999, clickAttempted: true, cookie: 'forbidden' },
  });
  assert.equal(result.status, 'failed');
  assert.equal(result.error.length, 1000);
  assert.equal(result.metadata.retryAfterMs, 600000);
  assert.equal(result.metadata.clickAttempted, true);
  assert.equal('cookie' in result.metadata, false);
});
