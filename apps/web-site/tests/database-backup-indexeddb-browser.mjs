import {
  BACKUP_CHECKPOINT_VERSION,
  BACKUP_JOB_ID,
  cloneBackupJob,
  commitBackupCheckpoint,
  inspectBackupStorage,
  loadBackupJob,
  loadBackupLines,
  makeBackupChunks,
  replaceBackupCheckpoint,
  selectIsolatedBackupPreviewDatabase,
} from "../lib/database-backup-indexeddb.ts";
import {
  DATABASE_BACKUP_INITIAL_DIGEST,
  backupManifestDigest,
  nextBackupDigest,
} from "../lib/database-backup-format.ts";

function assert(value, message) {
  if (!value) throw new Error(`IndexedDB regression failed: ${message}`);
}

function assertEqual(actual, expected, message) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`IndexedDB regression failed: ${message}; actual=${JSON.stringify(actual)} expected=${JSON.stringify(expected)}`);
  }
}

function sampleInventory(tables) {
  return {
    inspectedAt: "2026-08-24T00:00:00.000Z",
    source: { siteVersion: 26, candidateSiteVersion: 30, commit: "test", tree: "test", database: "temporary-preview-d1" },
    security: { telegramSession: "opaque-encrypted-ciphertext", decrypted: false, displayed: false },
    tableCount: 25,
    totalRows: 25,
    bookmark: "bookmark-00000001",
    queryCount: 2,
    tables,
  };
}

function sampleJob(inventory, overrides = {}) {
  return {
    id: BACKUP_JOB_ID,
    checkpointVersion: BACKUP_CHECKPOINT_VERSION,
    status: "paused",
    phase: "export",
    createdAt: "2026-08-24T00:00:00.000Z",
    inventory,
    tableIndex: 0,
    cursor: ["old-cursor"],
    sessionBookmark: inventory.bookmark,
    pageIndex: 7,
    currentRows: 7,
    currentDigest: "old-digest",
    manifests: [],
    sequence: 1,
    requestCount: 8,
    maxQueries: 2,
    exportedRows: 7,
    storedBytes: 0,
    error: "",
    ...overrides,
  };
}

