# 02 — Workflow-aware index: detection and metadata extraction

**What to build:** Every Workflow in a mirrored Source repo is found by its structural signature (`name`, `nodes`, `connections` keys in the JSON), never by folder or filename convention, and appears in the Manifest with extracted metadata: name, description, and node count. App code and binary assets stay present in the mirror but unindexed.

**Blocked by:** 01 — First crawl end-to-end

**Status:** done

- [x] Workflow detection works across all six repos' organizational conventions (root-level JSONs, category dirs, `workflows/`, `templates/`), driven by structure alone
- [x] Each detected Workflow yields a Manifest entry with name, description, and node count
- [x] Non-workflow files (app code, configs, binaries, images) produce no Manifest entries
- [x] Detection and extraction are pure functions verified by fixture trees, no network

## Comments
