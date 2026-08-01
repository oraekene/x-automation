"""Pure manifest-building functions.

The manifest is the corpus's map: one file at the corpus root describing
every source repo, its pin, and every workflow/doc/followed entry indexed
from it. These functions never touch the filesystem.
"""

SCHEMA_VERSION = 1


def new_manifest(crawled_at: str) -> dict:
    return {
        "schema": SCHEMA_VERSION,
        "crawled_at": crawled_at,
        "repos": {},
        "workflows": [],
        "docs": [],
        "followed": [],
        "repo_top": [],
        "flags": [],
    }


def record_pin(
    manifest: dict,
    key: str,
    url: str,
    sha: str,
    crawled_at: str,
    skipped: bool = False,
) -> dict:
    """Record (or refresh) the pin for one source repo."""
    manifest["repos"][key] = {
        "url": url,
        "pin": {"sha": sha, "crawled_at": crawled_at},
        "skipped": skipped,
    }
    return manifest


def add_workflow(manifest: dict, repo_key: str, path: str, metadata: dict) -> dict:
    """Append one workflow entry for a source repo."""
    manifest["workflows"].append({"repo": repo_key, "path": path, **metadata})
    return manifest


def add_docs(manifest: dict, repo_key: str, entries: list[dict]) -> dict:
    """Append docs entries (path, title, description) for a source repo."""
    manifest["docs"].extend({"repo": repo_key, **entry} for entry in entries)
    return manifest


def extend_repo_top(manifest: dict, entries: list[dict]) -> dict:
    """Append top-level-dir one-liners, already shaped as full entries."""
    manifest["repo_top"].extend(entries)
    return manifest


def add_followed(manifest: dict, entry: dict) -> dict:
    """Append one followed-workflow entry, already fully shaped."""
    manifest["followed"].append(entry)
    return manifest


def add_flag(manifest: dict, repo_key: str, flag: str) -> dict:
    """Record a crawl-time flag for a source repo (e.g. an unresolvable link)."""
    manifest["flags"].append({"repo": repo_key, "message": flag})
    return manifest
