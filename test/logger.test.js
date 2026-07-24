const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createRuntimeLogger, cleanValue } = require('../src/logger');

test('redacts credentials from log fields and message strings', () => {
  const cleaned = cleanValue({
    token: 'very-secret-token',
    nested: { Authorization: 'Bearer abcdefghijklmnop', password: 'password123' },
    message: 'request Authorization: Bearer qwertyuiopasdfgh failed for 123456789:AAExampleBotToken_abcdefghijklmnopqrstuvwxyz',
    url: 'https://api.telegram.org/bot123456789:AAExampleBotToken_abcdefghijklmnopqrstuvwxyz/getMe',
    code: 'ABF-354',
  });
  assert.equal(cleaned.token, '[redacted]');
  assert.equal(cleaned.nested.Authorization, '[redacted]');
  assert.equal(cleaned.nested.password, '[redacted]');
  assert.doesNotMatch(cleaned.message, /qwertyuiopasdfgh/);
  assert.doesNotMatch(cleaned.message, /AAExampleBotToken/);
  assert.doesNotMatch(cleaned.url, /AAExampleBotToken/);
  assert.equal(cleaned.code, 'ABF-354');
});

test('persists, tails and rotates runtime diagnostics', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'missav-manager-log-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const logger = createRuntimeLogger(dir, { maxBytes: 64 * 1024 });

  logger.append({ level: 'info', event: 'started', data: { codeCount: 2 } });
  assert.match(logger.readRecent(), /started/);
  assert.match(logger.readRecent(), /"codeCount":2/);

  for (let i = 0; i < 90; i++) logger.append({ level: 'debug', event: 'candidate', data: { index: i, text: 'x'.repeat(900) } });
  const info = logger.info();
  assert.equal(fs.existsSync(info.filePath), true);
  assert.equal(fs.existsSync(info.rotatedFilePath), true);
  assert.ok(info.size <= info.maxBytes);
  assert.match(logger.readRecent(8192), /candidate/);
});
