# X Automation Tool Research Report

Research into three repos (smaug, last30days-skill, x-cli) to extract reusable architecture for a new, fully-free X/Twitter automation tool supporting: search-by-criteria, AI-reply posting, quote tweets, multi-chained replies, reply-vs-quote decisioning, and general posting.

Repo locations (read-only analysis; no code written):

- `C:\Users\rotim\AppData\Local\Temp\opencode\bots\smaug`
- `C:\Users\rotim\AppData\Local\Temp\opencode\bots\last30days-skill`
- `C:\Users\rotim\AppData\Local\Temp\opencode\bots\x-cli`

---

## 1. Per-Repo Summary

### 1.1 smaug — bookmark/like archiver (Node.js + external bird CLI)

**What it is:** A scheduled Twitter/X bookmark (and/or like) archiver that fetches bookmarks, enriches them with content, sends them to an AI CLI (Claude Code or OpenCode) for categorization, and files them to Markdown. README.md:3-5.

**Auth:** Twitter session cookies — `auth_token` + `ct0` from browser devtools (README.md:57-81). Stored in `smaug.config.json` under `twitter.authToken` / `twitter.ct0`; also honored from env `AUTH_TOKEN` / `CT0` (README.md:366).

**X access mechanism:** No direct X code at all — shells out to the external `bird` CLI (@steipete/bird, a Twitter GraphQL scraper) for all Twitter data (README.md:37-39, 87). Setup wizard checks `bird --version` requires v0.5.0+ (src/cli.js). Smaug itself never talks HTTP to X.

**Posting:** NONE. Strictly read-only (bookmarks, likes, search, article lookup). No create/quote/reply path exists.

**Key architecture:** Two-phase pipeline (`src/job.js`):
- Phase 1 `fetch`: pull bookmarks via bird CLI → expand t.co links → enrich (GitHub API metadata, article extraction, X long-form articles, quote-tweet/reply-thread context) → append to `pending-bookmarks.json` (README.md:85-96).
- Phase 2 `process`: invoke Claude Code / OpenCode CLI with a project command file (`.claude/commands/process-bookmarks.md`) to categorize and file each pending item into `bookmarks.md` + `knowledge/`.

State management: `pendingFile` + `stateFile` JSON for dedupe/seen-tracking; lock file `os.tmpdir()/smaug.lock` prevents overlapping runs (src/job.js). Config categories with match/action/folder rules (config.js: categories `github` → file → `knowledge/tools/`, `article`/`x-article` → file → `knowledge/articles/`, `tweet` → capture; README.md:150-158). Parallel AI subagents kick in at `parallelThreshold` (default 8), using cheaper Haiku model for bulk categorization (README.md:363, 469-480). Scheduling via Bree (`examples/bree-scheduler.js`, interval `30m`) or pm2/cron/systemd (README.md:241-265). Webhooks (Discord/Slack) for notifications (README.md:364).

### 1.2 last30days-skill — agent skill for 30-day research reports (Python engine + vendored bird-search)

**What it is:** A packaged agent skill (installable via marketplace/`npx skills add`) that researches "what happened in the last 30 days" about a topic across ~12 sources (Reddit, HN, Polymarket, GitHub, X, YouTube, TikTok, IG, Bluesky, TruthSocial, Digg, StockTwits, arXiv…) and produces a multi-format report (Markdown/HTML/JSON) with clusters, signals, and stats. Version 3.18.4.

**Auth:**
- X path: AUTH_TOKEN + CT0 session cookies (env / .env), same pair as smaug.
- xurl path: free X Developer App bearer token (`xurl auth app-only <bearer-token>`).
- xAI path: XAI_API_KEY (paid, but enables official xAI `responses` endpoint with live search).
- Plus optional OPENAI/XAI/OPENROUTER/PERPLEXITY keys for enrichment, BSKY_*/TRUTHSOCIAL_TOKEN for other platforms.

