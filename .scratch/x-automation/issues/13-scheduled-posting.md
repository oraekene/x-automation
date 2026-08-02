# 13 — Scheduled general posting

**What to build:** Capability 6: compose and schedule a plain post from the dashboard (per-user timezone, one-off and recurring schedules via the tick), executed by the relay as a write command. Demo: schedule a post → tick fires → relay posts at the right time.

**Blocked by:** 11

**Status:** ready-for-agent

- [ ] Compose a post with optional schedule (one-off or recurring, user timezone) in the dashboard
- [ ] Scheduled posts ride the tick scheduler and execute through the relay write path
- [ ] Posted/scheduled/cancelled states visible in the dashboard
