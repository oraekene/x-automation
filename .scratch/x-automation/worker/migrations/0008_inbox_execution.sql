-- Ticket 11: Inbox + execution modes. Automations gain the execution mode
-- (manual | auto | hybrid) with the hybrid threshold (priority >= threshold
-- goes to the inbox, below runs automatically; 1-5, default 4). Drafts gain
-- their lifecycle: the generated reply/quote text, status
-- (ready | content_failed | executing | done | rejected | failed), the command
-- that executes them (for result mapping), the created tweet id, and when the
-- draft was decided/executed.
ALTER TABLE automations ADD COLUMN mode TEXT NOT NULL DEFAULT 'manual';
ALTER TABLE automations ADD COLUMN auto_threshold INTEGER NOT NULL DEFAULT 4;

ALTER TABLE drafts ADD COLUMN status TEXT NOT NULL DEFAULT 'ready';
ALTER TABLE drafts ADD COLUMN text TEXT NOT NULL DEFAULT '';
ALTER TABLE drafts ADD COLUMN command_id TEXT;
ALTER TABLE drafts ADD COLUMN result_tweet_id TEXT;
ALTER TABLE drafts ADD COLUMN executed_at INTEGER;
ALTER TABLE drafts ADD COLUMN decided_at INTEGER;