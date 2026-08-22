-- Ticket 04: schedules — the per-user, per-relay automation jobs the tick drives.
-- next_run_at is UNIX seconds; the tick recomputes it in the job's timezone.
CREATE TABLE IF NOT EXISTS schedules (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  relay_id TEXT NOT NULL,
  name TEXT NOT NULL DEFAULT '',
  type TEXT NOT NULL DEFAULT 'echo',
  payload TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'active',     -- active | paused
  interval_minutes INTEGER NOT NULL DEFAULT 1440,
  timezone TEXT NOT NULL DEFAULT 'UTC',
  next_run_at INTEGER NOT NULL,
  last_run_at INTEGER,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_schedules_due ON schedules (status, next_run_at);