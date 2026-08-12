import { getD1 } from "../db";
import { redact, safeJson } from "./security";

const nowIso = () => new Date().toISOString();

export async function writeLog(
  level: "info" | "warning" | "error",
  category: string,
  message: unknown,
  detail: unknown = {},
) {
  const timestamp = nowIso();
  await getD1()
    .prepare(
      "INSERT INTO app_logs(id,level,category,message,detail_json,created_at) VALUES (?,?,?,?,?,?)",
    )
    .bind(
      crypto.randomUUID(),
      level,
      redact(category).slice(0, 80),
      redact(message),
      redact(safeJson(detail, {})),
      timestamp,
    )
    .run();
}

/**
 * Persist an already-sanitized operational failure and mirror the same safe
 * envelope to Worker observability. D1 and Worker logs are deliberately
 * independent so a database write failure cannot erase the only diagnostic.
 */
export async function writeErrorLog(
  category: string,
  message: unknown,
  detail: unknown = {},
) {
  const safeCategory = redact(category).slice(0, 80);
  const safeMessage = redact(message);
  const safeDetail = redact(safeJson(detail, {}));
  const timestamp = nowIso();
  let persisted = true;
  try {
    await getD1()
      .prepare(
        "INSERT INTO app_logs(id,level,category,message,detail_json,created_at) VALUES (?,?,?,?,?,?)",
      )
      .bind(
        crypto.randomUUID(),
        "error",
        safeCategory,
        safeMessage,
        safeDetail,
        timestamp,
      )
      .run();
  } catch (error) {
    persisted = false;
    console.error(JSON.stringify({
      level: "error",
      category: safeCategory,
      message: "应用错误日志写入 D1 失败",
      detail: redact(error instanceof Error ? error.message : error),
      timestamp,
    }));
  }
  console.error(JSON.stringify({
    level: "error",
    category: safeCategory,
    message: safeMessage,
    detail: safeDetail,
    persisted,
    timestamp,
  }));
  return { persisted, timestamp };
}

export async function listLogs(input: {
  page?: number;
  pageSize?: number;
  level?: string;
  search?: string;
}) {
  const page = Math.max(1, Math.trunc(Number(input.page) || 1));
  const pageSize = Math.min(
    200,
    Math.max(20, Math.trunc(Number(input.pageSize) || 50)),
  );
  const clauses: string[] = [];
  const values: unknown[] = [];
  if (input.level) {
    clauses.push("level=?");
    values.push(String(input.level).slice(0, 20));
  }
  if (input.search?.trim()) {
    clauses.push("(message LIKE ? OR category LIKE ?)");
    const like = `%${input.search.trim().slice(0, 160)}%`;
    values.push(like, like);
  }
  const where = clauses.length ? ` WHERE ${clauses.join(" AND ")}` : "";
  const [count, rows] = await getD1().batch([
    getD1()
      .prepare(`SELECT COUNT(*) AS count FROM app_logs${where}`)
      .bind(...values),
    getD1()
      .prepare(
        `SELECT * FROM app_logs${where} ORDER BY created_at DESC,id DESC LIMIT ? OFFSET ?`,
      )
      .bind(...values, pageSize, (page - 1) * pageSize),
  ]);
  return {
    rows: rows.results ?? [],
    total: Number(count.results?.[0]?.count ?? 0),
    page,
    pageSize,
  };
}

export async function createRecordSnapshot(
  ids: string[],
  reason: string,
  full = false,
) {
  const uniqueIds = [...new Set(ids.map(String).filter(Boolean))];
  const snapshotId = crypto.randomUUID();
  const timestamp = nowIso();
  await getD1()
    .prepare(
      "INSERT INTO data_snapshots(id,reason,entity,item_count,status,created_at,restored_at) VALUES (?,?,?,?,?,?,?)",
    )
    .bind(
      snapshotId,
      reason.slice(0, 240),
      full ? "permanent_records_full" : "permanent_records",
      uniqueIds.length,
      "building",
      timestamp,
      "",
    )
    .run();
  let inserted = 0;
  for (let offset = 0; offset < uniqueIds.length; offset += 80) {
    const chunk = uniqueIds.slice(offset, offset + 80);
    const rows = await getD1()
      .prepare(
        `SELECT * FROM permanent_records WHERE id IN (${chunk.map(() => "?").join(",")})`,
      )
      .bind(...chunk)
      .all();
    const statements = (rows.results ?? []).map((row) =>
      getD1()
        .prepare(
          "INSERT INTO data_snapshot_items(snapshot_id,entity_key,previous_json) VALUES (?,?,?)",
        )
        .bind(snapshotId, String(row.id), safeJson(row, {})),
    );
    if (statements.length) {
      await getD1().batch(statements);
      inserted += statements.length;
    }
  }
  await getD1()
    .prepare("UPDATE data_snapshots SET item_count=?,status='ready' WHERE id=?")
    .bind(inserted, snapshotId)
    .run();
  return snapshotId;
}

