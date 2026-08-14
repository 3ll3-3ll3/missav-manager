-- Version 19 could be interrupted while this migration was running, leaving
-- only a prefix of its ALTER TABLE statements applied. SQLite has no portable
-- ADD COLUMN IF NOT EXISTS form, so replaying the migration would fail on the
-- first existing column and prevent every later deployment.
--
-- The Worker now owns this one compatibility repair: ensureSchema() probes the
-- base schema and adds each Telegram hub column individually, tolerating an
-- already-existing column. Keep this hosted migration as a valid no-op so the
-- migration runner can mark 0004 complete for both partial and fresh databases.
SELECT 1;
