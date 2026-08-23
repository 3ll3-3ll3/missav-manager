CREATE TABLE `cloud_sync_conflicts` (
	`id` text PRIMARY KEY NOT NULL,
	`operation_id` text DEFAULT '' NOT NULL,
	`entity_type` text NOT NULL,
	`entity_key` text NOT NULL,
	`current_version` integer DEFAULT 0 NOT NULL,
	`reason` text NOT NULL,
	`local_json` text DEFAULT '' NOT NULL,
	`remote_json` text DEFAULT '' NOT NULL,
	`status` text DEFAULT 'open' NOT NULL,
	`created_at` text NOT NULL,
	`resolved_at` text DEFAULT '' NOT NULL
);
--> statement-breakpoint
CREATE INDEX `cloud_sync_conflicts_status_created_idx` ON `cloud_sync_conflicts` (`status`,`created_at`);--> statement-breakpoint
CREATE TABLE `cloud_sync_dirty` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`table_name` text NOT NULL,
	`row_key` text NOT NULL,
	`action` text NOT NULL,
	`row_json` text NOT NULL,
	`changed_at` text NOT NULL,
	`last_error` text DEFAULT '' NOT NULL
);
--> statement-breakpoint
CREATE INDEX `cloud_sync_dirty_id_idx` ON `cloud_sync_dirty` (`id`);--> statement-breakpoint
CREATE TABLE `cloud_sync_entity_versions` (
	`entity_type` text NOT NULL,
	`entity_key` text NOT NULL,
	`record_version` integer DEFAULT 0 NOT NULL,
	`tombstone` integer DEFAULT 0 NOT NULL,
	`payload_hash` text DEFAULT '' NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `cloud_sync_entity_versions_uq` ON `cloud_sync_entity_versions` (`entity_type`,`entity_key`);--> statement-breakpoint
CREATE TABLE `cloud_sync_outbox` (
	`operation_id` text PRIMARY KEY NOT NULL,
	`entity_type` text NOT NULL,
	`entity_key` text NOT NULL,
	`action` text NOT NULL,
	`restore` integer DEFAULT 0 NOT NULL,
	`base_version` integer DEFAULT 0 NOT NULL,
	`payload_json` text DEFAULT '' NOT NULL,
	`occurred_at` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`attempt_count` integer DEFAULT 0 NOT NULL,
	`last_error` text DEFAULT '' NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `cloud_sync_outbox_entity_uq` ON `cloud_sync_outbox` (`entity_type`,`entity_key`);--> statement-breakpoint
CREATE INDEX `cloud_sync_outbox_status_created_idx` ON `cloud_sync_outbox` (`status`,`created_at`);--> statement-breakpoint
CREATE TABLE `cloud_sync_runtime` (
	`id` integer PRIMARY KEY NOT NULL,
	`suppress_outbox` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE `cloud_sync_state` (
	`id` text PRIMARY KEY NOT NULL,
	`node_id` text NOT NULL,
	`encrypted_device_token` text DEFAULT '' NOT NULL,
	`last_pulled_sequence` integer DEFAULT 0 NOT NULL,
	`preview_json` text DEFAULT '{}' NOT NULL,
	`preview_expires_at` text DEFAULT '' NOT NULL,
	`last_success_at` text DEFAULT '' NOT NULL,
	`last_error` text DEFAULT '' NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
INSERT OR IGNORE INTO `cloud_sync_runtime` (`id`,`suppress_outbox`) VALUES (1,0);
