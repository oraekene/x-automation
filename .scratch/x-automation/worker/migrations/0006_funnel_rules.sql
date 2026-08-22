-- Ticket 09: Funnel rules — Stage 2 heuristic filter + Stage 4 guardrails.
-- Automations gain user-overridable rule/budget configuration (code supplies
-- defaults when the JSON is empty); relays gain a per-account kill switch;
-- every rule decision lands in `decisions` (the funnel audit trail); `dedup`
-- records acted-on tweets (populated by execution, ticket 11) so budgets count
-- and the dedupe guardrail can block double-engagement across automations and
-- accounts.
ALTER TABLE automations ADD COLUMN rules TEXT NOT NULL DEFAULT '{}';
ALTER TABLE automations ADD COLUMN budgets TEXT NOT NULL DEFAULT '{}';
ALTER TABLE relays ADD COLUMN enabled INTEGER NOT NULL DEFAULT 1;

CREATE TABLE IF NOT EXISTS decisions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  relay_id TEXT NOT NULL,
  automation_id TEXT NOT NULL,
  candidate_id TEXT NOT NULL,
  stage TEXT NOT NULL,        -- filter | guardrail
  decision TEXT NOT NULL,     -- keep | reject | block
  rule TEXT NOT NULL,         -- score | engagement | freshness | language | target_size | diversity | budget | quiet_hours | dedupe | allowlist | blocklist | kill_switch
  reason TEXT NOT NULL DEFAULT '',
  score REAL NOT NULL DEFAULT 0,
  acted_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_decisions_user ON decisions (user_id, acted_at DESC);
CREATE INDEX IF NOT EXISTS idx_decisions_candidate ON decisions (candidate_id);

CREATE TABLE IF NOT EXISTS dedup (
  user_id TEXT NOT NULL,
  relay_id TEXT NOT NULL,
  tweet_id TEXT NOT NULL,
  action TEXT NOT NULL,       -- post | reply | quote
  acted_at INTEGER NOT NULL,
  UNIQUE (user_id, tweet_id)
);