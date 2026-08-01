# 03 — Docs index: all markdown, everywhere

**What to build:** Every markdown file in every mirrored Source repo is indexed as docs: official docs pages (frontmatter titles/descriptions where present), every collection repo's READMEs and guides, and top-level dirs get README-derived one-liners. Where a Source repo ships its own in-tree `llms.txt` (llmstxt.org format — enescingoz does), it is parsed as that repo's index rather than re-derived. Docs content comes from the pinned repo tree only, never the live site.

**Blocked by:** 01 — First crawl end-to-end

**Status:** done

- [x] Every markdown file in a mirrored repo produces a Manifest entry with title and description
- [x] Frontmatter metadata is used when present; headings/README first-lines otherwise
- [x] In-tree `llms.txt` repos are indexed from their own file
- [x] Top-level dirs of each repo appear with one-line descriptions
- [x] Indexing is pure functions verified by fixture trees, no network

## Comments
