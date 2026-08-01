"""Pure workflow detection and metadata extraction.

A workflow is a JSON file with the structural signature ``name``
(a string), ``nodes`` (a list), and ``connections`` (a dict) — the shape
n8n exports. Detection and extraction never touch the filesystem.
"""

import json

from n8ncorpus import dedupe


def is_workflow(text: str) -> bool:
    """True when ``text`` parses as JSON with the workflow signature."""
    try:
        data = json.loads(text)
    except ValueError:
        return False
    return (
        isinstance(data, dict)
        and isinstance(data.get("name"), str)
        and isinstance(data.get("nodes"), list)
        and isinstance(data.get("connections"), dict)
    )


def workflow_metadata(text: str) -> dict:
    """Extract name, description, and node count from workflow JSON."""
    data = json.loads(text)
    return {
        "name": data["name"],
        "description": data.get("description", ""),
        "node_count": len(data["nodes"]),
    }


def workflow_entries(files: list[tuple[str, str]]) -> list[dict]:
    """Index workflow files given as ``(relative_path, text)`` pairs."""
    entries = []
    for path, text in files:
        if is_workflow(text):
            entries.append(
                {"path": path, "hash": dedupe.canonical_hash(text), **workflow_metadata(text)}
            )
    return entries
