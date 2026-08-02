# 04 — Tick scheduler (jobs-as-data)

**What to build:** The per-minute "tick" cron that drives all automation: a schedules table in D1, a tick that selects due jobs (`next_run_at <= now AND status = 'active'`), fans them out inline, and recomputes each job's `next_run_at` in the user's timezone. One of the five free-tier cron slots is used for the tick; a second slot runs a maintenance sweep (conversation timeouts, stale commands). Demo: a schedule created via API is picked up by the tick, enqueues a command to the relay, and the relay executes it.

**Blocked by:** 02

**Status:** ready-for-agent

- [x] Schedules table holds per-user jobs with next_run_at and status
- [x] Per-minute tick cron picks up due jobs and fans them out (commands enqueued)
- [x] next_run_at recomputed in the user's timezone after each run
- [ ] Maintenance cron sweep exists and processes conversation timeouts and stale commands (stale claims done; conversation timeouts deferred — see Notes)
- [x] End-to-end demo: schedule a job via API → tick enqueues → relay executes → result recorded

## Notes (ticket 04 done, @ 2026-08-02)

- Conversation-timeout half of the maintenance sweep is **deferred**: it runs
  in `src/scheduled.ts maintenance()` but only the stale-command sweep exists.
  Conversation timeouts need the `conversations` table, which arrives with the
  conversations/multi-turn ticket — the maintenance handler is already the join
  point for it.
- "Daily at 9am" wall-clock anchoring (spec user story 29) is **not covered** by
  `interval_minutes`-based scheduling. Interval cadence ships now; an
  anchor/cron-expression form is a follow-up ticket.
- Cron slot 3 (daily budget resets) stays reserved in `wrangler.jsonc` comments
  until budgets/daily resets land.
