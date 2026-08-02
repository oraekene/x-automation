# 11 — Inbox + execution modes

**What to build:** The review surface and the three execution modes — manual (inbox), automatic, hybrid (auto below a priority threshold, inbox above). Drafts execute (via relay write commands) or are rejected from the inbox. Demo: approve a draft → it posts; reject another → nothing posts.

**Blocked by:** 07 + 10

**Status:** ready-for-agent

- [ ] Draft inbox lists drafts with action/reason/priority; approve and reject actions work
- [ ] Manual mode: nothing executes except from the inbox
- [ ] Automatic mode: drafts execute without review, respecting guardrails
- [ ] Hybrid mode: auto below threshold, inbox above it
- [ ] Execution results recorded back to the draft; rejected drafts marked and excluded from dedupe/retry