**X access mechanism:** Four X discovery backends with a documented priority chain — **xAI API > Bird/GraphQL > xurl > web-only fallback** (`scripts/lib/xurl_x.py:11`):
1. `xai_x.py` — xAI Responses endpoint (`https://api.x.ai/v1/responses`) with a strict JSON schema prompt; depth config quick/default/deep (8-12 / 20-30 / 40-60 posts).
2. `bird_x.py` — Python wrapper around the **vendored** bird-search (subset of @steipete/bird v0.8.0) that calls the unofficial Twitter GraphQL API.
3. `xurl_x.py` — the official `@xdevplatform/xurl` CLI (free tier, app-only bearer), availability-probed via `xurl auth status` (regex `bearer:\s*✓`), memoized per process (xurl_x.py:27-48).
4. `xquik.py` — XQuik (no-auth public reader) as a fallback source.

**Vendored client internals (critical for the new tool):**
- `scripts/lib/vendor/bird-search/lib/twitter-client-constants.js` holds the whole X reverse-engineered API surface:
  - `TWITTER_API_BASE = https://x.com/i/api/graphql`
  - `TWITTER_STATUS_UPDATE_URL = https://x.com/i/api/1.1/statuses/update.json`
  - `TWITTER_UPLOAD_URL = https://upload.twitter.com/i/media/upload.json`
  - `TWITTER_MEDIA_METADATA_URL = https://x.com/i/api/1.1/media/metadata/create.json`
  - GraphQL query IDs (FALLBACK_QUERY_IDS): **CreateTweet `TAJw1rBsjAtdNgTdlo2oeg`**, **CreateRetweet `ojPdsZsimiJrUGLR1sjUtA`**, FavoriteTweet, CreateBookmark, SearchTimeline `M1jEez78PEfVfbQLvlWMvQ`, UserTweets `Wms1GvIiHXAPBaCr9KblaA`, Bookmarks `RV1g3b8n_SGOHwkqKYSCFw`, TweetDetail `97JF30KziU00483E_8elBA`, plus Following/Followers/UserArticlesTweets.
- `twitter-client-base.js`: requires BOTH authToken and ct0; Chrome UA; random clientUuid/clientDeviceId per session; `getQueryId` resolves runtime query IDs from `runtime-query-ids` JSON with FALLBACK_QUERY_IDS fallback.
- `bird-search.mjs`: **search-only client** — `withSearch(TwitterClientBase)`; comment at line 16: "Build a search-only client (no posting, bookmarks, etc.)". The CreateTweet/CreateRetweet/statuses/update.json constants are vendored but **unreachable** — the wiring for posting was deliberately excluded. This is the single most important reuse finding: the posting primitive surface (endpoints + query IDs) is already mapped out in this repo; only the client class is missing.
- `bird_x.py` details: MAX_JSON_DECODE_RETRIES = 2, delay 5.0s (HTML interstitial anti-bot handling); depth config quick=12/default=30/deep=60; token-overlap relevance ranking; normalizes bird camelCase engagement → snake_case (reposts, quotes, replies).

**Posting:** NONE. All four X sources are read/search-only. "quote"/"reply" appear only as engagement metrics or HTML/quote formatting — no tweet-creation code anywhere in the Python engine.

**Key architecture:** Skill = contract (SKILL.md prose + engine script). Engine = `scripts/last30days.py` (3,614 lines: arg parsing, SQLite trend registry, memory dir, subprocess management with child-PID kill on exit, source dispatch, pipeline, renderers, permission preflight, setup wizard). Harness = the agent runtime. The engine is invoked by the agent (Bash) and the agent does the synthesis (the "Judge Agent" section of SKILL.md:1580+). Zero-config install; per-run flags like `--x-handle`, `--x-related`, `--github-user`, `--subreddits`, `--web-backend brave`, `--auto-resolve`.

**Safety/QA pattern worth stealing:** Pre-flight flag resolution (SKILL.md:852+) and named failure modes with dates ("Peter Steinberger disaster #2" 2026-04-18: person topics MUST include `--x-handle` + `--github-user` + `--subreddits`; "best programming language for AI agents" counting-vs-judging failure). The repo documents failure modes as first-class artifacts for the agent.

### 1.3 x-cli — official X API CLI in Rust (v6.0.0)

