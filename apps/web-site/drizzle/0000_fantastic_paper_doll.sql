CREATE TABLE `app_settings` (
	`key` text PRIMARY KEY NOT NULL,
	`value_json` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `content_results` (
	`id` text PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
	`tool` text NOT NULL,
	`result_key` text NOT NULL,
	`primary_value` text NOT NULL,
	`secondary_value` text DEFAULT '' NOT NULL,
	`status` text DEFAULT 'success' NOT NULL,
	`tags_json` text DEFAULT '[]' NOT NULL,
	`source` text DEFAULT '' NOT NULL,
	`metadata_json` text DEFAULT '{}' NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`run_id`) REFERENCES `content_runs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `content_results_run_key_uq` ON `content_results` (`run_id`,`result_key`);--> statement-breakpoint
CREATE INDEX `content_results_run_idx` ON `content_results` (`run_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `content_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`tool` text NOT NULL,
	`name` text NOT NULL,
	`input_kind` text NOT NULL,
	`start_at` text DEFAULT '' NOT NULL,
	`end_at` text DEFAULT '' NOT NULL,
	`source_summary` text DEFAULT '' NOT NULL,
	`total_count` integer DEFAULT 0 NOT NULL,
	`result_count` integer DEFAULT 0 NOT NULL,
	`error_count` integer DEFAULT 0 NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `content_runs_tool_created_idx` ON `content_runs` (`tool`,`created_at`);--> statement-breakpoint
CREATE TABLE `import_batches` (
	`id` text PRIMARY KEY NOT NULL,
	`file_name` text NOT NULL,
	`checksum` text DEFAULT '' NOT NULL,
	`status` text NOT NULL,
	`total_rows` integer DEFAULT 0 NOT NULL,
	`valid_rows` integer DEFAULT 0 NOT NULL,
	`rejected_rows` integer DEFAULT 0 NOT NULL,
	`applied_rows` integer DEFAULT 0 NOT NULL,
	`counts_json` text DEFAULT '{}' NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `import_batches_created_idx` ON `import_batches` (`created_at`);--> statement-breakpoint
CREATE TABLE `import_changes` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`batch_id` text NOT NULL,
	`tool` text NOT NULL,
	`record_key` text NOT NULL,
	`action` text NOT NULL,
	`previous_json` text DEFAULT '' NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`batch_id`) REFERENCES `import_batches`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `import_changes_batch_record_uq` ON `import_changes` (`batch_id`,`tool`,`record_key`);--> statement-breakpoint
CREATE INDEX `import_changes_batch_idx` ON `import_changes` (`batch_id`,`id`);--> statement-breakpoint
CREATE TABLE `permanent_records` (
	`id` text PRIMARY KEY NOT NULL,
	`tool` text NOT NULL,
	`record_key` text NOT NULL,
	`primary_value` text NOT NULL,
	`secondary_value` text DEFAULT '' NOT NULL,
	`status` text DEFAULT 'new' NOT NULL,
	`tags_json` text DEFAULT '[]' NOT NULL,
	`actress_tags_json` text DEFAULT '[]' NOT NULL,
	`genre_tags_json` text DEFAULT '[]' NOT NULL,
	`source_url` text DEFAULT '' NOT NULL,
	`missav_url` text DEFAULT '' NOT NULL,
	`av123_url` text DEFAULT '' NOT NULL,
	`metadata_json` text DEFAULT '{}' NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `permanent_records_tool_key_uq` ON `permanent_records` (`tool`,`record_key`);--> statement-breakpoint
CREATE INDEX `permanent_records_tool_status_idx` ON `permanent_records` (`tool`,`status`,`updated_at`);--> statement-breakpoint
CREATE INDEX `permanent_records_updated_idx` ON `permanent_records` (`updated_at`);