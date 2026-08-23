export const SYNC_SCHEMA_VERSION: 1;
export const MAX_SYNC_BATCH_OPERATIONS: number;
export const MAX_SYNC_BATCH_BYTES: number;
export const SYNC_ENTITY_TYPES: readonly string[];
export function canonicalSourceKey(payload: Record<string, unknown>): string;

export type SyncAction = "upsert" | "delete";
export interface SyncOperation {
  schemaVersion: 1;
  operationId: string;
  nodeId: string;
  entityType: string;
  entityKey: string;
  action: SyncAction;
  restore: boolean;
  baseVersion: number;
  recordVersion: number;
  occurredAt: string;
  payload: Record<string, unknown> | null;
}

export function canonicalEntityKey(entityType: string, payload: Record<string, unknown>): string;
export function stableStringify(value: unknown): string;
export function assertNoSecrets(value: unknown, path?: string): void;
export function normalizeSyncOperation(input: unknown): SyncOperation;
export function validateSyncBatch(value: unknown, options?: { maxOperations?: number; maxBytes?: number }): { schemaVersion: 1; operations: SyncOperation[] };
export function maxCheckpoint(...values: unknown[]): string;
export function resolveSyncConflict(current: unknown, incoming: unknown): { decision: "incoming" | "current" | "merged" | "conflict"; operation: SyncOperation; reason: string };
export function partitionOperations(operations: unknown[], size?: number): SyncOperation[][];
