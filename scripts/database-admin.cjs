const fs = require('fs');
const path = require('path');
const initSqlJs = require('sql.js');
const database = require('../src/database');

const [, , command = 'inspect', dataDirArg = '', ...rest] = process.argv;
const dataDir = path.resolve(String(dataDirArg || ''));
const dbPath = path.join(dataDir, 'missav_data.db');
const confirmArg = rest.find(arg => arg.startsWith('--confirm='));
const confirmText = confirmArg ? confirmArg.slice('--confirm='.length) : '';

function fail(message) {
  console.error(message);
  process.exitCode = 1;
}

async function inspect() {
  if (!dataDirArg) return fail('用法：node scripts/database-admin.cjs inspect <data目录>');
  if (!fs.existsSync(dbPath)) return fail(`数据库不存在：${dbPath}`);
  const SQL = await initSqlJs();
  const db = new SQL.Database(fs.readFileSync(dbPath));
  try {
    const tableResult = db.exec("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name");
    const tableNames = (tableResult[0]?.values || []).map(row => row[0]);
    const tables = {};
    for (const table of tableNames) {
      const safe = String(table).replace(/"/g, '""');
      tables[table] = Number(db.exec(`SELECT COUNT(*) FROM "${safe}"`)[0]?.values?.[0]?.[0] || 0);
    }
    const integrity = db.exec('PRAGMA integrity_check')[0]?.values?.[0]?.[0] || 'unknown';
    console.log(JSON.stringify({
      path: dbPath,
      size: fs.statSync(dbPath).size,
      integrity,
      totalRows: Object.values(tables).reduce((sum, count) => sum + count, 0),
      tables,
    }, null, 2));
  } finally {
    db.close();
  }
}

async function reset() {
  if (!dataDirArg) return fail('用法：node scripts/database-admin.cjs reset <data目录> --confirm=清空全部数据');
  if (!fs.existsSync(dbPath)) return fail(`数据库不存在：${dbPath}`);
  if (confirmText !== '清空全部数据') return fail('拒绝执行：必须传入 --confirm=清空全部数据');
  await database.init(dataDir);
  try {
    const result = database.resetAllBusinessData({
      confirmText,
      backupLabel: '正式启用前完整备份',
    });
    console.log(JSON.stringify(result, null, 2));
  } finally {
    database.close();
  }
}

if (command === 'inspect') {
  inspect().catch(error => fail(error.stack || error.message));
} else if (command === 'reset') {
  reset().catch(error => fail(error.stack || error.message));
} else {
  fail(`未知命令：${command}；只支持 inspect 或 reset`);
}