export async function runIndexedDbRegression() {
  const inventoryResponse = await fetch("/api/database-backup?action=inventory", { cache: "no-store" });
  assert(inventoryResponse.ok, "inventory network request must succeed before forced transaction failure");
  const liveInventory = await inventoryResponse.json();
  assert(liveInventory.tableCount === 25, "live candidate inventory must contain 25 tables");
  const tables = liveInventory.tables.map((table) => ({
    ...table,
    rowCount: 1,
    primaryKey: [...table.primaryKey],
    columns: table.columns.map((column) => ({ ...column })),
  }));
  const inventory = sampleInventory(tables);
  const header = { type: "header", format: "browser-indexeddb-regression" };
  const headerBatch = makeBackupChunks(0, [header]);
  const base = sampleJob(inventory, { storedBytes: headerBatch.utf8Bytes });
  const progressRecord = { type: "page", table: tables[0].name, index: 7, rows: [{ id: "row-after-network" }] };
  const originalSnapshot = {
    cursor: [...base.cursor],
    pageIndex: base.pageIndex,
    currentDigest: base.currentDigest,
    sequence: base.sequence,
  };
  const previewBatch = makeBackupChunks(base.sequence, [progressRecord]);
  assertEqual(base.sequence, originalSnapshot.sequence, "makeBackupChunks must not mutate current job.sequence");
  const next = {
    ...cloneBackupJob(base),
    status: "running",
    cursor: ["next-cursor"],
    pageIndex: 8,
    currentRows: 8,
    currentDigest: "next-digest",
    sequence: previewBatch.nextSequence,
    storedBytes: base.storedBytes + previewBatch.utf8Bytes,
  };

  const failures = {};
  for (const fault of ["quota", "abort", "close", "error"]) {
    const databaseName = `tg-content-toolbox-v30-regression-page-${fault}-${Date.now().toString(36)}`;
    selectIsolatedBackupPreviewDatabase(databaseName);
    await replaceBackupCheckpoint(base, headerBatch.chunks);
    let failureName = "";
    try {
      await commitBackupCheckpoint(next, previewBatch.chunks, fault);
    } catch (error) {
      failureName = error instanceof Error ? error.name : "unknown";
    }
    assert(failureName, `${fault} must reject the transaction`);
    // Re-selecting and reopening the same isolated database models a page refresh:
    // only the last fully committed checkpoint may survive a new document.
    selectIsolatedBackupPreviewDatabase(databaseName);
    const durable = await loadBackupJob();
    assert(durable, `${fault} must preserve the old durable job`);
    assertEqual({
      cursor: durable.cursor,
      pageIndex: durable.pageIndex,
      currentDigest: durable.currentDigest,
      sequence: durable.sequence,
    }, originalSnapshot, `${fault} must preserve cursor, page, digest and sequence`);
    assertEqual(await loadBackupLines(), headerBatch.chunks.map((chunk) => chunk.line), `${fault} must not persist a partial page chunk`);

    await commitBackupCheckpoint(next, previewBatch.chunks);
    const retriedLines = await loadBackupLines();
    assert(retriedLines.filter((line) => line === previewBatch.chunks[0].line).length === 1, `${fault} retry must persist the page exactly once`);
    const retried = await loadBackupJob();
    assertEqual(retried?.cursor, ["next-cursor"], `${fault} retry must advance only after commit`);
    failures[fault] = failureName;
  }

  const manifests = await Promise.all(tables.map(async (table, index) => ({
    name: table.name,
    rowCount: 1,
    sha256: await nextBackupDigest(DATABASE_BACKUP_INITIAL_DIGEST, 0, [{ id: `row-${index}` }]),
    primaryKey: [...table.primaryKey],
  })));
  const footer = {
    type: "footer",
    complete: true,
    tableCount: 25,
    totalRows: 25,
    sha256: await backupManifestDigest(manifests),
    tables: manifests,
  };
  const finalizeBase = sampleJob(inventory, {
    status: "paused",
    phase: "finalize",
    cursor: null,
    pageIndex: 0,
    currentRows: 0,
    currentDigest: DATABASE_BACKUP_INITIAL_DIGEST,
    manifests,
    storedBytes: headerBatch.utf8Bytes,
  });
  const footerBatch = makeBackupChunks(finalizeBase.sequence, [footer]);
  const complete = {
    ...cloneBackupJob(finalizeBase),
    status: "complete",
    sequence: footerBatch.nextSequence,
    storedBytes: finalizeBase.storedBytes + footerBatch.utf8Bytes,
  };
  selectIsolatedBackupPreviewDatabase(`tg-content-toolbox-v30-regression-footer-${Date.now().toString(36)}`);
  await replaceBackupCheckpoint(finalizeBase, headerBatch.chunks);
  await commitBackupCheckpoint(complete, footerBatch.chunks, "abort").then(
    () => { throw new Error("footer abort must reject"); },
    () => undefined,
  );
  const afterFooterAbort = await loadBackupJob();
  assert(afterFooterAbort?.status !== "complete", "footer transaction failure must not display a durable complete job");
  assert((await loadBackupLines()).every((line) => !line.includes('"type":"footer"')), "footer transaction failure must not persist footer bytes");
  await commitBackupCheckpoint(complete, footerBatch.chunks);
  const afterFooterRetry = await loadBackupJob();
  const finalLines = await loadBackupLines();
  const stats = await inspectBackupStorage();
  assert(afterFooterRetry?.status === "complete", "footer retry must atomically persist complete state");
  assert(finalLines.filter((line) => line.includes('"type":"footer"')).length === 1, "footer must appear exactly once after retry");
  assert(afterFooterRetry.manifests.length === 25, "final checkpoint must retain all 25 table manifests");
  assert(afterFooterRetry.manifests.reduce((sum, table) => sum + table.rowCount, 0) === 25, "final 25-table row count must be correct");
  assert(stats.contiguous && stats.nextSequence === afterFooterRetry.sequence, "stored chunks must be contiguous through footer");

  return {
    liveTableCount: liveInventory.tableCount,
    failures,
    pageRetryChecks: Object.keys(failures).length,
    footerRetryOccurrences: finalLines.filter((line) => line.includes('"type":"footer"')).length,
    finalTableCount: afterFooterRetry.manifests.length,
    finalRowCount: afterFooterRetry.manifests.reduce((sum, table) => sum + table.rowCount, 0),
    finalManifestSha256: footer.sha256,
    storedBytes: stats.storedBytes,
  };
}
