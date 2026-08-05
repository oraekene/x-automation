-- Ticket 14: external API tokens. Per-user, revocable bearer tokens for the
-- external surface (POST /api/targeting, /api/content, /api/results). Only the
-- SHA-256 hash is stored; the plaintext token is shown once at issue time.

CREATE TABLE IF NOT EXISTS api_tokens (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  name TEXT NOT NULL DEFAULT 'api',
  token_hash TEXT NOT NULL UNIQUE,
  prefix TEXT NOT NULL,             -- first 8 chars, for display only
  created_at INTEGER NOT NULL,
  revoked_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_api_tokens_user ON api_tokens (user_id, created_at DESC);
