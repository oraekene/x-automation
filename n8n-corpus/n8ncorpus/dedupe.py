"""Pure content-hash dedupe: mirror copy wins, duplicates alias.

A followed workflow whose canonical hash matches a workflow already in a
repo mirror stores nothing and resolves to the mirror path. Two followed
entries with the same hash collapse to one canonical copy; the second
aliases the first. All decisions here are pure.
"""

import hashlib
import json


def canonical_hash(text: str) -> str:
    """SHA-256 of the canonical (re-serialized, key-sorted) workflow.

    Unparseable text is hashed as-is so every followed item gets a stable
    identity.
    """
    try:
        canonical = json.dumps(
            json.loads(text), sort_keys=True, separators=(",", ":")
        )
    except ValueError:
        canonical = text
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


def resolve_dedupes(
    mirror_workflows: list[dict], followed: list[dict]
) -> list[dict]:
    """Decide each followed entry's dedupe resolution, in order.

    ``mirror_workflows`` is a list of ``{"repo", "path", "hash"}`` for every
    workflow in the repo mirrors. ``followed`` is a list of
    ``{"workflow_path", "hash"}`` in crawl order. Returns one
    ``{"status", "resolves_to"}`` per followed entry: ``mirror`` (a repo
    mirror already holds it), ``stored`` (first copy in the corpus), or
    ``alias`` (resolves to the first stored copy).
    """
    mirror_by_hash: dict[str, str] = {}
    for workflow in mirror_workflows:
        mirror_by_hash.setdefault(
            workflow["hash"], f"repos/{workflow['repo']}/{workflow['path']}"
        )
    stored_by_hash: dict[str, str] = {}
    resolutions = []
    for entry in followed:
        hash_ = entry["hash"]
        if hash_ in mirror_by_hash:
            resolutions.append({"status": "mirror", "resolves_to": mirror_by_hash[hash_]})
        elif hash_ in stored_by_hash:
            resolutions.append({"status": "alias", "resolves_to": stored_by_hash[hash_]})
        else:
            stored_by_hash[hash_] = entry["workflow_path"]
            resolutions.append({"status": "stored", "resolves_to": ""})
    return resolutions
