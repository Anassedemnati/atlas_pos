-- Backups (Task 7 review): when a destination was configured, so a destination that never
-- succeeded still turns amber after `backup.warnAfterHours` across restarts, and an index for the
-- engine's "newest run of a kind" reads.

ALTER TABLE backup_destinations ADD COLUMN created_at TEXT NOT NULL DEFAULT '';

CREATE INDEX backup_runs_kind_at ON backup_runs (kind, at);
