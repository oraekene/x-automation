# 01 — First crawl end-to-end: mirror one source repo, pinned, with a Manifest skeleton

**What to build:** Running the crawler for a single Source repo (fixture repo, then a real one) produces its per-source mirror under the Corpus (faithful working tree, `.git` stripped) and a Manifest recording the Pin: the repo's default-branch HEAD commit SHA plus crawl timestamp. This ticket also lays the project scaffold for the n8n Corpus (crawl script modeled on the hermes crawler's split of pure functions from a thin I/O shell, stdlib only) and the `unittest` fixture harness — the first tracer bullet through the whole stack.

**Blocked by:** None — can start immediately

**Status:** done

- [x] A single Source repo can be mirrored into the Corpus at its default-branch HEAD with `.git` stripped
- [x] The Manifest is written with the repo's Pin (commit SHA + crawled_at) recorded
- [x] The crawl script is stdlib-only and re-runnable against a fixture repo with no network
- [x] The fixture harness runs under `unittest` with no network access

## Comments
