# 09 — Funnel rules: heuristic filter + guardrails

**What to build:** The user-configurable deterministic rules engine covering Stage 2 (heuristic filter to ~50) and Stage 4 (guardrails): budgets (max posts/day, max replies/day), dedupe across automations/accounts, allowlist/blocklist, quiet hours, diversity, and per-account kill switches. All parameters have automated defaults plus user overrides. Demo: candidates filtered, budget exceeded → nothing acts.

**Blocked by:** 08

**Status:** done

- [x] Rules engine applies configurable heuristic weights and thresholds, reducing the pool to the configured target size
- [x] Budgets enforced per account/day with quiet hours; exceeded budget blocks actions
- [x] Dedupe across automations and accounts prevents double-engagement
- [x] Allowlist/blocklist and per-account kill switches enforced
- [x] Every rule decision is recorded in the funnel audit trail

## Notes

### Seams confirmed
- `rules` + `budgets` are JSON columns on `automations` (`0006_funnel_rules.sql`) with code defaults (`lib/funnel.ts` `DEFAULT_RULES`/`DEFAULT_BUDGETS`); per-account boundary is a relay (one relay holds one X cookie session = one account). Kill switch = `relays.enabled`, via `POST /api/relays/:id/enabled` (shared `relayOwnedBy` guard).
- The filter runs on-demand: `POST /api/funnel/filter {automation_id?}` (deterministic + idempotent; with no automation_id it runs all the user's active automations — part of the confirmed seam). Ticket 10 reuses `lib/funnel.ts` before AI verdicts.
- `dedup` is the acted-on registry that budgets count and the dedupe guardrail consults; populated by execution in ticket 11. The guardrail is proven by tests inserting rows.
- Audit trail = `decisions` table + `GET /api/funnel/decisions` + dashboard "Funnel audit" section.

### Heuristic filter (Stage 2) — `filterCandidates`
- Rejects: blocklist (case-insensitive), allowlist (only-listed when non-empty), language (when `rules.lang` set, non-matching known languages are cut — the spec's "language" is a filter, not just a bonus), freshness (`max_age_days`), engagement (`min_engagement` on weighted faves + 2·RTs + 1.5·replies).
- Scores survivors: log-scaled engagement · weight + age-decay · weight (exp, ~1/e at 72h) + lang bonus. Caps at `target_size` (default 50) in score order; per-author `max_per_author` diversity cap applied before the size cap.

### Guardrails (Stage 4) — `applyGuardrails`
- Order: kill switch → cross-account dedupe → quiet hours (HH:MM window, midnight-crossing aware, in the automation's timezone) → daily post budget → daily reply budget. Any block ⇒ `actionable` is 0 ⇒ nothing acts (the demo).
- Budgets are per automation (user override) but enforcement shares one per-account usage count. The day boundary is UTC for all automations on an account, so different timezones agree on the day; quiet hours stay per-automation timezone.
- Guardrail decisions carry the candidate's filter score into the audit trail.

### Deferrals / caveats
- **Spam filter** (spec Stage 4) is not in this ticket's What-to-build → deferred to a later ticket.
- **Per-account aggregate budget overshoot:** each automation's budgets cap its own approvals against shared usage, but nothing reserves capacity across automations (two automations on one account with `max_posts_per_day: 10` and usage 5 can both approve 5 more → 10 posts). A true account-wide total budget lands with the accounts model (later ticket).
- Dedupe only bites once execution writes `dedup` (ticket 11); until then candidates for already-engaged tweets are blocked by the guardrail only when rows exist.

### Verification
- Worker: 82 tests (8 files; 23 lib-unit incl. language/diversity/quiet-hours/budget, 12 API funnel-rules + existing suites) `npm run typecheck` clean.
- Review (two-axis): findings fixed — rule string→`RuleName` union, language now filters, budget day boundary moved to UTC, guardrail decisions carry score, author carried on filter decisions (no re-lookup), shared HHMM regex + `inQuietHours`/`startOfDayInZone` moved to `lib/time.ts`, kill-switch route uses `relayOwnedBy`, dead `DedupRow` removed.