export async function createRunSnapshot(runId: string, reason: string) {
  const [run, results] = await getD1().batch([
    getD1().prepare("SELECT * FROM content_runs WHERE id=?").bind(runId),
    getD1()
      .prepare("SELECT * FROM content_results WHERE run_id=? ORDER BY id")
      .bind(runId),
  ]);
  if (!run.results?.[0]) throw new Error("历史不存在");
  const snapshotId = crypto.randomUUID();
  const timestamp = nowIso();
  await getD1().batch([
    getD1()
      .prepare(
        "INSERT INTO data_snapshots(id,reason,entity,item_count,status,created_at,restored_at) VALUES (?,?,?,?,?,?,?)",
      )
      .bind(
        snapshotId,
        reason.slice(0, 240),
        "content_runs",
        1 + (results.results?.length ?? 0),
        "ready",
        timestamp,
        "",
      ),
    getD1()
      .prepare(
        "INSERT INTO data_snapshot_items(snapshot_id,entity_key,previous_json) VALUES (?,?,?)",
      )
      .bind(snapshotId, `run:${runId}`, safeJson(run.results[0], {})),
    ...(results.results ?? []).map((row) =>
      getD1()
        .prepare(
          "INSERT INTO data_snapshot_items(snapshot_id,entity_key,previous_json) VALUES (?,?,?)",
        )
        .bind(snapshotId, `result:${String(row.id)}`, safeJson(row, {})),
    ),
  ]);
  return snapshotId;
}

export async function createSettingsSnapshot(keys: string[], reason: string) {
  const unique = [...new Set(keys.map(String).filter(Boolean))];
  const snapshotId = crypto.randomUUID();
  const timestamp = nowIso();
  const rows = unique.length
    ? await getD1()
        .prepare(
          `SELECT * FROM app_settings WHERE key IN (${unique.map(() => "?").join(",")})`,
        )
        .bind(...unique)
        .all()
    : { results: [] };
  const byKey = new Map(
    (rows.results ?? []).map((row) => [String(row.key), row]),
  );
  await getD1().batch([
    getD1()
      .prepare(
        "INSERT INTO data_snapshots(id,reason,entity,item_count,status,created_at,restored_at) VALUES (?,?,?,?,?,?,?)",
      )
      .bind(
        snapshotId,
        reason.slice(0, 240),
        "app_settings",
        unique.length,
        "ready",
        timestamp,
        "",
      ),
    ...unique.map((key) =>
      getD1()
        .prepare(
          "INSERT INTO data_snapshot_items(snapshot_id,entity_key,previous_json) VALUES (?,?,?)",
        )
        .bind(
          snapshotId,
          key,
          safeJson(byKey.get(key) ?? { key, missing: true }, {}),
        ),
    ),
  ]);
  return snapshotId;
}

export async function listSnapshots(limit = 50) {
  const rows = await getD1()
    .prepare("SELECT * FROM data_snapshots ORDER BY created_at DESC LIMIT ?")
    .bind(Math.min(100, Math.max(1, limit)))
    .all();
  return rows.results ?? [];
}

function recordUpsert(row: Record<string, unknown>) {
  return getD1()
    .prepare(
      `INSERT INTO permanent_records
    (id,tool,record_key,primary_value,secondary_value,status,tags_json,actress_tags_json,genre_tags_json,source_url,missav_url,av123_url,metadata_json,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(tool,record_key) DO UPDATE SET primary_value=excluded.primary_value,secondary_value=excluded.secondary_value,
      status=excluded.status,tags_json=excluded.tags_json,actress_tags_json=excluded.actress_tags_json,genre_tags_json=excluded.genre_tags_json,
      source_url=excluded.source_url,missav_url=excluded.missav_url,av123_url=excluded.av123_url,metadata_json=excluded.metadata_json,updated_at=excluded.updated_at`,
    )
    .bind(
      row.id,
      row.tool,
      row.record_key,
      row.primary_value,
      row.secondary_value,
      row.status,
      row.tags_json,
      row.actress_tags_json,
      row.genre_tags_json,
      row.source_url,
      row.missav_url,
      row.av123_url,
      row.metadata_json,
      row.created_at,
      row.updated_at,
    );
}

