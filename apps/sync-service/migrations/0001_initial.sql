CREATE TABLE IF NOT EXISTS sync_devices (
  id TEXT PRIMARY KEY,
  node_id TEXT NOT NULL UNIQUE,
  label TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'active',
  scopes_json TEXT NOT NULL DEFAULT '["sync:read","sync:write","lease"]',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL DEFAULT '',
  revoked_at TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS sync_pairing_codes (
  id TEXT PRIMARY KEY,
  code_hash TEXT NOT NULL UNIQUE,
  label TEXT NOT NULL DEFAULT '',
  expires_at TEXT NOT NULL,
  used_at TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_sync_pairing_codes_expires
ON sync_pairing_codes(expires_at, used_at);

CREATE TABLE IF NOT EXISTS sync_entities (
  entity_type TEXT NOT NULL,
  entity_key TEXT NOT NULL,
  record_version INTEGER NOT NULL,
  tombstone INTEGER NOT NULL DEFAULT 0,
  payload_json TEXT NOT NULL DEFAULT '',
  origin_node_id TEXT NOT NULL,
  last_operation_id TEXT NOT NULL UNIQUE,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(entity_type, entity_key)
);

CREATE INDEX IF NOT EXISTS idx_sync_entities_updated
ON sync_entities(updated_at, entity_type, entity_key);

CREATE TABLE IF NOT EXISTS sync_changes (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  operation_id TEXT NOT NULL UNIQUE,
  node_id TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_key TEXT NOT NULL,
  action TEXT NOT NULL CHECK(action IN ('upsert','delete')),
  base_version INTEGER NOT NULL DEFAULT 0,
  record_version INTEGER NOT NULL,
  payload_json TEXT NOT NULL DEFAULT '',
  occurred_at TEXT NOT NULL,
  accepted_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_sync_changes_entity
ON sync_changes(entity_type, entity_key, sequence);

CREATE TABLE IF NOT EXISTS sync_conflicts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  operation_id TEXT NOT NULL,
  node_id TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_key TEXT NOT NULL,
  current_version INTEGER NOT NULL,
  base_version INTEGER NOT NULL,
  reason TEXT NOT NULL,
  current_json TEXT NOT NULL DEFAULT '',
  incoming_json TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'open',
  created_at TEXT NOT NULL,
  resolved_at TEXT NOT NULL DEFAULT ''
);

CREATE INDEX IF NOT EXISTS idx_sync_conflicts_status
ON sync_conflicts(status, created_at);

CREATE TABLE IF NOT EXISTS sync_node_cursors (
  node_id TEXT PRIMARY KEY,
  last_pulled_sequence INTEGER NOT NULL DEFAULT 0,
  last_pushed_at TEXT NOT NULL DEFAULT '',
  last_pulled_at TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sync_leases (
  lease_key TEXT PRIMARY KEY,
  holder_node_id TEXT NOT NULL,
  lease_token_hash TEXT NOT NULL,
  epoch INTEGER NOT NULL DEFAULT 1,
  expires_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_sync_leases_expires
ON sync_leases(expires_at);
