export type ToolKind = "twitter" | "badnews" | "haijiao" | "missav" | "av123";
export type ViewName = "home" | "migration" | "sources" | "data" | "logs" | "settings" | `tool:${ToolKind}`;

export interface AppInfo {
  version: string;
  databasePath: string;
  recordCount: number;
}

export interface TableCount {
  name: string;
  rows: number;
}

export interface MigrationMapping {
  sourceTable: string;
  targetArea: string;
  recognized: boolean;
  rows: number;
  note: string;
}

export interface MigrationReport {
  sourcePath: string;
  integrityCheck: string;
  userVersion: number;
  journalMode: string;
  totalRows: number;
  tables: TableCount[];
  mappings: MigrationMapping[];
  warnings: string[];
}

export interface ResultInput {
  resultKey: string;
  primaryValue: string;
  secondaryValue?: string;
  status?: string;
  tags?: string[];
  error?: string;
  source?: string;
  metadata?: Record<string, unknown>;
}

export interface CreateRunInput {
  tool: ToolKind;
  name: string;
  inputKind: string;
  originalInput: string;
  startAt?: string;
  endAt?: string;
  options?: Record<string, unknown>;
  results: ResultInput[];
}

export interface RunSummary {
  id: number;
  tool: ToolKind;
  name: string;
  inputKind: string;
  status: string;
  totalCount: number;
  resultCount: number;
  errorCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface ContentResult {
  id: number;
  runId: number;
  tool: ToolKind;
  resultKey: string;
  primaryValue: string;
  secondaryValue: string;
  status: string;
  tags: string[];
  error: string;
  source: string;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface RunDetail extends RunSummary {
  originalInput: string;
  startAt: string;
  endAt: string;
  options: Record<string, unknown>;
  results: ContentResult[];
}

export interface SourceRecord {
  id: number;
  kind: string;
  externalId: string;
  name: string;
  sourceType: string;
  enabled: boolean;
  checkpoint: string;
  continuation: string;
  metadata: Record<string, unknown>;
  lastSyncAt: string;
  boundTools: ToolKind[];
}

export interface SourceInput extends Omit<SourceRecord, "id" | "lastSyncAt"> {
  id?: number;
}

export interface ReadInputFile {
  path: string;
  name: string;
  bytes: number;
  text: string;
  error: string;
}

export interface BackupInfo {
  path: string;
  name: string;
  bytes: number;
  modifiedAt: string;
}

export interface AppLogEntry {
  id: number;
  level: string;
  category: string;
  message: string;
  details: Record<string, unknown>;
  createdAt: string;
}

export interface HttpResponse {
  statusCode: number;
  body: string;
  finalUrl: string;
  headers: Record<string, string>;
  durationMs: number;
  responseBytes: number;
}

export interface PermanentRecord {
  id: number; tool: ToolKind; recordKey: string; primaryValue: string; secondaryValue: string;
  status: string; tags: string[]; actressTags: string[]; genreTags: string[]; sourceUrl: string;
  missavUrl: string; av123Url: string; raindropRemoteId: number | null; raindropCollectionId: number | null;
  metadata: Record<string, unknown>; createdAt: string; updatedAt: string;
}
export interface PermanentPage { data: PermanentRecord[]; page: number; pageSize: number; lastPage: number; total: number }
export interface ChromeBridgeInfo { pairingCode: string; extensionPath: string; available: boolean; error: string }
export interface LegacyMigrationResult { sourcePath: string; archivedTables: number; archivedRows: number; missavRecords: number; av123Records: number; historyRuns: number; telegramSources: number; backupPath: string }

export interface TelegramAuthState {
  status: "disconnected" | "expired" | "waiting_code" | "waiting_password" | "waiting_qr" | "ready" | string;
  configured: boolean;
  connected: boolean;
  accountKey: string;
  accountLabel: string;
  hint: string;
  qrUrl: string;
  qrExpiresAt: number;
}

export interface TelegramDialog {
  id: string;
  name: string;
  sourceType: "group" | "supergroup" | "channel" | string;
  username: string;
  latestMessageId: number;
  latestMessageDate: string;
}

export interface TelegramApiMessage { id: number; date: string; text: string }
export interface TelegramSyncResult { messages: TelegramApiMessage[]; checkpoint: number; hasMore: boolean }
