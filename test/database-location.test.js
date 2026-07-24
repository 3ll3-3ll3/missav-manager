const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const database = require('../src/database');
const location = require('../src/databaseLocation');

test('copies and validates a database into a user-selected project folder', async t => {
  database.close();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-toolbox-location-'));
  const source = path.join(root, 'default-data');
  const target = path.join(root, 'project', 'toolbox-data');
  const userData = path.join(root, 'bootstrap');
  t.after(() => {
    database.close();
    fs.rmSync(root, { recursive: true, force: true });
  });

  await database.init(source);
  database.createCodeRecord('ABF-354', 'https://missav.ai/cn/abf-354', 'ok');
  database.createBackup('location-test', 'test');
  database.save('FULL');
  database.close();

  const result = location.relocateDatabaseDirectory(source, target);
  assert.equal(result.changed, true);
  assert.equal(fs.existsSync(path.join(target, 'missav_data.db')), true);
  assert.equal(fs.existsSync(path.join(target, 'backups')), true);
  assert.equal(fs.existsSync(path.join(source, 'missav_data.db')), true, 'source database must remain recoverable');

  location.writeDatabaseDirectory(userData, target);
  assert.deepEqual(location.readDatabaseDirectory(userData), {
    directory: target,
    configured: true,
  });

  await database.init(target);
  assert.equal(database.findCode('ABF-354').found, true);
  assert.throws(() => location.relocateDatabaseDirectory(source, target), /已经存在数据库/);
});
