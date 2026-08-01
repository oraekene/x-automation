# Followed workflows: the corpus follows workflow links one hop out

Two source repos (notably AtharvaDomale's, 500+ entries) are pointer catalogs: their value is in links to n8n.io community workflow pages, not in files. The corpus follows a link only when its target is an importable workflow, captures the workflow JSON together with its page/guide text as one unit, and never follows a second hop. Fetched content lives in `corpus/fetched/` with provenance in the manifest. Duplicate content already in a repo mirror is deduplicated (content hash; mirror copy wins). This deliberately breaks the otherwise self-contained-corpus rule.

Status: accepted
