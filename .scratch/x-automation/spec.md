# Free X Automation Tool

Status: ready-for-agent

## Problem Statement

Social media automation on X is either expensive or brittle. The official X API has no free tier (free tier discontinued Feb 2026; reads ~$0.005/post, writes ~$0.015/tweet, replies ~$0.010/tweet, tweets with URLs ~$0.20/tweet), quote-posts were removed from all self-serve tiers (Apr 2026) so they are Enterprise-only on the official API, and there is no streaming. Existing open-source tooling does not fill the gap: the n8n corpus contains no workflow that can quote-tweet, branch between reply and quote, or run a true multi-turn conversation; schedulers like Postiz use official OAuth and cannot search, reply, quote, or converse. A person wanting a completely free tool that finds relevant posts, replies/quotes to them with AI- or endpoint-generated content, carries on natural multi-turn conversations, and posts on a schedule has no working option.

## Solution

A free, multi-user, multi-account X automation tool hosted on the Cloudflare free tier, built as a native application (not n8n). Each user gets a dashboard where they define automations: search criteria, a targeting profile, budgets, schedules, and reply style. A Cloudflare Worker runs the whole decision funnel and schedule; a small host-agnostic Relay process on the user's own machine (laptop, NAS, Raspberry Pi, phone, or an always-free VM) executes every X action using the user's own cookie session (auth_token + ct0) from a residential IP. All AI calls go to any OpenAI-compatible endpoint using the user's own API key (free endpoints prefilled: NVIDIA NIM, OpenCode Zen, Groq, Gemini, OpenRouter, Cerebras, Mistral, GitHub Models, Cloudflare Workers AI). Every generated action is written to D1 as a draft, reviewable in an inbox, and executed automatically, from the inbox, or never — per user preference. Two usage modes share one engine: outbound (responding to searched posts) and inbound (replies/quotes to the user's own tweets, which start multi-turn conversations). A queue-and-catch-up design means nothing is lost when the user's Relay is offline. Cost to the operator: $0.

## User Stories

