-- US25: per-user lifetime conversation budget. Adds max_lifetime_conversations
-- to conversation_settings (default 100) so a user can cap total conversations
-- ever created, not just per day.

ALTER TABLE conversation_settings ADD COLUMN max_lifetime_conversations INTEGER NOT NULL DEFAULT 100;
