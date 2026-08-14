-- Additive workflow-contract migration. Rollback is intentionally data-safe:
-- older code ignores these nullable/defaulted columns and extra indexes, so a
-- rollback only requires deploying the previous application version. No user
-- row, binding, checkpoint, queue, Session, or result is rewritten or deleted.
ALTER TABLE `content_runs` ADD `status` text DEFAULT 'completed' NOT NULL;
--> statement-breakpoint
ALTER TABLE `content_runs` ADD `stats_json` text DEFAULT '{}' NOT NULL;
--> statement-breakpoint
ALTER TABLE `content_runs` ADD `options_json` text DEFAULT '{}' NOT NULL;
--> statement-breakpoint
ALTER TABLE `content_results` ADD `error_message` text DEFAULT '' NOT NULL;
--> statement-breakpoint
ALTER TABLE `telegram_tool_queue` ADD `candidate_preview` text DEFAULT '' NOT NULL;
--> statement-breakpoint
ALTER TABLE `telegram_tool_queue` ADD `message_date` text DEFAULT '' NOT NULL;
--> statement-breakpoint
UPDATE `telegram_tool_queue` SET `message_date`=COALESCE((SELECT `message_date` FROM `telegram_messages` WHERE `telegram_messages`.`id`=`telegram_tool_queue`.`telegram_message_id`),'') WHERE `message_date`='';
--> statement-breakpoint
ALTER TABLE `task_inbox` ADD `phase` text DEFAULT 'received' NOT NULL;
--> statement-breakpoint
UPDATE `task_inbox` SET `phase`=CASE
  WHEN `stage` IN ('pending','new','queued') THEN 'received'
  WHEN `stage`='filtered' THEN 'filtered'
  WHEN `stage` IN ('running','website','processing','in_progress','paused','pause') THEN 'website'
  WHEN `stage` IN ('needs_manual','review','needs_review','needs_attention','manual','partial_completed','partial','partially_completed','partial_success') THEN 'review'
  WHEN `stage` IN ('retry_waiting','error','failed','retry','retrying','retry_pending','waiting_retry') THEN 'error'
  WHEN `stage` IN ('completed','success','succeeded','done','complete','cancelled','canceled','aborted') THEN 'completed'
  ELSE 'review'
END;
--> statement-breakpoint
CREATE INDEX `telegram_messages_source_date_id_idx` ON `telegram_messages` (`source_id`,`message_date`,`id`);
--> statement-breakpoint
CREATE INDEX `telegram_tool_queue_message_status_idx` ON `telegram_tool_queue` (`telegram_message_id`,`status`);
--> statement-breakpoint
CREATE INDEX `telegram_tool_queue_tool_status_date_id_idx` ON `telegram_tool_queue` (`tool`,`status`,`message_date`,`id`);
