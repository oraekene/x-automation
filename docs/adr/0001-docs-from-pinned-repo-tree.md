# Docs content comes from the pinned repo tree, not the live docs site

The Docs site is generated from `website/docs/` in the Repo and redeploys on every commit, so the live site reflects `main`, which is newer than any pinned Release tag. Crawling the live site would produce docs that describe a different version than the code sitting beside them in the Corpus, breaking cross-referencing. The crawl therefore copies Docs content out of the pinned Repo tree and runs the repo's own `website/scripts/generate-llms-txt.py` so code and docs stay version-consistent within a Corpus snapshot. The live `llms.txt` is fetched only as a completeness checklist, never as a content source.

Status: accepted
