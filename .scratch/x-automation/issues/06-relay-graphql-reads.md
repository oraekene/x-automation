# 06 — Relay X client: GraphQL reads

**What to build:** The read-side X GraphQL layer on top of the transport: three-tier queryId resolution (client.json → fallback constants → fetched), and the queries the funnel needs — search (advanced operators, cursor pagination), user posts (timeline), and profile lookups (bio, followers, verified, location). Responses map into the product's domain types. Demo: a relay search command returns real results with pagination.

**Blocked by:** 05

**Status:** ready-for-agent

- [ ] queryId resolution works across the three tiers with a documented refresh path
- [ ] Search query builder supports keywords, operators, engagement thresholds, time windows, language; cursor pagination returns all pages
- [ ] User-posts and profile-lookup queries return the fields the funnel needs
- [ ] Search / user-posts / profile commands execute via the relay command channel and report real results
