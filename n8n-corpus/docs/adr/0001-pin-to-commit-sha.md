# Corpus pins each source repo to a commit SHA, not a release tag

The hermes corpus pinned the upstream repo to a Release tag at crawl time. Five of the six n8n source repos publish no releases at all (Zie619's only tag is a DMCA history-rewrite marker), so release-tag pinning is impossible here. Each source repo is instead cloned at its default-branch HEAD and the manifest records the resulting commit SHA per repo; every re-crawl re-pins. A future multi-snapshot archive would build on this by keeping per-crawl pins.

Status: accepted