1. As a user, I want to sign in to the dashboard with just my email (OTP via Cloudflare Access), so that I don't have to manage another password.
2. As a user, I want my own dashboard showing only my accounts, automations, and conversations, so that other users cannot see my data.
3. As a user, I want to connect one or more X accounts to the tool by pairing a Relay with my account, so that I can run automation per account.
4. As a user, I want the Relay to generate a pairing code so that the dashboard and my local Relay can authenticate each other.
5. As a user, I want to install and run the same Relay binary on my laptop, NAS, or a free VM, so that I can choose where automation executes.
6. As a user, I want the Relay to store my X cookies only on my own machine, so that my session never leaves my control.
7. As a user, I want the Relay to encrypt cookies at rest, so that my session survives restarts.
8. As a user, I want the dashboard to queue my commands while my Relay is offline, so that no automation work is lost.
9. As a user, I want queued commands to execute when my Relay comes back online, so that I get catch-up behavior without manual intervention.
10. As a user, I want to create an automation with search criteria (keywords, hashtags, mentions, engagement thresholds, time windows, language), so that the tool finds posts worth responding to.
11. As a user, I want the tool to search for both target tweets and target profiles (bio, follower count, verified, location), so that I can find an audience as well as individual posts.
12. As a user, I want the tool to find candidates semantically similar to my targeting profile, so that I catch posts my keyword search misses.
13. As a user, I want a targeting profile that describes my audience and intent, so that AI decisions have a fixed reference.
14. As a user, I want a deterministic heuristic stage that cheaply filters candidates down to a manageable set, so that AI cost stays near zero.
15. As a user, I want the AI to decide, per candidate, whether to reply, quote, or skip — with a reason and priority — so that my posting is purposeful.
16. As a user, I want to see every AI decision in an inbox with the draft, reason, and priority before anything posts, so that I stay in control.
17. As a user, I want three execution modes — manual inbox, automatic, hybrid (auto below a threshold, inbox above it) — so that I can dial automation up or down.
18. As a user, I want per-account kill switches, so that I can stop a single account instantly without touching others.
19. As a user, I want budgets (max posts/day, max replies/day, quiet hours), so that the tool never spams.
20. As a user, I want dedupe across automations and accounts, so that no post is responded to twice.
21. As a user, I want an allowlist and a blocklist for accounts, so that the tool only engages who I want.
22. As a user, I want the AI to draft reply and quote content in my style and voice, so that my account sounds like me.
23. As a user, I want quotes to be generated with the quoted post attached, so that I can quote-tweet despite the official API losing that capability.
24. As a user, I want to run multi-turn conversations with people who reply to my posts, so that engagement continues naturally.
25. As a user, I want deterministic conversation limits — max turns (default 5, cap 8), per-user conversation budgets, inactivity timeout, quiet hours — so that conversations never run away.
26. As a user, I want semantic conversation termination — the AI ends when the goal is met, loops are detected, or signals decay — so that conversations end naturally, not arbitrarily.
27. As a user, I want to configure every termination parameter myself, so that I control when the bot stops talking.
28. As a user, I want to see why every conversation ended, so that I can tune my settings.
29. As a user, I want to schedule automations per my timezone (every 15 min, hourly, daily at 9am), so that the tool runs when I want it to.
30. As a user, I want scheduling to work within the Cloudflare free tier (5 cron triggers), so that the tool stays free.
31. As a user, I want a scheduler that reads due jobs from a table and fans them out, so that one tick drives all automation.
32. As a user, I want to write a general post and schedule it, so that the tool also covers scheduled posting.
33. As a user, I want my own AI API key and endpoint configured once, so that all AI features use my chosen provider.
34. As a user, I want a menu of free AI endpoints to pick from, so that I don't have to research providers.
35. As a user, I want the AI layer to be OpenAI-compatible and provider-agnostic, so that I can switch providers or use my own.
36. As a user, I want drafts to be written to D1 before execution, so that I can review and reject anything.
37. As a user, I want a webhook (POST /api/content) as an alternative content source, so that external tools can feed content in.
38. As a user (external job-hunting tool), I want to send a targeting profile via POST /api/targeting and receive results, so that a Hermes Agent plugin can drive this tool.
39. As a user, I want per-user AI keys and credentials, so that no key is shared between users.
40. As a user, I want an admin path beyond 50 users that swaps Access for self-built email magic-link auth, so that the product can grow without $7/user/month.
41. As a user, I want the tool to be entirely free on Cloudflare free tier, so that my costs are zero.
42. As a user, I want the Relay to run from my residential IP, so that X sees a normal human-like session rather than a datacenter IP.
43. As a user, I want human-like pacing (jitter, delays) on X actions, so that my account is not flagged.
44. As a user, I want error handling with retries and backoff for X failures, so that transient failures don't lose commands.
45. As a user, I want the dashboard to show my relay's online/offline status and queued command count, so that I know whether catch-up is pending.

## Implementation Decisions

### Architecture (locked, see ADRs 0003–0006)

- **No official X API.** All X interaction is via the user's cookie session (auth_token + ct0) over X's internal GraphQL API. twitter-cli (public-clis) is the reference implementation: quote via CreateTweet + attachment_url, three-tier queryId resolution, error taxonomy, rate-limit handling, filter.py scoring.
- **Cloudflare coordinates, Relay executes (ADR-0004).** Worker owns state, scheduling, decisioning, auth. Relay is a host-agnostic single-file process that polls the Worker for commands and executes X actions from the user's IP. Commands queue in D1 while offline; catch-up executes them on reconnect. Pairing code binds a Relay to a user.
- **AI layer is user-keyed and provider-agnostic (ADR-0005).** AI calls use an OpenAI-compatible endpoint configured per user as base URL + API key + model triple. Prefilled free endpoints: NVIDIA NIM (build.nvidia.com), OpenCode Zen (opencode.ai/zen/v1), Groq, Gemini (AI Studio), OpenRouter free models, Cerebras, Mistral La Plateforme, GitHub Models, Cloudflare Workers AI. Drafts land in D1 before execution.
- **Auth via Cloudflare Access (ADR-0006).** Email OTP, free up to 50 users, per-user scoping enforced in code behind a thin getUser() boundary; swap seam to self-built magic-link auth in D1 beyond 50 users.
- **Scheduling (accepted Option A).** One per-minute "tick" cron reads a schedules table in D1 (`next_run_at <= now AND status='active'`), fans out due jobs inline, recomputes next_run_at in the user's timezone. Uses 1 of 5 cron slots; slot 2 = hourly maintenance (conversation sweeper, stale-command cleanup); slot 3 = daily budget resets.

### Funnel (all stages user-configurable, automated defaults plus manual overrides)