**What it is:** A Rust re-implementation of the classic Ruby `x` gem CLI. Full command tree: `cli`, `delete`, `list`, `search`, `set`, `stream` + `accounts`, `set active`, `delete account`, `version`, `ruler` (README.md:19-20). V1.1 + V2 API with automatic fallback; streaming support (README.md:11-13).

**Auth:** Official X API — OAuth 1.0a (user context) and OAuth 2.0 (bearer). Credentials in YAML `~/.xrc` (fallback `~/.trc`, migrated on write; README.md:25). Multiple profiles keyed by `(username, consumer_key)`; active profile in config (`rcfile.rs:48-69`). File written mode 0600 on Unix (`rcfile.rs:105-133`). Interactive authorize flow uses OAuth 1.0a (x-api/src/oauth1.rs:5).

**X access mechanism:** Direct HTTP through the local `x-api` crate: reqwest blocking client; `backend.rs` defines a `Backend` trait (live + mock for tests — `run_with_backend` injects a fake backend, src/lib.rs:33-44). Auth scheme per request: OAuth1User vs OAuth2Bearer (backend.rs:70-77). Error formatting priority: `errors[]` messages → title+detail → error string → status reason, always prefixed with the status code so callers can match (`format_api_error`, backend.rs:20-57). Retry: `retry_with` 3 attempts, retries only 5xx and 429, **no delay/backoff sleep** despite README claim (backend.rs:129-163). V1.1 fallback on 503 for `/2/users/me` (runner.rs:3759-3775).

**Posting: YES — full write surface (most important repo for the new tool):**
- `update` — create tweet: `POST /2/tweets` body `{"text": ...}` + optional `media.media_ids` (runner.rs:578-597). Media via `POST /1.1/media/upload.json` with base64 `media_data` (single step, not chunked; runner.rs:3674-3701).
- `reply` — create reply: `POST /2/tweets` body `{"text": ..., "reply": {"in_reply_to_tweet_id": <id>}}` (runner.rs:598-648). **Auto-mention handling:** fetches parent tweet, builds `@author @mention1 @mention2` prefix from the parent's text (all mentions with `--all`), excludes self, sorts/dedups (runner.rs:604-629). Post-creation echo includes "Run `x delete status {id}` to delete" — easy undo affordance (runner.rs:643-646).
- `retweet` — `POST /2/users/{me_id}/retweets` with `{"tweet_id": id}` (runner.rs:537-555).
- `favorite` — `POST /2/users/{me_id}/likes` with `{"tweet_id": id}` (runner.rs:518-536).
- `dm` — `POST /2/dm_conversations/with/{target}/messages` (runner.rs:556-577).
- `delete status` / `delete favorite` / `delete block` / `delete mute` (runner.rs:1311-1361, with interactive y/N confirmation for delete status, runner.rs:1378).

**Search:** `search all` → `GET /2/tweets/search/recent?query=...` (runner.rs:1631-1651); `search timeline|mentions|favorites|retweets|list` fetch the source list then client-side filter `filter_tweets_by_query` (runner.rs:1652-1762). Pagination helper `collect_tweets_paginated` with MAX_SEARCH_RESULTS/page and MAX_PAGE cap, `next_token` handling (runner.rs:3372+, fetch_relationship_ids_v2 loop with `MAX_PAGE`, runner.rs:3817-3823).

**Reply-chain (read side):** `status` command walks the parent chain — up to 10 hops via `in_reply_to_status_id`, prints "In reply to:" chain (runner.rs:864-896). V2 tweet fields include `referenced_tweets`, `in_reply_to_user_id` (runner.rs:24); `normalize_v2_tweet` maps v2 → v1.1 shape including `in_reply_to_status_id` (runner.rs:4380-4455).

**Quote tweets: NOT supported.** No `attachment_url`, no `quote_tweet_id`, no quote command anywhere in the Rust code. The `status`/timeline readers surface `referenced_tweets` but there is no quoting writer.

**Notable architecture quirk:** the clap command tree is **generated by parsing the legacy Ruby source** — manifest.rs embeds `legacy/lib/t/*.rb` via `include_str!` and regex-extracts command/option specs at compile time (manifest.rs:8-14, 71-100). This is how they keep CLI parity with the Ruby gem.

