CREATE TABLE `telegram_accounts` (
	`id` text PRIMARY KEY NOT NULL,
	`status` text DEFAULT 'authorized' NOT NULL,
	`encrypted_session` text NOT NULL,
	`account_key` text DEFAULT '' NOT NULL,
	`account_label` text DEFAULT '' NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `telegram_auth_flows` (
	`id` text PRIMARY KEY NOT NULL,
	`mode` text NOT NULL,
	`stage` text NOT NULL,
	`encrypted_session` text NOT NULL,
	`challenge_json` text DEFAULT '{}' NOT NULL,
	`expires_at` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `telegram_auth_flows_expires_idx` ON `telegram_auth_flows` (`expires_at`);