1. **Universe** — broad candidate set: deterministic search passes (operators, engagement thresholds, time windows) plus semantic passes (embedding/AI-assisted discovery of tweets and profiles). Profile search included.
2. **Heuristic filter** — cheap deterministic rules (engagement, freshness, language, blocklist) reduce to ~50.
3. **AI targeting** — LLM judges each candidate against the targeting profile; outputs action (reply | quote | skip), reason, priority.
4. **Guardrails** — budgets, diversity, dedupe, spam filter, allowlist/blocklist, quiet hours, per-account kill switch.

### Relay contract

- `POST /api/relays/pair` — pairing code exchange.
- `GET /api/relays/<id>/commands` — poll (every ~5s), returns pending commands (search, post, reply, quote, conversation-turn) including queued catch-up backlog.
- `POST /api/relays/<id>/results` — report outcome per command.
- Relay holds cookies, TLS-fingerprint impersonation (curl_cffi-style), pacing/jitter, and the twitter-cli-style error taxonomy with backoff.

### Conversation model

- Started by inbound replies to the user's own tweets; shares the funnel's engine for content generation.
- Termination = deterministic layer (max turns default 5 / cap 8, per-user budgets, inactivity timeout, quiet hours) + semantic layer (AI outputs continue | close_with_message | close_silent with reason; goal-completion, loop detection, signal decay). All parameters user-configurable; every close logged with reason.

### API contracts (dashboard/automation surface)

- `POST /api/automations` — create automation (search criteria, targeting profile, schedule, budgets, mode).
- `POST /api/targeting` — external targeting profile submission (e.g., Hermes Agent plugin).
- `POST /api/content` — webhook content source for posting.
- `POST /api/results` — external results feed-back.
- Drafts/inbox: `GET/POST /api/drafts`, execution from inbox.

### Data model (D1)

- Users, Relays, Accounts (per user), Automations, Schedules, Commands (queued actions), Drafts, Conversations, Messages, Decisions (funnel audit trail), Budgets/Dedup state.

## Testing Decisions

- **Seam 1 — Worker API:** test at the HTTP boundary against a local Workers dev instance with a test D1. Good tests exercise external behavior: create automation → tick runs → draft created; budget exceeded → no action; relay offline → command queued; relay reports success → draft marked executed. Never test internal implementation.
- **Seam 2 — Relay:** test the relay against a fake Worker endpoint (stubbed command queue and result recorder); X GraphQL calls mocked. Verify: pairing, polling loop, execution of each command type, error/backoff taxonomy, catch-up backlog execution order.
- **AI provider:** mocked as an OpenAI-compatible stub at the Worker boundary; fixture responses for reply/quote/skip and conversation-termination verdicts.
- **Prior art:** none in this repo (greenfield); pattern-borrow from twitter-cli's own test fixtures and smaug's queue tests as external references.

## Out of Scope

- Official X API integration (paid) — deliberately never used.
- Postiz or other schedulers as execution backends (scheduler-posting via official OAuth contradicts the free, quote-capable design; used as external reference only).
- Paid residential proxy services.
- Streaming API (does not exist on any usable tier).
- Direct posting from the Worker itself (experimental "worker-only mode" noted but not built; datacenter egress risk).
- DMs, likes, follows, retweet-as-action (post/reply/quote only in v1).
- Mobile apps; native mobile relay is possible (Termux-style) but not a v1 deliverable.
- Multi-region failover, SLA, uptime guarantees.

## Further Notes

- Free-tier budget math: tick = 1,440 req/day of 100K; D1 reads 5M/day; KV 100K reads/day — headroom is large.
- Ban-risk posture: residential IP relay, human pacing, aged accounts, stable IP per account, read-heavy at low risk / writes at higher risk — pacing and consistency are the mitigations; no datacenter egress on any production path.
- Reference implementations: twitter-cli (quote path, queryId resolution, error taxonomy), smaug (queue + lock-file + state-file dedupe + scheduler), huginn (event graph, memory, since_id), x-poster (atomic token store, single-flight refresh, human gating), AutoCLI (adapter pipeline, session reuse, backoff).
- The 7131 n8n workflow (search → agent → reply via inReplyToStatusId) is the corpus reference for the outbound skeleton only; it lacks quote, branching, and conversation loop, which this tool adds.
- Next step after this spec: break into tracer-bullet tickets (`/to-tickets`).