export async function restoreSnapshot(snapshotId: string) {
  const snapshot = await getD1()
    .prepare("SELECT * FROM data_snapshots WHERE id=?")
    .bind(snapshotId)
    .first();
  if (!snapshot || snapshot.status !== "ready")
    throw new Error("恢复点不存在或已使用");
  const items = await getD1()
    .prepare(
      "SELECT * FROM data_snapshot_items WHERE snapshot_id=? ORDER BY id",
    )
    .bind(snapshotId)
    .all();
  const parsed = (items.results ?? []).map((item) => ({
    key: String(item.entity_key),
    row: JSON.parse(String(item.previous_json)) as Record<string, unknown>,
  }));
  if (
    snapshot.entity === "permanent_records" ||
    snapshot.entity === "permanent_records_full"
  ) {
    if (snapshot.entity === "permanent_records_full")
      await getD1().prepare("DELETE FROM permanent_records").run();
    for (let offset = 0; offset < parsed.length; offset += 80)
      await getD1().batch(
        parsed.slice(offset, offset + 80).map((item) => recordUpsert(item.row)),
      );
  } else if (snapshot.entity === "content_runs") {
    const run = parsed.find((item) => item.key.startsWith("run:"))?.row;
    if (!run) throw new Error("恢复点缺少历史主体");
    const statements = [
      getD1()
        .prepare(
          `INSERT OR REPLACE INTO content_runs
      (id,tool,name,input_kind,start_at,end_at,source_summary,total_count,result_count,error_count,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
        )
        .bind(
          run.id,
          run.tool,
          run.name,
          run.input_kind,
          run.start_at,
          run.end_at,
          run.source_summary,
          run.total_count,
          run.result_count,
          run.error_count,
          run.created_at,
          run.updated_at,
        ),
      ...parsed
        .filter((item) => item.key.startsWith("result:"))
        .map((item) => {
          const row = item.row;
          return getD1()
            .prepare(
              `INSERT OR REPLACE INTO content_results
        (id,run_id,tool,result_key,primary_value,secondary_value,status,tags_json,source,metadata_json,created_at,updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
            )
            .bind(
              row.id,
              row.run_id,
              row.tool,
              row.result_key,
              row.primary_value,
              row.secondary_value,
              row.status,
              row.tags_json,
              row.source,
              row.metadata_json,
              row.created_at,
              row.updated_at,
            );
        }),
    ];
    for (let offset = 0; offset < statements.length; offset += 80)
      await getD1().batch(statements.slice(offset, offset + 80));
  } else if (snapshot.entity === "app_settings") {
    const statements = parsed.map((item) =>
      item.row.missing
        ? getD1().prepare("DELETE FROM app_settings WHERE key=?").bind(item.key)
        : getD1()
            .prepare(
              `INSERT INTO app_settings(key,value_json,updated_at) VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json,updated_at=excluded.updated_at`,
            )
            .bind(item.row.key, item.row.value_json, item.row.updated_at),
    );
    if (statements.length) await getD1().batch(statements);
  } else throw new Error("暂不支持该恢复点类型");
  const restoredAt = nowIso();
  await getD1()
    .prepare(
      "UPDATE data_snapshots SET status='restored',restored_at=? WHERE id=?",
    )
    .bind(restoredAt, snapshotId)
    .run();
  await writeLog(
    "warning",
    "snapshot",
    `已恢复 ${String(snapshot.entity)} 恢复点`,
    { snapshotId, items: parsed.length },
  );
  return { restored: parsed.length };
}

export async function listTasks(input: {
  page?: number;
  pageSize?: number;
  stage?: string;
  tool?: string;
  search?: string;
}) {
  const page = Math.max(1, Math.trunc(Number(input.page) || 1));
  const pageSize = Math.min(
    200,
    Math.max(20, Math.trunc(Number(input.pageSize) || 50)),
  );
  const clauses: string[] = [];
  const values: unknown[] = [];
  if (input.stage) {
    clauses.push("stage=?");
    values.push(String(input.stage).slice(0, 32));
  }
  if (input.tool) {
    clauses.push("tool=?");
    values.push(String(input.tool).slice(0, 32));
  }
  if (input.search?.trim()) {
    clauses.push("title LIKE ?");
    values.push(`%${input.search.trim().slice(0, 160)}%`);
  }
  const where = clauses.length ? ` WHERE ${clauses.join(" AND ")}` : "";
  const [count, rows] = await getD1().batch([
    getD1()
      .prepare(`SELECT COUNT(*) AS count FROM task_inbox${where}`)
      .bind(...values),
    getD1()
      .prepare(
        `SELECT * FROM task_inbox${where} ORDER BY updated_at DESC,id DESC LIMIT ? OFFSET ?`,
      )
      .bind(...values, pageSize, (page - 1) * pageSize),
  ]);
  return {
    rows: rows.results ?? [],
    total: Number(count.results?.[0]?.count ?? 0),
    page,
    pageSize,
  };
}

export async function updateTasks(ids: string[], stage: string) {
  const valid = new Set([
    "new",
    "filtered",
    "website",
    "review",
    "error",
    "completed",
  ]);
  if (!valid.has(stage)) throw new Error("任务阶段无效");
  const unique = [...new Set(ids.map(String).filter(Boolean))];
  let changed = 0;
  for (let offset = 0; offset < unique.length; offset += 80) {
    const chunk = unique.slice(offset, offset + 80);
    const result = await getD1()
      .prepare(
        `UPDATE task_inbox SET stage=?,updated_at=? WHERE id IN (${chunk.map(() => "?").join(",")})`,
      )
      .bind(stage, nowIso(), ...chunk)
      .run();
    changed += Number(result.meta?.changes ?? 0);
  }
  return { changed };
}
