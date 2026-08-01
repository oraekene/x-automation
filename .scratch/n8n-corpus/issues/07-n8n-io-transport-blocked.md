# 07 — n8n.io transport is blocked from the crawl environment

**What to build:** Live n8n.io workflow-page following is currently impossible from this machine: every request to n8n.io fails (default urllib UA → HTTP 403; browser UA → connection reset or full timeout; curl → no route). AtharvaDomale's README alone carries 3200+ n8n.io links, each burning the full fetch timeout, so a follow-enabled crawl of that repo takes hours and produces nothing but flags. Ticket 05's page-to-JSON extraction mechanics (`<script type="application/json">` containing workflow-shaped JSON) are fixture-verified but unverified against the live site.

**Blocked by:** None

**Status:** ready-for-agent

- [ ] Decide and implement a transport that reaches n8n.io from this environment (browser-grade TLS/UA handling, proxy, or documented alternative)
- [ ] Re-run the follow step for AtharvaDomale (and other repos with n8n.io links) and verify real workflow pages yield workflow JSON + guide text
- [ ] Confirm or correct the page-to-JSON extraction mechanics against the live site
- [ ] Reconsider the per-request timeout / retry policy for the follow step (currently 10 s, sequential)

## Comments

Escape hatch already shipped: `--no-follow` (crawler.crawl follow=False) lets the mirror/index crawl run without the blocked fetch step; the smoke crawl of all six repos used it and produced 2510 workflows + 1554 docs with zero flags. Everything in the follow pipeline is fixture-verified (unit + loopback HTTP, truncated-response and dedupe paths included).
