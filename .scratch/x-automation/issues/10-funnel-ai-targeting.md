# 10 — Funnel Stage 3: AI targeting + provider config

**What to build:** The user-keyed AI layer: provider configuration (base URL + API key + model, with the prefilled free-endpoint menu: NVIDIA NIM, OpenCode Zen, Groq, Gemini, OpenRouter, Cerebras, Mistral, GitHub Models, Cloudflare Workers AI), and the AI targeting verdict on each candidate: action (reply | quote | skip), reason, priority — against the targeting profile. Drafts (with verdict) written to D1 and listed in the dashboard.

**Blocked by:** 09

**Status:** done

- [x] User configures provider triple in dashboard; menu prefills known free endpoints
- [x] AI targets each surviving candidate against the targeting profile and outputs action/reason/priority
- [x] Drafts persisted to D1 with verdict, provider, and model used
- [x] Dashboard lists drafts with action, reason, priority
- [x] Provider failure handled: no draft produced, error surfaced in the audit trail, retried on next run + hourly

## Implemented
- `provider_configs` (one row per user) + `drafts` (UNIQUE user+candidate) — migration 0007
- `lib/ai.ts` — OpenAI-compatible `/chat/completions` client, tolerant JSON verdict parsing, 30s timeout, 9 free-endpoint presets
- `lib/target.ts` (targeting pass) + `lib/funnel-run.ts` (Stage 2+4 derivation shared with `/filter`)
- Routes: `PUT /api/provider` (key stored, masked on read), `GET /api/provider`, `GET /api/provider/presets`, `GET /api/drafts`, `POST /api/funnel/target` (on-demand, idempotent; 404/409)
- Decisions audit trail gains stage `ai`: draft | skip | fail (rules `ai_target` / `ai_fail`); skip verdicts never create draft rows
- Already-judged candidates (latest ai decision draft|skip) are never re-called; failures retried
- Hourly bounded `retryAiTargeting` sweep on MAINT_CRON (cap per user); targeting profile sent to the LLM as the fixed reference
- Dashboard: provider form (preset menu + masked key), run-targeting button with failure feedback, drafts table
- Coverage: `worker/test/lib/ai.test.ts` (13) + `worker/test/funnel-target.test.ts` (11). Full suite 106 green.

## Deferred
- Draft content generation (reply/quote text), inbox approve/reject, execution through relay write commands → ticket 11
- `score` column carries the AI priority (1–5) for stage-ai rows (audit semantics; kept as-is)