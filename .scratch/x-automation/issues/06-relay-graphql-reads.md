# 06 — Relay X client: GraphQL reads

**What to build:** The read-side X GraphQL layer on top of the transport: three-tier queryId resolution (client.json → fallback constants → fetched), and the queries the funnel needs — search (advanced operators, cursor pagination), user posts (timeline), and profile lookups (bio, followers, verified, location). Responses map into the product's domain types. Demo: a relay search command returns real results with pagination.

**Blocked by:** 05

**Status:** done

- [x] queryId resolution works across the three tiers with a documented refresh path
- [x] Search query builder supports keywords, operators, engagement thresholds, time windows, language; cursor pagination returns all pages
- [x] User-posts and profile-lookup queries return the fields the funnel needs
- [x] Search / user-posts / profile commands execute via the relay command channel and report real results

## Notes (ticket 06 done, @ 2026-08-03)

- `relay/xreader.py` is the read layer: `QueryIdResolver` (vendored
  `client.json` → `FALLBACK_QUERY_IDS` → injected fetch, cached, vendored tier
  wins), `SearchCriteria.to_x_query()` (keywords, #hashtags, from:mentions,
  min_faves/retweets/replies, lang, since/until), `Tweet`/`UserProfile`
  dataclasses, a shared `_walk_pages` cursor walker, and the `XReader` facade
  (`search`/`user_posts`/`profile`).
- Refresh path: replace `relay/client.json` with a fresh X snapshot (tier 1) or
  inject a `fetch` loader (tier 3); docstring documents both.
- `whoami` now accepts a `query_id` so the CLI resolves `UserByScreenName`
  through the three-tier resolver (ticket 05 backlog note closed); its 4-field
  output contract is unchanged.
- `xclient.user_from_result` is the shared UserByScreenName mapper used by both
  `whoami` and `profile_lookup` (dedupe).
- Command channel: `search` / `user_posts` / `profile` execute via
  `execute_command(reader=...)` with an injected reader seam; `relay run`
  builds the real reader from the cookie store and degrades to clean
  `ok: False` if the store is unavailable. Demo: `relay search --min-faves 10
  keywords...` walks pages and prints results.
- Deferred: profile *search* (spec funnel "profile search included") — ticket
  08 (funnel universe) owns profile candidates; read layer here delivers
  per-account profile lookup only.
