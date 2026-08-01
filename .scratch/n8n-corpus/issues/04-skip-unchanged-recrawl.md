# 04 — Re-crawl skips unchanged repos

**What to build:** Re-running a Crawl against a Source repo whose remote HEAD SHA matches its recorded Pin skips cloning entirely — a no-change re-Crawl becomes a quick SHA check, not a re-download (n8n-docs is ~900 MB). Changed repos re-mirror and re-pin. Because the skip path must still produce a complete, current Manifest, it re-runs the workflow-aware and docs indexing against the existing mirror without re-cloning.

**Blocked by:** 01 — First crawl end-to-end, 02 — Workflow-aware index, 03 — Docs index

**Status:** done

- [x] A re-Crawl of an unchanged repo performs no clone and records no new Pin
- [x] A re-Crawl of a changed repo re-mirrors and re-pins
- [x] After a skipped re-Crawl, the Manifest is still complete and current (indexing re-run against the existing mirror)
- [x] SHA comparison and skip logic verified against fixture remotes, no real network

## Comments
