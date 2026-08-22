-- Ticket 02: users, relays, commands — the pairing + command channel skeleton.
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL
);

INSERT OR IGNORE INTO users (id, created_at) VALUES ('seeded-superuser', strftime('%s', 'now'));

CREATE TABLE IF NOT EXISTS relays (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  name TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pending',      -- pending | active
  pairing_code_hash TEXT NOT NULL,
  token_hash TEXT,
  last_seen_at INTEGER,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS commands (
  id TEXT PRIMARY KEY,
  relay_id TEXT NOT NULL,
  type TEXT NOT NULL,
  payload TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'pending',      -- pending | in_flight | done | failed
  attempts INTEGER NOT NULL DEFAULT 0,
  result TEXT,
  created_at INTEGER NOT NULL,
  claimed_at INTEGER,
  completed_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_commands_relay_status ON commands (relay_id, status, created_at);