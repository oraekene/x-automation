-- Ticket 08: candidates — the Universe-stage candidate pool. A candidate is a
-- tweet found by a deterministic search pass or a profile-driven pass.
-- Deduped per user+tweet so the same tweet never lands twice in one user's
-- pool; cross-account dedupe belongs to the guardrails ticket.
CREATE TABLE IF NOT EXISTS candidates (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  automation_id TEXT NOT NULL,
  relay_id TEXT NOT NULL,
  tweet_id TEXT NOT NULL,
  author TEXT NOT NULL DEFAULT '',
  text TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT '',
  favorite_count INTEGER NOT NULL DEFAULT 0,
  retweet_count INTEGER NOT NULL DEFAULT 0,
  reply_count INTEGER NOT NULL DEFAULT 0,
  lang TEXT NOT NULL DEFAULT '',
  source TEXT NOT NULL DEFAULT 'search',     -- search | profile
  found_at INTEGER NOT NULL,
  UNIQUE (user_id, tweet_id)
);

CREATE INDEX IF NOT EXISTS idx_candidates_user ON candidates (user_id, found_at);