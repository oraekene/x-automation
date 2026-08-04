# 11 — Inbox + execution modes

**What to build:** The review surface and the three execution modes — manual (inbox), automatic, hybrid (auto below a priority threshold, inbox above). Drafts execute (via relay write commands) or are rejected from the inbox. Demo: approve a draft → it posts; reject another → nothing posts.

**Blocked by:** 07 + 10

**Status:** done

## Implemented

- **Inbox** (`routes/drafts.ts`): `GET /api/drafts` lists drafts joined to candidate + automation (status, text, command_id, result_tweet_id, decided_at/executed_at). `POST /:id/approve` (optional text override ≤ 280, 400 when the draft has no text and none is given) executes immediately: atomically claims the tweet in `dedup` first (`INSERT OR IGNORE` changes == 0 → 409, so two concurrent approves cannot double-engage), then enqueues the relay write command + marks the draft `executing`. `POST /:id/reject` marks `rejected` terminal — no command, no dedupe row. 404 for other users' drafts, 409 for non-decidable drafts or hard safety blocks (kill switch, dedupe).
- **AI content drafting** (`lib/ai.ts` `draftContent` + `lib/target.ts`): the targeting pass drafts reply/quote text in the user's style right after the verdict; content failures land `content_failed` with empty text; the hourly MAINT_CRON `retryDraftContent` fills those in using the current provider (per-user cap, `score` uses the draft's stored priority). Inbox approve can override the text.
- **Execution modes** (`0008_inbox_execution.sql`): `automations.mode` (`manual|auto|hybrid`, default manual) + `auto_threshold` (1–5, default 4), validated in `routes/automations.ts` and settable from the dashboard form.
- **Tick execution** (`lib/execution.ts` `executeReadyDrafts`): per-minute pass over `ready` drafts with text in auto mode (hybrid only below threshold), re-checking live guardrails (kill switch, cross-account dedupe, quiet hours, daily budgets) — blocked drafts stay ready silently. Shared `enqueueDraftStatements`/`writePayload` recipe with approve (one payload + enqueue shape).
- **Results mapped back** (`routes/relays.ts`): successful write commands (`post/reply/quote` with `draft_id`) mark the draft `done` + `result_tweet_id`; `ok` without a tweet id or failed writes mark it `failed` — a draft can never stay `executing` forever.
- **Never re-judged**: terminal drafts (`rejected`, `failed`) are excluded from later targeting runs, so no AI quota is spent re-judging them; other candidates stay idempotent via the `ai` decisions trail.
- **Tests** (`test/funnel-inbox.test.ts`, 15 cases; funnel-target/ai test suites updated for the 2-call-per-draft flow): approve/reject end to end through the relay, text override, kill-switch/dedupe/budget/quiet-hour blocks, modes, content retry, no-tweet-id failure. Full suite: 127 tests / 11 files green; typecheck clean.

**Deferred follow-up:** a relay that never reports a claimed write leaves its draft `executing` (command stale-claim sweep exists in maintenance, but the draft side has no reconcile pass yet).
