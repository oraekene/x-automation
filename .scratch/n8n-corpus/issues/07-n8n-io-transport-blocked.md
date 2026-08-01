# 07 — n8n.io transport is blocked from the crawl environment

**What to build:** Live n8n.io workflow-page following is currently impossible from this machine: every request to n8n.io fails (default urllib UA → HTTP 403; browser UA → connection reset or full timeout; curl → no route). AtharvaDomale's README alone carries 3200+ n8n.io links, each burning the full fetch timeout, so a follow-enabled crawl of that repo takes hours and produces nothing but flags. Ticket 05's page-to-JSON extraction mechanics (`<script type="application/json">` containing workflow-shaped JSON) are fixture-verified but unverified against the live site.

**Blocked by:** None

**Status:** done

- [x] Decide and implement a transport that reaches n8n.io from this environment (browser-grade TLS/UA handling, proxy, or documented alternative)
- [x] Re-run the follow step for AtharvaDomale (and other repos with n8n.io links) and verify real workflow pages yield workflow JSON + guide text
- [x] Confirm or correct the page-to-JSON extraction mechanics against the live site
- [x] Reconsider the per-request timeout / retry policy for the follow step (currently 10 s, sequential)

## Resolution

Root cause was not a hard network block but a missing User-Agent: n8n.io (and its api.n8n.io backend) answer `403 Forbidden` to urllib's default `Python-urllib` agent. With a browser-like UA, both the homepage and workflow pages return 200. The earlier connection-resets/timeouts were transient n8n.io edge failures.

Second discovery: current n8n.io workflow pages are Nuxt apps and **no longer embed the workflow JSON** in their HTML (Ticket 05's script-tag extraction is dead against the live site). The site renders from the official templates API: `GET https://api.n8n.io/api/workflows/<numeric-id>` returns `{"data": {"workflow": {...}, "description": "..."}}`. Some records omit the workflow's `name` key (it lives on the parent record) — the crawler fills it in so the stored JSON keeps the structural signature.

Shipped (uncommitted at time of writing):
- `fetching.fetch` sends `BROWSER_UA` and retries transient failures (network errors, 5xx) with 1.5× backoff, up to 3 attempts; definitive 4xx (404 dead links, 403 blocks) are not retried.
- `links.is_n8n_page`, `links.n8n_api_url`, `links.extract_api_workflow` (pure, tested — 8 new tests, suite at 82).
- `crawler._follow_links` uses the API as primary source for n8n.io links (guide text = the record's description), falling back to page fetch + script extraction.

Live verification (3 crawl runs, all `--only atharvadomale-awesome-n8n-templates --force`, ~38 min each for 3230 links):
- Run 3 (with retries): **3203 followed** (3196 stored, 7 alias), **27 flags**, zero transient failures.
- All 27 flags are genuinely dead templates (API 404s — links stale in AtharvaDomale's catalog; 4568 appears twice via two different URLs). Sample-probed: 26 unique IDs all HTTP 404; 9 other flagged IDs re-checked manually returned valid workflows in earlier runs, confirming the transient failures the retry now absorbs.

Follow-up candidates (not done):
- The five other source repos may carry n8n.io links too (zie619/n8n-docs embed `api.n8n.io/workflows/templates/<id>` demo URLs, which `is_workflow_link` does not classify as workflow links today).
- `--no-follow` remains the escape hatch and stays documented as such.

## Comments

Escape hatch already shipped: `--no-follow` (crawler.crawl follow=False) lets the mirror/index crawl run without the blocked fetch step; the smoke crawl of all six repos used it and produced 2510 workflows + 1554 docs with zero flags. Everything in the follow pipeline is fixture-verified (unit + loopback HTTP, truncated-response and dedupe paths included).
