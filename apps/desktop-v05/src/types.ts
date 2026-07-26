export type ViewName = "home" | "grid" | "tasks" | "migration";

export interface PrototypeInfo {
  version: string;
  databasePath: string;
  recordCount: number;
  recoveredTasks: number;
}

export interface PrototypeRecord {
  id: number;
  code: string;
  source: string;
  status: string;
  tags: string;
  notes: string;
  createdAt: string;
  updatedAt: string;
}

export interface RecordPage {
  data: PrototypeRecord[];
  page: number;
  pageSize: number;
  lastPage: number;
  total: number;
}

export interface TaskSummary {
  id: number;
  kind: string;
  status: "pending" | "running" | "paused" | "completed" | "cancelled";
  total: number;
  completed: number;
  failed: number;
  message: string;
  createdAt: string;
  updatedAt: string;
}

export interface TaskProgress {
  task: TaskSummary;
  currentItem: string | null;
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
