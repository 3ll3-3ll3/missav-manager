ALTER TABLE `input_sources` ADD `sync_cursor_message_id` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `input_sources` ADD `sync_target_message_id` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `sync_transactions` ADD `edited_count` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `sync_transactions` ADD `deleted_count` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `telegram_auth_flows` ADD `encrypted_challenge` text DEFAULT '' NOT NULL;--> statement-breakpoint
DELETE FROM `telegram_auth_flows` WHERE `encrypted_challenge`='' AND `challenge_json`<>'{}';--> statement-breakpoint
ALTER TABLE `telegram_bot_state` ADD `webhook_status` text DEFAULT 'unknown' NOT NULL;--> statement-breakpoint
ALTER TABLE `telegram_bot_state` ADD `last_checked_at` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `telegram_message_fingerprints` ADD `content_hash` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `telegram_message_fingerprints` ADD `event_kind` text DEFAULT 'message' NOT NULL;--> statement-breakpoint
ALTER TABLE `telegram_message_fingerprints` ADD `last_remote_update_id` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `telegram_message_fingerprints` ADD `updated_at` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `telegram_messages` ADD `event_kind` text DEFAULT 'message' NOT NULL;--> statement-breakpoint
ALTER TABLE `telegram_messages` ADD `content_hash` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `telegram_messages` ADD `remote_edited_at` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `telegram_messages` ADD `remote_deleted_at` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `telegram_sync_runs` ADD `edited_count` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `telegram_sync_runs` ADD `deleted_count` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `telegram_sync_runs` ADD `has_more` integer DEFAULT 0 NOT NULL;
