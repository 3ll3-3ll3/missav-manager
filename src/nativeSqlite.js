const { DatabaseSync } = require('node:sqlite');

function isQuerySql(sql) {
  return /^(?:SELECT|PRAGMA|EXPLAIN|WITH)\b/i.test(String(sql || '').trim());
}

function normalizeParams(params) {
  if (params === undefined || params === null) return [];
  return Array.isArray(params) ? params : [params];
}

class NativeStatementAdapter {
  constructor(statement, sql) {
    this.statement = statement;
    this.sql = String(sql || '');
    this.params = [];
    this.rows = null;
    this.index = 0;
    this.current = null;
    this.executed = false;
    this.query = isQuerySql(this.sql);
  }

  bind(params) {
    this.params = normalizeParams(params);
    this.rows = null;
    this.index = 0;
    this.current = null;
    this.executed = false;
    return true;
  }

  ensureExecuted() {
    if (this.executed) return;
    this.executed = true;
    if (this.query) {
      this.rows = this.statement.all(...this.params);
      return;
    }
    this.statement.run(...this.params);
    this.rows = [];
  }

  step() {
    this.ensureExecuted();
    if (!this.query || this.index >= this.rows.length) {
      this.current = null;
      return false;
    }
    this.current = this.rows[this.index++];
    return true;
  }

  getAsObject() {
    return this.current ? { ...this.current } : {};
  }

  get() {
    return this.current ? Object.values(this.current) : [];
  }

  getColumnNames() {
    if (typeof this.statement.columns === 'function') {
      return this.statement.columns().map(column => column.name);
    }
    this.ensureExecuted();
    const sample = this.current || this.rows?.[0];
    return sample ? Object.keys(sample) : [];
  }

  run(params) {
    if (params !== undefined) this.bind(params);
    this.ensureExecuted();
    return true;
  }

  free() {
    this.rows = null;
    this.current = null;
  }
}

class NativeSqliteDatabase {
  constructor(filePath, options = {}) {
    this.filePath = filePath;
    this.db = new DatabaseSync(filePath, {
      open: true,
      readOnly: options.readOnly === true,
      enableForeignKeyConstraints: options.readOnly !== true,
      timeout: Math.max(0, Number(options.timeout) || 5000),
    });
    if (!options.readOnly) this.configure();
  }

  configure() {
    this.db.exec('PRAGMA foreign_keys = ON');
    this.db.exec('PRAGMA busy_timeout = 5000');
    this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec('PRAGMA synchronous = FULL');
    this.db.exec('PRAGMA temp_store = MEMORY');
  }

  run(sql, params) {
    const values = normalizeParams(params);
    if (!values.length) {
      this.db.exec(String(sql || ''));
      return true;
    }
    this.db.prepare(String(sql || '')).run(...values);
    return true;
  }

  prepare(sql) {
    return new NativeStatementAdapter(this.db.prepare(String(sql || '')), sql);
  }

  checkpoint(mode = 'PASSIVE') {
    const normalized = ['PASSIVE', 'FULL', 'RESTART', 'TRUNCATE'].includes(String(mode).toUpperCase())
      ? String(mode).toUpperCase()
      : 'PASSIVE';
    this.db.exec(`PRAGMA wal_checkpoint(${normalized})`);
  }

  pragmaValue(name) {
    const key = String(name || '').replace(/[^A-Za-z0-9_]/g, '');
    if (!key) return null;
    return this.db.prepare(`PRAGMA ${key}`).get();
  }

  close() {
    this.db.close();
  }
}

module.exports = {
  NativeSqliteDatabase,
  NativeStatementAdapter,
  isQuerySql,
};
