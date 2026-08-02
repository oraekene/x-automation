# 04 — Tick scheduler (jobs-as-data)

**What to build:** The per-minute "tick" cron that drives all automation: a schedules table in D1, a tick that selects due jobs (`next_run_at <= now AND status = 'active'`), fans them out inline, and recomputes each job's `next_run_at` in the user's timezone. One of the five free-tier cron slots is used for the tick; a second slot runs a maintenance sweep (conversation timeouts, stale commands). Demo: a schedule created via API is picked up by the tick, enqueues a command to the relay, and the relay executes it.

**Blocked by:** 02

**Status:** ready-for-agent

- [ ] Schedules table holds per-user jobs with next_run_at and status
- [ ] Per-minute tick cron picks up due jobs and fans them out (commands enqueued)
- [ ] next_run_at recomputed in the user's timezone after each run
- [ ] Maintenance cron sweep exists and processes conversation timeouts and stale commands
- [ ] End-to-end demo: schedule a job via API → tick enqueues → relay executes → result recorded
