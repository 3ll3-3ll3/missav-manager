CREATE TABLE `telegram_bot_state` (
	`connection_id` text PRIMARY KEY NOT NULL,
	`next_update_offset` integer DEFAULT 0 NOT NULL,
	`last_update_id` integer DEFAULT 0 NOT NULL,
	`lock_until` text DEFAULT '' NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`connection_id`) REFERENCES `telegram_connections`(`connection_id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `telegram_connections` (
	`connection_id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`label` text DEFAULT '' NOT NULL,
	`status` text DEFAULT 'disconnected' NOT NULL,
	`account_key` text DEFAULT '' NOT NULL,
	`account_label` text DEFAULT '' NOT NULL,
	`username` text DEFAULT '' NOT NULL,
	`session_encrypted` text DEFAULT '' NOT NULL,
	`network_status` text DEFAULT 'unknown' NOT NULL,
	`last_connected_at` text DEFAULT '' NOT NULL,
	`last_success_at` text DEFAULT '' NOT NULL,
	`last_error` text DEFAULT '' NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `telegram_connections_kind_idx` ON `telegram_connections` (`kind`,`status`);--> statement-breakpoint
CREATE TABLE `telegram_migration_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`status` text DEFAULT 'preview' NOT NULL,
	`snapshot_id` text DEFAULT '' NOT NULL,
	`counts_json` text DEFAULT '{}' NOT NULL,
	`warnings_json` text DEFAULT '[]' NOT NULL,
	`created_at` text NOT NULL,
	`applied_at` text DEFAULT '' NOT NULL
);
--> statement-breakpoint
CREATE TABLE `telegram_read_states` (
	`source_id` text PRIMARY KEY NOT NULL,
	`policy` text DEFAULT 'never' NOT NULL,
	`safe_read_message_id` text DEFAULT '' NOT NULL,
	`last_marked_read_message_id` text DEFAULT '' NOT NULL,
	`read_baseline_message_id` text DEFAULT '' NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`source_id`) REFERENCES `input_sources`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `telegram_sync_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`connection_id` text NOT NULL,
	`source_id` text DEFAULT '' NOT NULL,
	`transport` text NOT NULL,
	`mode` text DEFAULT 'incremental' NOT NULL,
	`status` text DEFAULT 'running' NOT NULL,
	`started_at` text NOT NULL,
	`ended_at` text DEFAULT '' NOT NULL,
	`scanned_count` integer DEFAULT 0 NOT NULL,
	`inserted_count` integer DEFAULT 0 NOT NULL,
	`duplicate_count` integer DEFAULT 0 NOT NULL,
	`queue_count` integer DEFAULT 0 NOT NULL,
	`empty_candidate_count` integer DEFAULT 0 NOT NULL,
	`checkpoint_before` text DEFAULT '' NOT NULL,
	`checkpoint_after` text DEFAULT '' NOT NULL,
	`read_result` text DEFAULT 'not_attempted' NOT NULL,
	`error_message` text DEFAULT '' NOT NULL,
	`detail_json` text DEFAULT '{}' NOT NULL
);
--> statement-breakpoint
CREATE INDEX `telegram_sync_runs_created_idx` ON `telegram_sync_runs` (`started_at`,`connection_id`);--> statement-breakpoint
ALTER TABLE `input_sources` ADD `connection_id` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `input_sources` ADD `external_chat_id` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `input_sources` ADD `chat_type` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `input_sources` ADD `username` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `input_sources` ADD `access_status` text DEFAULT 'unknown' NOT NULL;--> statement-breakpoint
ALTER TABLE `input_sources` ADD `archived` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `input_sources` ADD `last_sync_at` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `input_sources` ADD `latest_remote_message_id` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `input_sources` ADD `incremental_checkpoint_id` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `input_sources` ADD `last_error` text DEFAULT '' NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `input_sources_connection_chat_uq` ON `input_sources` (`connection_id`,`external_chat_id`);--> statement-breakpoint
CREATE INDEX `input_sources_connection_status_idx` ON `input_sources` (`connection_id`,`access_status`,`updated_at`);--> statement-breakpoint
ALTER TABLE `telegram_messages` ADD `connection_id` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `telegram_messages` ADD `external_message_id` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `telegram_messages` ADD `remote_update_id` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `telegram_tool_queue` ADD `error_message` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `telegram_tool_queue` ADD `selected_at` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `telegram_tool_queue` ADD `processing_at` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `tool_source_bindings` ADD `history_mode` text DEFAULT 'since_now' NOT NULL;--> statement-breakpoint
ALTER TABLE `tool_source_bindings` ADD `history_limit` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `tool_source_bindings` ADD `history_from` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `tool_source_bindings` ADD `bound_at_message_id` text DEFAULT '' NOT NULL;