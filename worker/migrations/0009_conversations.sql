-- Ticket 12: conversations (inbound multi-turn). Conversations start when
-- someone replies to the user's own tweet (found via the relay's inbound_scan
-- command, `to:<me>` search); each inbound message generates one turn through
-- the AI layer, written as an audit draft and executed immediately. Messages
-- keep the thread (inbound from scans, outbound linked to the turn draft);
-- settings are per user with deterministic caps; relays get a last-scan stamp
-- so relays without open conversations are only scanned hourly.

CREATE TABLE IF NOT EXISTS conversations (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  relay_id TEXT NOT NULL,
  peer TEXT NOT NULL,               -- screen name of the other party
  root_tweet_id TEXT NOT NULL,      -- the user's own tweet the thread started under
  status TEXT NOT NULL DEFAULT 'open',   -- open | closed
  turn_count INTEGER NOT NULL DEFAULT 0, -- inbound turns handled
  closed_reason TEXT,
  closed_at INTEGER,
  last_turn_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_conversations_open ON conversations (relay_id, status);
CREATE INDEX IF NOT EXISTS idx_conversations_user ON conversations (user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  role TEXT NOT NULL,               -- inbound | outbound
  tweet_id TEXT,                    -- NULL for outbound until the relay reports it
  author TEXT NOT NULL DEFAULT '',
  text TEXT NOT NULL DEFAULT '',
  draft_id TEXT,
  created_at INTEGER NOT NULL,
  UNIQUE (user_id, tweet_id)
);

CREATE INDEX IF NOT EXISTS idx_messages_conversation ON messages (conversation_id, created_at ASC);

CREATE TABLE IF NOT EXISTS conversation_settings (
  user_id TEXT PRIMARY KEY,
  max_turns INTEGER NOT NULL DEFAULT 5,      -- cap 8
  inactivity_minutes INTEGER NOT NULL DEFAULT 1440,
  daily_new_cap INTEGER NOT NULL DEFAULT 10,
  quiet_hours TEXT,                          -- JSON {start, end} HH:MM or null
  timezone TEXT NOT NULL DEFAULT 'UTC',
  updated_at INTEGER NOT NULL
);

ALTER TABLE relays ADD COLUMN last_inbound_scan_at INTEGER;

-- Drafts now also cover conversation turns and scheduled/external posts:
-- automation_id and candidate_id become nullable (turns and posts have neither),
-- action gains 'post', and conversation/target references are stored so the
-- inbox can render and execute every draft the same way.
CREATE TABLE IF NOT EXISTS drafts_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  relay_id TEXT NOT NULL,
  automation_id TEXT,
  candidate_id TEXT,
  conversation_id TEXT,
  target_tweet_id TEXT,             -- replied-to tweet (candidate or inbound turn)
  action TEXT NOT NULL CHECK (action IN ('reply', 'quote', 'post')),
  reason TEXT NOT NULL DEFAULT '',
  priority INTEGER NOT NULL DEFAULT 0,
  provider TEXT NOT NULL DEFAULT '',
  model TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'ready' CHECK (status IN ('ready', 'content_failed', 'executing', 'done', 'rejected', 'failed')),
  text TEXT NOT NULL DEFAULT '',
  command_id TEXT,
  result_tweet_id TEXT,
  executed_at INTEGER,
  decided_at INTEGER,
  created_at INTEGER NOT NULL,
  UNIQUE (user_id, candidate_id)
);

INSERT INTO drafts_new (id, user_id, relay_id, automation_id, candidate_id, conversation_id, target_tweet_id, action, reason, priority, provider, model, status, text, command_id, result_tweet_id, executed_at, decided_at, created_at)
SELECT id, user_id, relay_id, automation_id, candidate_id, NULL, NULL, action, reason, priority, provider, model, status, text, command_id, result_tweet_id, executed_at, decided_at, created_at
FROM drafts;

DROP TABLE drafts;
ALTER TABLE drafts_new RENAME TO drafts;
CREATE INDEX IF NOT EXISTS idx_drafts_user ON drafts (user_id, created_at DESC);
