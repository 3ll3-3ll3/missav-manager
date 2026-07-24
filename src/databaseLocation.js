const fs = require('fs');
const path = require('path');
const { NativeSqliteDatabase } = require('./nativeSqlite');

const CONFIG_FILE = 'database-location.json';
const DATABASE_FILE = 'missav_data.db';

function configPath(userDataDirectory) {
  return path.join(path.resolve(userDataDirectory), 'config', CONFIG_FILE);
}

function defaultDatabaseDirectory(userDataDirectory) {
  return path.join(path.resolve(userDataDirectory), 'data');
}

function readDatabaseDirectory(userDataDirectory) {
  const fallback = defaultDatabaseDirectory(userDataDirectory);
  const filePath = configPath(userDataDirectory);
  if (!fs.existsSync(filePath)) return { directory: fallback, configured: false };
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    const rawDirectory = String(parsed.directory || '').trim();
    if (!rawDirectory) throw new Error('目录为空');
    const directory = path.resolve(rawDirectory);
    return { directory, configured: true };
  } catch {
    return { directory: fallback, configured: false };
  }
}

function writeDatabaseDirectory(userDataDirectory, directory) {
  const filePath = configPath(userDataDirectory);
  const rawDirectory = String(directory || '').trim();
  if (!rawDirectory) throw new Error('数据库目录不能为空');
  const resolved = path.resolve(rawDirectory);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify({
    directory: resolved,
    updatedAt: new Date().toISOString(),
  }, null, 2), 'utf8');
  if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  fs.renameSync(tempPath, filePath);
  return resolved;
}

function validateDatabaseFile(filePath) {
  let validation = null;
  try {
    validation = new NativeSqliteDatabase(filePath, { readOnly: true });
    const integrity = validation.db.prepare('PRAGMA integrity_check').get();
    const result = integrity ? String(Object.values(integrity)[0] || '') : '';
    if (result !== 'ok') throw new Error(`数据库完整性检查失败：${result || 'unknown'}`);
    const codes = validation.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'codes'").get();
    if (!codes) throw new Error('目标数据库缺少番号主表');
  } finally {
    if (validation) validation.close();
  }
}

function relocateDatabaseDirectory(sourceDirectory, targetDirectory) {
  const rawSource = String(sourceDirectory || '').trim();
  const rawTarget = String(targetDirectory || '').trim();
  if (!rawSource || !rawTarget) throw new Error('数据库源目录和目标目录不能为空');
  const source = path.resolve(rawSource);
  const target = path.resolve(rawTarget);
  if (source === target) return { changed: false, source, target };

  const sourceDb = path.join(source, DATABASE_FILE);
  const targetDb = path.join(target, DATABASE_FILE);
  if (!fs.existsSync(sourceDb)) throw new Error('当前数据库文件不存在，无法迁移');
  fs.mkdirSync(target, { recursive: true });
  if (fs.existsSync(targetDb)) throw new Error('目标目录已经存在数据库，请选择一个空目录');

  const temporaryDb = `${targetDb}.migrating`;
  try {
    if (fs.existsSync(temporaryDb)) fs.unlinkSync(temporaryDb);
    fs.copyFileSync(sourceDb, temporaryDb);
    validateDatabaseFile(temporaryDb);
    fs.renameSync(temporaryDb, targetDb);

    for (const fileName of ['.native-sqlite-v3.json']) {
      const sourceFile = path.join(source, fileName);
      const targetFile = path.join(target, fileName);
      if (fs.existsSync(sourceFile) && !fs.existsSync(targetFile)) fs.copyFileSync(sourceFile, targetFile);
    }
    const sourceBackups = path.join(source, 'backups');
    const targetBackups = path.join(target, 'backups');
    if (fs.existsSync(sourceBackups) && !fs.existsSync(targetBackups)) {
      fs.cpSync(sourceBackups, targetBackups, { recursive: true, errorOnExist: true });
    }
    return {
      changed: true,
      source,
      target,
      databasePath: targetDb,
      bytes: fs.statSync(targetDb).size,
    };
  } catch (error) {
    if (fs.existsSync(temporaryDb)) fs.unlinkSync(temporaryDb);
    if (fs.existsSync(targetDb)) {
      try { fs.unlinkSync(targetDb); } catch {}
    }
    throw error;
  }
}

module.exports = {
  CONFIG_FILE,
  DATABASE_FILE,
  configPath,
  defaultDatabaseDirectory,
  readDatabaseDirectory,
  writeDatabaseDirectory,
  validateDatabaseFile,
  relocateDatabaseDirectory,
};
