# 05 — Follow workflow links, one hop, with provenance

**What to build:** Link lists inside the mirrored repos (AtharvaDomale's README table of 500+ entries, any raw workflow JSON links) are parsed, and links whose target is an importable n8n Workflow (n8n.io community workflow pages, raw workflow JSONs) are fetched and stored as one unit — the workflow JSON together with its page/guide text — under the fetched area, keyed by the Source repo whose link led there. The Manifest records provenance for each Followed workflow: source repo, target URL, and n8n workflow id. Non-workflow links (blogs, videos, other sites) remain as text and are never followed; no second hop is ever taken. Includes resolving the n8n.io page-to-JSON extraction mechanics.

**Blocked by:** 02 — Workflow-aware index (link classification reuses workflow detection)

**Status:** done

- [x] Workflow-targeted links from fixture link lists are fetched and stored as one unit (JSON + guide text)
- [x] Non-workflow links and second hops are never followed
- [x] Each Followed workflow's Manifest entry records source repo, target URL, and n8n id
- [x] Fetched content lands in the fetched area keyed by source repo, never in a repo mirror
- [x] Fetch path verified with fixture HTTP targets (no real network in tests)

## Comments