---

## 2. Six-Capability Coverage

| Capability | smaug | last30days-skill | x-cli | Best source to steal from |
|---|---|---|---|---|
| **1. Search by criteria** | Indirect — bookmarks/likes only; `url:x.com/i/article/{id}` lookup search (src/processor.js `searchForArticleTweet`) | Rich: 4 X backends, priority chain, depth tiers, query crafting in planner.py/query.py, token-overlap relevance | Official: `search all` v2 recent search + 5 variants (timeline/mentions/favorites/retweets/list) with pagination | **x-cli** (official API, full query syntax) + **last30days** (fallback chains, relevance ranking, anti-bot retries) |
| **2. AI-reply posting** | None (AI is used for *categorization*, not posting) | None (AI used for research/synthesis) | Manual replies only (`x reply`); no AI integration at all | **x-cli `reply`** (mechanics) + **smaug** (AI-CLI subprocess pattern) — must be combined |
| **3. Quote tweets** | Read-only: quote-tweet *context extraction* for archiving (README.md:93) | None (quote = engagement metric only) | **None** — no quoting writer exists | Not available anywhere; must be built (v2 `quote_tweet_id` or v1.1 `attachment_url`) |
| **4. Multi-chained replies** | None | None | Read-side chain walk only (`x status`, runner.rs:864-896); no chained posting | Must be built on x-cli `reply` (feed new tweet id back as `in_reply_to_tweet_id`) |
| **5. Reply-vs-quote decisioning** | None | None | None | No precedent — needs own design |
| **6. General posting** | None | None | Full: update/reply/retweet/favorite/dm/delete + media | **x-cli** |

---

## 3. Explicit Quote-Tweet / Reply-Chaining / Conversation-Loop Findings

**Quote-tweet support:** NONE found in any of the three repos for *posting* a quote tweet.
- x-cli: no `attachment_url` / `quote_tweet_id` / quote command (exhaustive grep over all .rs files; only `referenced_tweets` read-side). v1.1 `attachment_url` and v2 `quote_tweet_id` would be the new implementations (v2: `POST /2/tweets` with `"quote_tweet_id"`).
- smaug: quote tweets are only *consumed* — full quote context is extracted and passed to Claude for archiving (README.md:93, 431).
- last30days: "quotes" appears only as an engagement count (bird_x.py:653, signals.py:162).
- The CreateTweet query ID exists in the vendored bird constants, but the GraphQL request body shape for quoting was never vendored, so it is not recoverable from these repos.

**Reply support:** Only x-cli, and only single-hop manual replies (`x reply <status_id> [text]` with `reply.in_reply_to_tweet_id`, runner.rs:598-648). The auto-mention prefix logic (parent author + all parent mentions via `--all`, self-excluded, sorted/deduped) is the strongest stealable piece.

**Multi-chained replies:** No repo posts chains. Read-side chain walk exists (x-cli `status`, up to 10 parents). Chained posting would chain `x reply` calls by reusing the returned tweet id.

**Conversation-loop support:** Only the read-side chain listing in x-cli (`status` walks parents; `normalize_v2_tweet` maps `referenced_tweets` → `in_reply_to_status_id`). No loop detection, no conversation tracking.

---

## 4. Steal-Worthy Patterns

**From smaug:**
1. **Two-phase job + JSON state files** (fetch → process with pendingFile/stateFile dedupe, src/job.js, config.js) — safe resumability for a long-running bot.
2. **Lock file** (`os.tmpdir()/smaug.lock`) to prevent overlapping scheduled runs (src/job.js).
3. **Bree scheduler pattern** (`examples/bree-scheduler.js`: named job, `interval: '30m'`, timezone, errorHandler, graceful SIGINT/SIGTERM) — plus pm2/cron/systemd docs (README.md:241-265).
4. **AI-CLI subprocess contract** — drive Claude Code/OpenCode via a project command file (`process-bookmarks.md`) with strict data-loss rules (NEVER Write to archive; always Edit; parallelize above threshold with a cheaper model; token tracking). This is the proven way to get AI-generated tweet text without an API key — directly applicable to "AI-reply posting" using a free CLI like OpenCode.
5. **parallelThreshold + haiku-subagent cost shaping** (README.md:469-480).

