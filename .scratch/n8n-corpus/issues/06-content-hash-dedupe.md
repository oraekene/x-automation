# 06 — Content-hash dedupe: mirror copy wins

**What to build:** Followed workflows are deduplicated against the whole Corpus by canonicalized content hash. A Followed workflow whose hash matches a Workflow already in a repo mirror (Zie619 claims to mirror the site itself, so heavy overlap with followed n8n.io workflows is expected) stores no duplicate; the Manifest records the link as resolving to the mirror path. Two followed entries with the same hash collapse to one canonical copy with aliases recorded. Provenance survives on every entry.

**Blocked by:** 05 — Follow workflow links

**Status:** done

- [x] A Followed workflow matching an in-mirror Workflow by canonicalized hash stores nothing and resolves to the mirror path in the Manifest
- [x] Duplicate followed entries collapse to one copy with the alias recorded
- [x] The mirror copy always wins over the fetched copy
- [x] Dedupe is a pure function verified by fixture hashes, no network

## Comments
