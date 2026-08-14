const PERSONAL_SESSION_LEASE_KEY =
  "__internal.telegram.personal-session-lease";
const DEFAULT_LEASE_TTL_MS = 2 * 60 * 1000;

type LeaseRunResult = {
  success?: boolean;
  meta?: { changes?: number };
};

type LeasePreparedStatement = {
  bind: (...values: unknown[]) => LeasePreparedStatement;
  run: () => Promise<LeaseRunResult>;
  first: <T = Record<string, unknown>>() => Promise<T | null>;
};

export type PersonalSessionLeaseDatabase = {
  prepare: (sql: string) => LeasePreparedStatement;
};

type LeasePayload = {
  ownerId: string;
  operation: string;
  acquiredAt: string;
};

export type PersonalSessionLeaseStatus = {
  active: boolean;
  operation: string;
  acquiredAt: string;
  expiresAt: string;
  remainingMs: number;
};

export class PersonalSessionLeaseBusyError extends Error {
  readonly code = "TELEGRAM_SESSION_BUSY";

  constructor(status: PersonalSessionLeaseStatus) {
    const operation = status.operation || "上一项个人账号操作";
    const seconds = Math.max(1, Math.ceil(status.remainingMs / 1000));
    super(
      `Telegram 个人账号正在执行「${operation}」，请等待安全收尾后再重试（预计不超过 ${seconds} 秒）；系统已阻止重复连接。`,
    );
    this.name = "PersonalSessionLeaseBusyError";
  }
}

function parsePayload(value: unknown): LeasePayload | null {
  try {
    const parsed = JSON.parse(String(value || "")) as Partial<LeasePayload>;
    if (!parsed || typeof parsed !== "object") return null;
    return {
      ownerId: String(parsed.ownerId || ""),
      operation: String(parsed.operation || "").slice(0, 120),
      acquiredAt: String(parsed.acquiredAt || ""),
    };
  } catch {
    return null;
  }
}

function leaseStatusFromRow(
  row: { value_json?: unknown; updated_at?: unknown } | null,
  nowMs: number,
): PersonalSessionLeaseStatus {
  const expiresAt = String(row?.updated_at || "");
  const expiresMs = Date.parse(expiresAt);
  const payload = parsePayload(row?.value_json);
  const active = Boolean(
    row && Number.isFinite(expiresMs) && expiresMs > nowMs,
  );
  return {
    active,
    operation: active ? String(payload?.operation || "") : "",
    acquiredAt: active ? String(payload?.acquiredAt || "") : "",
    expiresAt: active ? expiresAt : "",
    remainingMs: active ? Math.max(0, expiresMs - nowMs) : 0,
  };
}

async function leaseRow(database: PersonalSessionLeaseDatabase) {
  return database
    .prepare(
      "SELECT value_json,updated_at FROM app_settings WHERE key=?",
    )
    .bind(PERSONAL_SESSION_LEASE_KEY)
    .first<{ value_json: string; updated_at: string }>();
}

export async function personalSessionLeaseStatus(
  database: PersonalSessionLeaseDatabase,
  nowMs = Date.now(),
) {
  return leaseStatusFromRow(await leaseRow(database), nowMs);
}

export type PersonalSessionLeaseHandle = {
  ownerId: string;
  operation: string;
  acquiredAt: string;
  expiresAt: string;
  renew: (nowMs?: number) => Promise<boolean>;
  release: () => Promise<boolean>;
};

export async function acquirePersonalSessionLease(
  database: PersonalSessionLeaseDatabase,
  operationValue: string,
  options: { nowMs?: number; ttlMs?: number; ownerId?: string } = {},
): Promise<PersonalSessionLeaseHandle> {
  const nowMs = options.nowMs ?? Date.now();
  const ttlMs = Math.max(30_000, options.ttlMs ?? DEFAULT_LEASE_TTL_MS);
  const ownerId = options.ownerId || crypto.randomUUID();
  const operation = String(operationValue || "个人账号操作").slice(0, 120);
  const acquiredAt = new Date(nowMs).toISOString();
  let expiresAt = new Date(nowMs + ttlMs).toISOString();
  const payload = JSON.stringify({ ownerId, operation, acquiredAt });
  const result = await database
    .prepare(
      `INSERT INTO app_settings(key,value_json,updated_at) VALUES (?,?,?)
       ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json,updated_at=excluded.updated_at
       WHERE app_settings.updated_at<=?`,
    )
    .bind(
      PERSONAL_SESSION_LEASE_KEY,
      payload,
      expiresAt,
      acquiredAt,
    )
    .run();
  const changed = Number(result.meta?.changes ?? Number.NaN);
  const current = await leaseRow(database);
  const acquired =
    changed === 1 || String(current?.value_json || "") === payload;
  if (!acquired) {
    throw new PersonalSessionLeaseBusyError(
      leaseStatusFromRow(current, nowMs),
    );
  }

  return {
    ownerId,
    operation,
    acquiredAt,
    get expiresAt() {
      return expiresAt;
    },
    async renew(renewedAt = Date.now()) {
      const nextExpiry = new Date(renewedAt + ttlMs).toISOString();
      const renewed = await database
        .prepare(
          "UPDATE app_settings SET updated_at=? WHERE key=? AND value_json=?",
        )
        .bind(nextExpiry, PERSONAL_SESSION_LEASE_KEY, payload)
        .run();
      const success = Number(renewed.meta?.changes ?? 0) === 1;
      if (success) expiresAt = nextExpiry;
      return success;
    },
    async release() {
      const released = await database
        .prepare("DELETE FROM app_settings WHERE key=? AND value_json=?")
        .bind(PERSONAL_SESSION_LEASE_KEY, payload)
        .run();
      return Number(released.meta?.changes ?? 0) === 1;
    },
  };
}
