-- Ticket 13: scheduled posting. One-off schedules (a single post at a chosen
-- time) ride the same schedules table; `mode` distinguishes them from
-- recurring cadences so the tick can deactivate them after their single run.

ALTER TABLE schedules ADD COLUMN mode TEXT NOT NULL DEFAULT 'recurring';
