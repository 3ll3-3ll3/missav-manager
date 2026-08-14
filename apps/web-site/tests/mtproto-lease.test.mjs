import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { loadModule } from "./helpers/bundle.mjs";

const leaseModule = await loadModule("lib/mtproto-lease.ts");

class TestStatement {
  constructor(database, sql) {
    this.statement = database.prepare(sql);
    this.values = [];
  }

  bind(...values) {
    this.values = values;
    return this;
  }

  async run() {
    const result = this.statement.run(...this.values);
    return { success: true, meta: { changes: Number(result.changes) } };
  }

  async first() {
    return this.statement.get(...this.values) ?? null;
  }
}

class TestD1Database {
  constructor(database) {
    this.database = database;
  }

  prepare(sql) {
    return new TestStatement(this.database, sql);
  }
}

function leaseDatabase() {
  const database = new DatabaseSync(":memory:");
  database.exec(
    "CREATE TABLE app_settings(key TEXT PRIMARY KEY,value_json TEXT NOT NULL,updated_at TEXT NOT NULL)",
  );
  return { database, d1: new TestD1Database(database) };
}

test("个人 Session 租约原子阻止第二个 Worker 同时连接", async () => {
  const { database, d1 } = leaseDatabase();
  const now = Date.parse("2026-08-14T00:00:00.000Z");
  const first = await leaseModule.acquirePersonalSessionLease(
    d1,
    "同步 Telegram 来源",
    { nowMs: now, ttlMs: 60_000, ownerId: "worker-a" },
  );

  await assert.rejects(
    () =>
      leaseModule.acquirePersonalSessionLease(d1, "发现群组/频道", {
        nowMs: now + 100,
        ttlMs: 60_000,
        ownerId: "worker-b",
      }),
    (error) => {
      assert.equal(error.code, "TELEGRAM_SESSION_BUSY");
      assert.match(error.message, /正在执行.*同步 Telegram 来源/);
      assert.match(error.message, /阻止重复连接/);
      return true;
    },
  );

  const active = await leaseModule.personalSessionLeaseStatus(d1, now + 100);
  assert.equal(active.active, true);
  assert.equal(active.operation, "同步 Telegram 来源");
  assert.equal(await first.release(), true);
  assert.equal(
    (await leaseModule.personalSessionLeaseStatus(d1, now + 100)).active,
    false,
  );
  database.close();
});

test("过期租约可恢复，旧 Worker 不能释放新 Worker 的租约", async () => {
  const { database, d1 } = leaseDatabase();
  const now = Date.parse("2026-08-14T00:00:00.000Z");
  const first = await leaseModule.acquirePersonalSessionLease(d1, "旧同步", {
    nowMs: now,
    ttlMs: 30_000,
    ownerId: "worker-old",
  });
  const second = await leaseModule.acquirePersonalSessionLease(d1, "断点续传", {
    nowMs: now + 30_001,
    ttlMs: 60_000,
    ownerId: "worker-new",
  });

  assert.equal(await first.release(), false);
  const status = await leaseModule.personalSessionLeaseStatus(d1, now + 30_002);
  assert.equal(status.active, true);
  assert.equal(status.operation, "断点续传");
  assert.equal(await second.renew(now + 40_000), true);
  assert.equal(await second.release(), true);
  database.close();
});

test("同一时刻竞争租约只有一个请求成功", async () => {
  const { database, d1 } = leaseDatabase();
  const now = Date.parse("2026-08-14T00:00:00.000Z");
  const attempts = await Promise.allSettled([
    leaseModule.acquirePersonalSessionLease(d1, "工具页同步", {
      nowMs: now,
      ownerId: "worker-1",
    }),
    leaseModule.acquirePersonalSessionLease(d1, "全局来源刷新", {
      nowMs: now,
      ownerId: "worker-2",
    }),
  ]);
  assert.equal(
    attempts.filter((result) => result.status === "fulfilled").length,
    1,
  );
  assert.equal(
    attempts.filter((result) => result.status === "rejected").length,
    1,
  );
  const winner = attempts.find((result) => result.status === "fulfilled");
  await winner.value.release();
  database.close();
});
