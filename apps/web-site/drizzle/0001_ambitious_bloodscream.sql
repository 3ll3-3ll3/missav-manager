CREATE TABLE `app_logs` (
	`id` text PRIMARY KEY NOT NULL,
	`level` text NOT NULL,
	`category` text NOT NULL,
	`message` text NOT NULL,
	`detail_json` text DEFAULT '{}' NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `app_logs_level_created_idx` ON `app_logs` (`level`,`created_at`);--> statement-breakpoint
CREATE TABLE `data_snapshot_items` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`snapshot_id` text NOT NULL,
	`entity_key` text NOT NULL,
	`previous_json` text NOT NULL,
	FOREIGN KEY (`snapshot_id`) REFERENCES `data_snapshots`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `data_snapshot_items_snapshot_idx` ON `data_snapshot_items` (`snapshot_id`,`id`);--> statement-breakpoint
CREATE TABLE `data_snapshots` (
	`id` text PRIMARY KEY NOT NULL,
	`reason` text NOT NULL,
	`entity` text NOT NULL,
	`item_count` integer DEFAULT 0 NOT NULL,
	`status` text DEFAULT 'ready' NOT NULL,
	`created_at` text NOT NULL,
	`restored_at` text DEFAULT '' NOT NULL
);
--> statement-breakpoint
CREATE INDEX `data_snapshots_created_idx` ON `data_snapshots` (`created_at`);--> statement-breakpoint
CREATE TABLE `import_batch_chunks` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`batch_id` text NOT NULL,
	`chunk_index` integer NOT NULL,
	`checksum` text NOT NULL,
	`row_count` integer NOT NULL,
	`applied_count` integer DEFAULT 0 NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`batch_id`) REFERENCES `import_batches`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `import_batch_chunks_batch_index_uq` ON `import_batch_chunks` (`batch_id`,`chunk_index`);--> statement-breakpoint
CREATE INDEX `import_batch_chunks_batch_idx` ON `import_batch_chunks` (`batch_id`,`id`);--> statement-breakpoint
CREATE TABLE `input_sources` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`external_key` text NOT NULL,
	`name` text NOT NULL,
	`metadata_json` text DEFAULT '{}' NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `input_sources_kind_external_uq` ON `input_sources` (`kind`,`external_key`);--> statement-breakpoint
CREATE TABLE `script_generations` (
	`id` text PRIMARY KEY NOT NULL,
	`run_id` text DEFAULT '' NOT NULL,
	`template_hash` text NOT NULL,
	`code_count` integer NOT NULL,
	`reference_tag_count` integer NOT NULL,
	`reference_blacklist_count` integer NOT NULL,
	`export_blacklist_count` integer NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `script_generations_created_idx` ON `script_generations` (`created_at`);--> statement-breakpoint
CREATE TABLE `sync_transactions` (
	`id` text PRIMARY KEY NOT NULL,
	`source_kind` text NOT NULL,
	`status` text NOT NULL,
	`received_count` integer DEFAULT 0 NOT NULL,
	`inserted_count` integer DEFAULT 0 NOT NULL,
	`duplicate_count` integer DEFAULT 0 NOT NULL,
	`queue_count` integer DEFAULT 0 NOT NULL,
	`detail_json` text DEFAULT '{}' NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `sync_transactions_created_idx` ON `sync_transactions` (`created_at`);--> statement-breakpoint
CREATE TABLE `task_inbox` (
	`id` text PRIMARY KEY NOT NULL,
	`tool` text NOT NULL,
	`stage` text NOT NULL,
	`title` text NOT NULL,
	`run_id` text DEFAULT '' NOT NULL,
	`record_id` text DEFAULT '' NOT NULL,
	`source_id` text DEFAULT '' NOT NULL,
	`metadata_json` text DEFAULT '{}' NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `task_inbox_stage_updated_idx` ON `task_inbox` (`stage`,`updated_at`);--> statement-breakpoint
CREATE TABLE `telegram_message_fingerprints` (
	`id` text PRIMARY KEY NOT NULL,
	`source_id` text NOT NULL,
	`message_id` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`source_id`) REFERENCES `input_sources`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `telegram_message_fingerprints_source_message_uq` ON `telegram_message_fingerprints` (`source_id`,`message_id`);--> statement-breakpoint
CREATE TABLE `telegram_messages` (
	`id` text PRIMARY KEY NOT NULL,
	`source_id` text NOT NULL,
	`message_id` text NOT NULL,
	`message_date` text DEFAULT '' NOT NULL,
	`body` text DEFAULT '' NOT NULL,
	`body_deleted_at` text DEFAULT '' NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`source_id`) REFERENCES `input_sources`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `telegram_messages_source_message_uq` ON `telegram_messages` (`source_id`,`message_id`);--> statement-breakpoint
CREATE INDEX `telegram_messages_date_idx` ON `telegram_messages` (`message_date`,`id`);--> statement-breakpoint
CREATE TABLE `telegram_tool_queue` (
	`id` text PRIMARY KEY NOT NULL,
	`telegram_message_id` text NOT NULL,
	`tool` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`candidate_count` integer DEFAULT 0 NOT NULL,
	`run_id` text DEFAULT '' NOT NULL,
	`processed_at` text DEFAULT '' NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`telegram_message_id`) REFERENCES `telegram_messages`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `telegram_tool_queue_message_tool_uq` ON `telegram_tool_queue` (`telegram_message_id`,`tool`);--> statement-breakpoint
CREATE INDEX `telegram_tool_queue_tool_status_idx` ON `telegram_tool_queue` (`tool`,`status`,`updated_at`);--> statement-breakpoint
CREATE TABLE `tool_source_bindings` (
	`id` text PRIMARY KEY NOT NULL,
	`source_id` text NOT NULL,
	`tool` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`source_id`) REFERENCES `input_sources`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `tool_source_bindings_source_tool_uq` ON `tool_source_bindings` (`source_id`,`tool`);