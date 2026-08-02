# 14 — External API + webhook

**What to build:** The token-authenticated external surface for tools like the Hermes Agent job-hunting plugin: `POST /api/targeting` (submit a targeting profile that drives the funnel), `POST /api/content` (webhook content source for posting), `POST /api/results` (external results feed-back). Tokens are per-user, revocable, and never shared.

**Blocked by:** 11

**Status:** ready-for-agent

- [ ] Per-user API tokens issued/revoked from the dashboard, stored hashed
- [ ] POST /api/targeting submits a targeting profile and wires it into the funnel
- [ ] POST /api/content supplies content that flows through drafts and execution
- [ ] POST /api/results receives results from external tools into the audit trail
- [ ] All three endpoints reject invalid/revoked tokens
