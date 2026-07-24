const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { selectUserDataPath } = require('../src/userDataPath');

test('preserves legacy application data after the visible product rename', t => {
  const appData = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-toolbox-user-data-'));
  t.after(() => fs.rmSync(appData, { recursive: true, force: true }));
  const current = path.join(appData, 'TG_Content_Toolbox');
  const legacy = path.join(appData, 'MissAV_Manager');
  fs.mkdirSync(path.join(legacy, 'data'), { recursive: true });
  fs.writeFileSync(path.join(legacy, 'data', 'missav_data.db'), 'fixture');

  assert.deepEqual(selectUserDataPath({ appData, current }), {
    path: legacy,
    source: 'legacy:MissAV_Manager',
    legacy: true,
  });

  fs.mkdirSync(path.join(current, 'secure'), { recursive: true });
  assert.deepEqual(selectUserDataPath({ appData, current }), {
    path: current,
    source: 'current',
    legacy: false,
  });
});

test('explicit isolated user data always wins', () => {
  const explicit = path.resolve('isolated-fixture');
  assert.deepEqual(selectUserDataPath({
    explicit,
    appData: path.dirname(explicit),
    current: path.join(path.dirname(explicit), 'TG_Content_Toolbox'),
  }), {
    path: explicit,
    source: 'environment',
    legacy: false,
  });
});
