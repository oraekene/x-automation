-- Ticket 10: Funnel Stage 3 — AI targeting. One provider config per user (the
-- OpenAI-compatible base URL, API key, and model triple keyed to the user's own
-- account); `drafts` holds the targeting verdict for each actionable candidate.
-- draft rows only carry reply | quote verdicts — skips and AI failures live in
-- the `decisions` audit trail (stage 'ai'), added by existing decisions table.
CREATE TABLE IF NOT EXISTS provider_configs (
  user_id TEXT PRIMARY KEY,
  base_url TEXT NOT NULL,
  api_key TEXT NOT NULL,
  model TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS drafts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  relay_id TEXT NOT NULL,
  automation_id TEXT NOT NULL,
  candidate_id TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('reply', 'quote')),
  reason TEXT NOT NULL,
  priority INTEGER NOT NULL,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE (user_id, candidate_id)
);

CREATE INDEX IF NOT EXISTS idx_drafts_user ON drafts (user_id, created_at DESC);