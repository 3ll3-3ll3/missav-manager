import { backupRecordLine, backupUtf8Bytes } from "./database-backup-format";

export type BackupValue = string | number | null;
export type BackupManifestEntry = {
  name: string; rowCount: number; sha256: string; primaryKey: string[];
};
export type BackupColumnInfo = { name: string; type: string; notnull: number; pk: number };
export type BackupInventoryTable = {
  name: string; rowCount: number; primaryKey: string[];
  columns: BackupColumnInfo[]; schemaSha256: string;
};
export type BackupInventory = {
  inspectedAt: string;
  source: { siteVersion: number; candidateSiteVersion: number; commit: string; tree: string; database: string };
  security: { telegramSession: string; decrypted: boolean; displayed: boolean };
  tableCount: number; totalRows: number; bookmark: string; queryCount: number;
  tables: BackupInventoryTable[];
};
export type BackupJob = {
  id: "active"; checkpointVersion: 2;
  status: "running" | "paused" | "complete" | "invalid";
  phase: "export" | "verify" | "finalize"; createdAt: string;
  inventory: BackupInventory; tableIndex: number; cursor: BackupValue[] | null;
  sessionBookmark: string;
  pageIndex: number; currentRows: number; currentDigest: string;
  manifests: BackupManifestEntry[]; sequence: number; requestCount: number;
  maxQueries: number; exportedRows: number; storedBytes: number; error: string;
  validationSha256?: string; validationQueryCount?: number;
};
export type BackupChunk = { id: string; jobId: "active"; sequence: number; line: string };
export type BackupChunkBatch = {
  chunks: BackupChunk[]; nextSequence: number; utf8Bytes: number;
};
export type BackupStorageFault = "quota" | "abort" | "close" | "error";

export const BACKUP_DATABASE_NAME = "tg-content-toolbox-v29-backup";
export const BACKUP_JOB_ID = "active" as const;
export const BACKUP_CHECKPOINT_VERSION = 2 as const;
export const BACKUP_WHOLE_FILE_MEMORY_LIMIT_BYTES = 128 * 1024 * 1024;

let databaseName = BACKUP_DATABASE_NAME;

export function selectIsolatedBackupPreviewDatabase(name: string) {
  if (typeof location === "undefined" || location.hostname !== "terminal.local") {
    throw new Error("IndexedDB 隔离测试库只允许在 Sites Agent Preview 使用");
  }
  if (!/^tg-content-toolbox-v30-regression-[a-z0-9-]+$/.test(name)) {
    throw new Error("IndexedDB 隔离测试库名称无效");
  }
  databaseName = name;
}

function requestValue<T>(request: IDBRequest<T>) {
  return new Promise<T>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("浏览器本地备份存储失败"));
  });
}

function transactionDone(transaction: IDBTransaction) {
  return new Promise<void>((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error ?? new Error("浏览器本地备份事务失败"));
    transaction.onabort = () => reject(transaction.error ?? new Error("浏览器本地备份事务中止"));
  });
}

async function openBackupDatabase() {
  const request = indexedDB.open(databaseName, 1);
  request.onupgradeneeded = () => {
    const database = request.result;
    if (!database.objectStoreNames.contains("jobs")) database.createObjectStore("jobs", { keyPath: "id" });
    if (!database.objectStoreNames.contains("chunks")) {
      const chunks = database.createObjectStore("chunks", { keyPath: "id" });
      chunks.createIndex("jobId", "jobId");
    }
  };
  return requestValue(request);
}

export function cloneBackupJob(job: BackupJob): BackupJob {
  return {
    ...job,
    cursor: job.cursor ? [...job.cursor] : null,
    inventory: {
      ...job.inventory,
      source: { ...job.inventory.source },
      security: { ...job.inventory.security },
      tables: job.inventory.tables.map((table) => ({
        ...table,
        primaryKey: [...table.primaryKey],
        columns: table.columns.map((column) => ({ ...column })),
      })),
    },
    manifests: job.manifests.map((manifest) => ({
      ...manifest, primaryKey: [...manifest.primaryKey],
    })),
  };
}

export function makeBackupChunks(sequence: number, records: unknown[]): BackupChunkBatch {
  let utf8Bytes = 0;
  const chunks = records.map((record, offset) => {
    const nextSequence = sequence + offset;
    const line = backupRecordLine(record);
    utf8Bytes += backupUtf8Bytes(line);
    return {
      id: `${BACKUP_JOB_ID}:${String(nextSequence).padStart(12, "0")}`,
      jobId: BACKUP_JOB_ID,
      sequence: nextSequence,
      line,
    } satisfies BackupChunk;
  });
  return { chunks, nextSequence: sequence + chunks.length, utf8Bytes };
}

