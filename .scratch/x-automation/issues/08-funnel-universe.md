# 08 — Funnel Stage 1: Universe

**What to build:** Automation creation (search criteria + targeting profile via API and dashboard), and the Universe stage that builds the candidate pool: deterministic search passes (operators, engagement thresholds, time windows) and profile-driven passes (search target profiles → pull their recent tweets), run by the tick through relay commands. Semantic (embedding/AI-assisted) discovery lands in a later ticket. Candidates stored in D1 and visible in the dashboard.

**Blocked by:** 04 + 06

**Status:** done

- [x] Create an automation with search criteria and a targeting profile via API and dashboard
- [x] Tick runs due automations, issuing search and profile passes through the relay
- [x] Deterministic passes return candidates with engagement metadata, deduped into a candidate pool in D1
- [x] Profile-driven pass: target profiles matched by bio/followers/verified/location feed their recent tweets into the pool
- [x] Candidate pool visible in the dashboard with per-candidate metadata

## Notes

### Seams confirmed
- Dedicated `automations` table (not a reuse of `schedules`); the tick enqueues one `search` + one `profile_pass` command per due automation.
- Profile pass built on `xreader.search_profiles` (People search → `user_posts`), which also resolves the ticket-06 deferral (search_profiles).
- Candidate dedupe is per user+tweet: `UNIQUE(user_id, tweet_id)` + `INSERT OR IGNORE` in `0005_candidates.sql`.
- Funnel commands are identified by `payload.automation_id`; only `search`/`profile_pass` results with a tweets array ingest candidates.

### Search criteria validation
- Keywords required (non-empty strings); hashtags/mentions optional string arrays; thresholds whole numbers >= 0; lang a string; since/until `YYYY-MM-DD`; timezone IANA-resolved. Interval coerce now shared with schedules via `coerceIntervalMinutes` (`lib/time.ts`).

### Funnel pass caps
- `search`: up to 3 pages; `profile_pass`: up to 3 matched profiles, one page of tweets each, `max_profiles`/`max_pages` forwarded from the payload (default 50/1) — kept small for free-tier request budgets.

### Caveats (as with ticket 07's CreateTweet)
- Real profile passes need a refreshed `SearchTimeline` queryId in `client.json`; until then `search_profiles` exercises the same offline fallback path as reads. The People-search product ID is a placeholder.
- No semantic/AI discovery in this ticket; it is a later ticket per the spec's funnel stages.
- `verified` is now strictly validated as a boolean at the API; the relay-side ProfileCriteria only reads booleans, so a stringified `"false"` can no longer reach `_run_profile_pass` (was silently truthy — review finding, fixed with validation + dashboard wiring).

### Verification
- Worker: 47 tests (6 files) + `npm run typecheck` clean.
- Relay: 86 tests (`python -m pytest -q`).
