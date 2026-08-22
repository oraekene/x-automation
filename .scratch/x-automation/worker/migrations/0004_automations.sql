-- Ticket 08: automations — the funnel Stage-1 job definitions the tick drives.
-- Each automation owns structured search criteria and a targeting profile;
-- the tick fans out due automations into search and profile commands.
CREATE TABLE IF NOT EXISTS automations (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  relay_id TEXT NOT NULL,
  name TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'active',     -- active | paused
  search_criteria TEXT NOT NULL DEFAULT '{}',
  targeting TEXT NOT NULL DEFAULT '{}',
  interval_minutes INTEGER NOT NULL DEFAULT 1440,
  timezone TEXT NOT NULL DEFAULT 'UTC',
  next_run_at INTEGER NOT NULL,
  last_run_at INTEGER,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_automations_due ON automations (status, next_run_at);