async function injectFailure(
  transaction: IDBTransaction,
  done: Promise<void>,
  fault: BackupStorageFault | null,
) {
  if (!fault) return;
  transaction.abort();
  await done.catch(() => undefined);
  if (fault === "quota") throw new DOMException("模拟浏览器存储配额不足", "QuotaExceededError");
  if (fault === "error") throw new Error("模拟 IndexedDB 普通事务错误");
  throw new DOMException("模拟 IndexedDB 事务中止", "AbortError");
}

export async function commitBackupCheckpoint(
  nextJob: BackupJob,
  nextChunks: readonly BackupChunk[],
  injectedFault?: BackupStorageFault,
) {
  const database = await openBackupDatabase();
  try {
    const fault = injectedFault ?? null;
    if (fault === "close") {
      database.close();
      database.transaction(["jobs", "chunks"], "readwrite");
      throw new DOMException("模拟 IndexedDB 已关闭", "InvalidStateError");
    }
    const transaction = database.transaction(["jobs", "chunks"], "readwrite");
    const done = transactionDone(transaction);
    transaction.objectStore("jobs").put(nextJob);
    for (const chunk of nextChunks) transaction.objectStore("chunks").put(chunk);
    await injectFailure(transaction, done, fault);
    await done;
  } finally {
    database.close();
  }
}

export async function replaceBackupCheckpoint(
  nextJob: BackupJob,
  nextChunks: readonly BackupChunk[],
  injectedFault?: BackupStorageFault,
) {
  const database = await openBackupDatabase();
  try {
    const fault = injectedFault ?? null;
    if (fault === "close") {
      database.close();
      database.transaction(["jobs", "chunks"], "readwrite");
      throw new DOMException("模拟 IndexedDB 已关闭", "InvalidStateError");
    }
    const transaction = database.transaction(["jobs", "chunks"], "readwrite");
    const done = transactionDone(transaction);
    transaction.objectStore("chunks").clear();
    transaction.objectStore("jobs").put(nextJob);
    for (const chunk of nextChunks) transaction.objectStore("chunks").put(chunk);
    await injectFailure(transaction, done, fault);
    await done;
  } finally {
    database.close();
  }
}

export async function loadBackupJob() {
  const database = await openBackupDatabase();
  try {
    return await requestValue(database.transaction("jobs").objectStore("jobs").get(BACKUP_JOB_ID)) as BackupJob | undefined;
  } finally {
    database.close();
  }
}

export async function loadBackupLines() {
  const database = await openBackupDatabase();
  try {
    const chunks = await requestValue(
      database.transaction("chunks").objectStore("chunks").index("jobId").getAll(BACKUP_JOB_ID),
    ) as BackupChunk[];
    return chunks.sort((left, right) => left.sequence - right.sequence).map((chunk) => chunk.line);
  } finally {
    database.close();
  }
}

export async function inspectBackupStorage() {
  const database = await openBackupDatabase();
  try {
    const transaction = database.transaction("chunks");
    const request = transaction.objectStore("chunks").index("jobId").openCursor(IDBKeyRange.only(BACKUP_JOB_ID));
    return await new Promise<{ chunkCount: number; storedBytes: number; nextSequence: number; contiguous: boolean }>((resolve, reject) => {
      let chunkCount = 0;
      let storedBytes = 0;
      let expectedSequence = 0;
      let contiguous = true;
      request.onerror = () => reject(request.error ?? new Error("无法统计浏览器本地备份"));
      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor) {
          resolve({ chunkCount, storedBytes, nextSequence: expectedSequence, contiguous });
          return;
        }
        const chunk = cursor.value as BackupChunk;
        if (chunk.sequence !== expectedSequence) contiguous = false;
        expectedSequence = Math.max(expectedSequence, chunk.sequence + 1);
        chunkCount += 1;
        storedBytes += backupUtf8Bytes(chunk.line);
        cursor.continue();
      };
    });
  } finally {
    database.close();
  }
}

export async function clearBackupStorage() {
  const database = await openBackupDatabase();
  try {
    const transaction = database.transaction(["jobs", "chunks"], "readwrite");
    transaction.objectStore("jobs").clear();
    transaction.objectStore("chunks").clear();
    await transactionDone(transaction);
  } finally {
    database.close();
  }
}