**From last30days-skill:**
1. **SKILL.md = runtime contract, engine = script** separation; agent (harness) does judgment, engine does deterministic work (CONCEPTS.md).
2. **Multi-backend priority chain with health probes** — xAI → Bird/GraphQL → xurl → web fallback (xurl_x.py:11), with memoized `is_available()` and a `doctor`/safe-diagnose path (xurl_x.py:42-48; health.py). Perfect blueprint for free-tier resilience.
3. **Anti-bot hardening**: Chrome UA + clientUuid/DeviceId + JSON-decode retry with 5s delay for HTML interstitials (bird_x.py; twitter-client-base.js).
4. **Query-ID resolution with runtime cache + fallback constants** (`getQueryId`, twitter-client-base.js) — the correct pattern for GraphQL endpoint stability.
5. **Credential layering**: env → .env file → flags, with a setup wizard that explains exactly which cookie to copy where (setup_wizard.py, env.py).
6. **Named failure modes with dates** in SKILL.md — docs that survive agent context loss.
7. **Child-process kill registry** on exit (last30days.py:56-83).

**From x-cli:**
1. **The whole official write surface** — `update`/`reply`/`retweet`/`favorite`/`dm`/`delete status` (runner.rs:518-648, 1311-1361). POST `/2/tweets` body shapes are the canonical reference for the new tool.
2. **Reply prefix construction** (runner.rs:604-629) — parent author + mentions, exclude self, dedupe.
3. **Backend trait + injected mock backend for tests** (backend.rs; lib.rs:33-44) — full CLI testability without network.
4. **Error message normalization with status-code prefix** (`format_api_error`, backend.rs:20-57) enabling machine matching (e.g., retry-on-429).
5. **Retry policy**: 3 attempts, only 5xx/429, immediate (no sleep) — simple and quota-safe; client errors fail fast.
6. **Multi-profile credential store** (`~/.xrc` YAML, username × consumer-key matrix, 0600 perms, active-profile selection) — supports multi-account bots.
7. **Idempotent-ish delete affordances** — after every post, echo "Run `x delete status {id}` to delete" (runner.rs:591-595, 643-646).

---

## 5. Implications for the New Tool

1. **Free access, two viable stacks:**
   - *Official API (recommended for posting)*: x-cli's exact patterns — OAuth1/OAuth2 with free developer app, `POST /2/tweets` + `reply.in_reply_to_tweet_id`. Note: x-cli's README claims backoff but none exists — add proper `Retry-After`-aware backoff.
   - *Cookie/GraphQL stack (free, no dev app)*: vendored bird-search constants (authToken+ct0, `https://x.com/i/api/graphql`, query IDs, statuses/update.json, upload URL) — the wiring for `CreateTweet` (`TAJw1rBsjAtdNgTdlo2oeg`) and `CreateRetweet` was mapped but not implemented; the new tool would implement those client methods.
2. **Quote tweets must be built new** — use v2 `quote_tweet_id` on `POST /2/tweets` (or v1.1 `attachment_url` for cookie-stack parity).
3. **Reply-vs-quote decisioning has no precedent in any repo** — it is a pure design task: likely driven by reply eligibility (protected accounts, conversation participants, parent being your own tweet → reply; else quote) and intent (visible commentary → quote, conversational → reply).
4. **Multi-chained replies** = iterate x-cli's `reply` (or CreateTweet with `in_reply_to_tweet_id`) feeding the new tweet id back; plus smaug's stateFile pattern for crash-safe chains (never re-post a tweet that already posted).
5. **AI text generation for free**: smaug's subprocess-CLI pattern (Claude Code / OpenCode with a project command file) avoids any paid API key; pair with x-cli's post mechanics.
6. **Search-by-criteria**: reuse last30days' multi-backend fallback design (xurl free bearer → bird cookies → web) for resilience; x-cli `search all` for official-API fidelity; planner.py/query.py quoting heuristics for query construction.
