# Spec: The n8n Corpus

Status: ready-for-agent

## Problem Statement

There is no local, queryable knowledge base of the n8n ecosystem. The official docs live on a live website that tracks `main`; workflow collections are scattered across six GitHub repositories with six different organizational conventions; and at least one of the most valuable collections (AtharvaDomale's, 500+ entries) is nothing but a link catalog pointing at n8n.io community workflow pages. Working with n8n today means being online, losing provenance, and manually cross-referencing six repos whose contents drift independently.

## Solution

A separate project, `n8n-corpus`, that builds and maintains a local Corpus of the n8n ecosystem: a Crawl clones the six Source repos at pinned commit SHAs into a per-source mirror, follows workflow links one hop out into a fetched area, and indexes everything into a workflow-aware Manifest. The Corpus is queried with ripgrep and the Manifest, fully offline, exactly as the hermes corpus works for Hermes-Agent.

## User Stories

1. As a user, I want to crawl all six Source repos (Zie619/n8n-workflows, n8n-io/n8n-docs, lucaswalter/n8n-ai-automations, AtharvaDomale/awesome-n8n-templates, enescingoz/awesome-n8n-templates, wassupjay/n8n-free-templates) so that the Corpus contains everything they ship.
2. As a user, I want each Source repo mirrored faithfully at its default-branch HEAD, so that the Corpus is an exact copy of upstream minus `.git` (per ADR-0001, pinned to a commit SHA — five of six repos publish no releases).
3. As a user, I want the Manifest to record each Source repo's Pin (commit SHA) and crawl time, so that I can answer "exactly which upstream state is in this Corpus?"
4. As a user, I want every Workflow in the Corpus identified by its structural signature (`name`, `nodes`, `connections` keys), not by folder or filename, so that workflows are found regardless of how each repo organizes them.
5. As a user, I want each Workflow's metadata extracted into the Manifest (name, description, node count), so that I can find workflows by purpose without opening every JSON.
6. As a user, I want all markdown in all six repos indexed as docs (n8n-docs pages plus every README/guide), so that workflow collections are self-documented and cross-referenceable.
7. As a user, I want top-level dirs of each repo represented in the Manifest with README-derived one-liners, so that the repo structure is navigable from the map.
8. As a user, I want Workflows followed out of the repos: links whose target is an importable n8n workflow (n8n.io community pages, raw workflow JSONs) are fetched and stored, so that link catalogs like AtharvaDomale's yield real content (ADR-0003).
9. As a user, I want each Followed workflow stored together with its page/guide text as one unit, so that the workflow's own documentation travels with it.
10. As a user, I want link-following to stop at one hop, so that the Corpus never becomes a general web crawler (ADR-0003).
11. As a user, I want Followed workflows deduplicated by content hash against the mirror — mirror copy wins — with the resolution recorded in the Manifest, so that workflows Zie619 already mirrors are not duplicated (Zie619 claims to include "also from the site itself").
12. As a user, I want the Manifest to record provenance for every Followed workflow (which Source repo's link led to it, the target URL, the n8n workflow id), so that every entry can be traced back to its origin.
13. As a user, I want non-workflow links (blogs, external docs, videos) to remain as text inside the repo READMEs and never be followed, so that the Corpus stays bounded.
14. As a user, I want docs content to come from the pinned repo tree, never the live docs site, so that docs and workflows are version-consistent within the snapshot (ADR-0002).
15. As a user, I want a re-Crawl to skip any Source repo whose remote HEAD SHA matches its recorded Pin, and to re-follow links only when the linking repo's tree changed, so that a no-change re-Crawl is a quick check instead of a ~1 GB re-download.
16. As a user, I want the Corpus queryable with ripgrep across all mirrored trees and fetched content, so that I can search workflows and docs together offline.
17. As a user, I want the Manifest to reuse an in-tree `llms.txt` as the docs index where a Source repo ships one (enescingoz does), so that existing indexes are respected.
18. As a user, I want app code (e.g. Zie619's Python server) present in the mirror but unindexed, so that it remains searchable without polluting the Manifest.

## Implementation Decisions

- **Project shape**: a self-contained project under `n8n-corpus/` with its own glossary (`CONTEXT.md`), ADRs (`docs/adr/`), crawl script, and Corpus directory; part of the workspace repo's tree, single-context.
- **Corpus layout**: per-source mirror (`repos/<owner>-<name>/` per Source repo, `.git` stripped) plus a fetched area (`fetched/`, per-source subdirs) for Followed workflows; one Manifest at the Corpus root. Mirrors stay faithful to upstream; derived content lives in the fetched area only.
- **Crawl script**: stdlib-only Python, modeled on the hermes `scripts/crawl.py` (pure functions for parsing/indexing; thin imperative shell for cloning, fetching, and filesystem work). No dependencies beyond the standard library.
- **Pinning**: each Source repo cloned at its default-branch HEAD; Manifest records per-repo commit SHA and crawl timestamp. Re-Crawl compares remote HEAD SHA to the recorded Pin and skips unchanged repos (ADR-0001).
- **Workflow detection**: a file is a Workflow iff its JSON has the structural signature (`name`, `nodes`, `connections`). Detection is folder- and filename-agnostic. Extraction covers name, description, and node count.
- **Docs indexing**: every markdown file in every Source repo is indexed; Docusaurus-style frontmatter provides titles/descriptions where present; an in-tree `llms.txt` (llmstxt.org format, e.g. enescingoz) is parsed as the index for that repo when present. Top-level dirs get README-derived one-liners. App code and binary assets are not indexed.
- **Link-following**: scan the mirror for links; follow a link iff its target is an importable n8n workflow (n8n.io community workflow page or raw workflow JSON). Each fetch stores the workflow JSON plus its page/guide text as one unit under the fetched area, keyed by source repo. One hop only; out-links of fetched pages are ignored (ADR-0003).
- **Dedupe**: canonicalized content hash over workflow JSON. When a Followed workflow's hash matches an in-mirror Workflow, no copy is stored; the Manifest records the link as resolving to the mirror path. When it matches another fetched entry, one copy wins and the Manifest records the alias.
- **Manifest schema**: pinned metadata per repo (SHA, crawled_at), workflow entries (path, name, description, node count), docs entries (path, title, description), followed entries (source repo, target URL, n8n id, guide text path, dedupe resolution), top-level dirs, and crawl flags (e.g. oversized dirs, unresolvable links). The Corpus is queried by reading files or ripgrep; the Manifest is the map.
- **Docs source**: docs content comes exclusively from the pinned repo tree; the live docs site is never crawled (ADR-0002).
- **Failure policy**: unresolvable links and unreachable repos are recorded as crawl flags in the Manifest rather than aborting the Crawl; a re-run retries them.

## Testing Decisions

- A good test asserts the Manifest's external behavior from fixture inputs: given a fixture repo tree (or parsed inputs) and fixture fetched pages, the produced Manifest entries, dedupe resolutions, and flags must be exactly right. No network, no real clones, no real fetches.
- The tested module is the pure-function layer — workflow detection, metadata extraction, docs/link parsing, dedupe, and manifest building. The imperative shell (clone, HTTP fetch, filesystem writes) is thin and untested, matching the seam the user approved.
- Prior art: the hermes `scripts/crawl.py` separates pure parsing (`parse_llms`, `build_manifest`) from I/O (`clone_repo`, `fetch`); tests follow the same split. The repo has no existing test suite; tests are stdlib `unittest` to stay dependency-free, in the n8n-corpus project.

## Out of Scope

- Multi-snapshot history or archiving of past crawls.
- Following non-workflow links (blogs, videos, other repos' docs) or any second-hop following.
- Crawling the live docs.n8n.io site (ADR-0002).
- Deduping beyond exact content-hash matches (no fuzzy similarity, no cross-repo canonicalization by name).
- A search UI or query tooling beyond ripgrep + Manifest.
- Indexing Zie619's application code, or any repo's build artifacts/binaries.
- Licensing review or redistribution concerns.

## Further Notes

- AtharvaDomale's 2.4 MB README is the primary link source (500+ rows in table form); its format needs a tolerant parser at implementation time.
- Zie619's only release is a DMCA history-rewrite marker, not a version — irrelevant to crawling but a reminder that upstream history can be rewritten; the Corpus only ever depends on the pinned working tree.
- n8n.io community workflow pages embed the workflow JSON; the exact extraction endpoint is an implementation detail to resolve during the build.
- The three ADRs (pin-to-SHA, docs-from-pinned-tree, followed-workflows-one-hop) and the seven-term glossary in `n8n-corpus/CONTEXT.md` are authoritative for vocabulary and invariants.
