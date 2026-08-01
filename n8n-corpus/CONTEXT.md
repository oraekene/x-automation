# N8n Corpus

Builds and maintains a local, queryable knowledge corpus of the n8n ecosystem: official documentation plus community workflow collections, crawled from six GitHub repositories into a plain-file, version-pinned snapshot.

## Language

**Corpus**:
The local, queryable full snapshot of the six Source repos and all Followed workflows, used for offline search, reading, and cross-referencing (e.g., "show me a workflow that does lead enrichment" answered by consulting workflows and docs together).
_Avoid_: crawl output, dump, mirror

**Crawl**:
The process of fetching and persisting the six Source repos and following workflow links into the Corpus. Re-runnable; repos whose remote HEAD matches the recorded Pin are skipped, and links are re-followed only when the linking repo's tree changed.
_Avoid_: scrape, harvest, sync

**Source repo**:
One of the six upstream GitHub repositories crawled into the Corpus: the official docs repo (n8n-io/n8n-docs) plus five community workflow collections.
_Avoid_: source, upstream repo, origin

**Pin**:
The commit SHA of a Source repo's default-branch HEAD at crawl time, recorded per repo in the Manifest. Identifies exactly which upstream state the Corpus captured; every re-crawl re-pins.
_Avoid_: tag, version, release

**Workflow**:
A single n8n automation, stored as a JSON file with a structural signature (`name`, `nodes`, `connections` keys). The first-class content of the Corpus; identified by structure, not by folder or filename, because each Source repo organizes them differently.
_Avoid_: template (the marketing name some Source repos use for the same files), automation

**Followed workflow**:
A Workflow captured by following a workflow link out of a Source repo (e.g., an n8n.io community workflow page or a raw workflow JSON), stored together with its page/guide text as one unit. Link-following is one hop only: the target's own out-links are never followed, and non-workflow links stay as text in the repo READMEs.
_Avoid_: external workflow, fetched workflow

**Manifest**:
The index that maps every indexed path in the Corpus to a description: workflow JSONs with extracted metadata (name, description, node count), markdown docs with titles, top-level dirs with one-liners. Also records provenance — for each Followed workflow, which repo's link led to it, the target URL, and dedupe resolution (a followed workflow whose content hash matches an in-repo Workflow is recorded as resolving to the mirror copy, which wins). The Corpus is queried by reading files or ripgrep; the Manifest is the map.
_Avoid_: index file, TOC

