"""Crawl orchestration: the untested I/O shell around the pure layer."""

import hashlib
import json
import os
import subprocess
from datetime import datetime, timezone
from pathlib import Path, PurePosixPath

from n8ncorpus import dedupe, docs, fetching, gitops, links, manifest, workflows


def crawl(corpus: Path, repos: list[dict], force: bool = False) -> dict:
    """Crawl every source repo into ``corpus`` and write the manifest.

    ``repos`` is a list of ``{"key": str, "url": str}`` configs. An
    unreachable repo is recorded as a crawl flag instead of aborting;
    a re-run retries it. Returns the manifest as a dict.
    """
    corpus.mkdir(parents=True, exist_ok=True)
    now = datetime.now(timezone.utc).isoformat()
    manifest_data = manifest.new_manifest(now)
    previous = _read_manifest(corpus)
    previous_followed = _group_by_repo(previous.get("followed", []))
    previous_flags = _group_by_repo(previous.get("flags", []))
    followed_records: list[dict] = []

    for config in repos:
        key, url = config["key"], config["url"]
        try:
            sha = gitops.head_sha(url)
        except subprocess.CalledProcessError:
            manifest.add_flag(manifest_data, key, "unreachable repo")
            continue
        prior_pin = previous.get("repos", {}).get(key, {}).get("pin", {})
        skipped = not force and prior_pin.get("sha") == sha
        if skipped:
            manifest.record_pin(
                manifest_data,
                key,
                url,
                sha,
                prior_pin.get("crawled_at", now),
                skipped=True,
            )
        else:
            manifest.record_pin(manifest_data, key, url, sha, now, skipped=False)
            try:
                gitops.clone(url, corpus / "repos" / key)
            except subprocess.CalledProcessError:
                manifest.add_flag(manifest_data, key, "clone failed")
                continue
        mirror = corpus / "repos" / key
        _index_workflows(manifest_data, key, mirror)
        _index_docs(manifest_data, key, mirror)
        _index_repo_top(manifest_data, key, mirror)
        if skipped:
            # Links are re-followed only when the linking repo's tree changed
            # (CONTEXT.md): an unchanged repo carries its prior followed
            # entries and flags forward instead of re-fetching.
            for entry in previous_followed.get(key, []):
                manifest.add_followed(manifest_data, entry)
            for flag in previous_flags.get(key, []):
                manifest_data["flags"].append(flag)
        else:
            followed_records.extend(_follow_links(manifest_data, key, mirror))

    _store_followed(manifest_data, corpus / "fetched", followed_records)
    _write_manifest(corpus, manifest_data)
    return manifest_data


def _group_by_repo(entries: list[dict]) -> dict:
    grouped: dict[str, list[dict]] = {}
    for entry in entries:
        grouped.setdefault(entry["repo"], []).append(entry)
    return grouped


def _read_manifest(corpus: Path) -> dict:
    path = corpus / "manifest.json"
    if not path.is_file():
        return {}
    return json.loads(path.read_text(encoding="utf-8"))


def _index_workflows(manifest_data: dict, key: str, mirror: Path) -> None:
    json_files = [(path.as_posix(), text) for path, text in _walk_files(mirror, [".json"])]
    for entry in workflows.workflow_entries(json_files):
        manifest.add_workflow(manifest_data, key, entry["path"], entry)


def _index_docs(manifest_data: dict, key: str, mirror: Path) -> None:
    md_files = [
        (path.as_posix(), text)
        for path, text in _walk_files(mirror, [".md", ".markdown", ".mdx"])
    ]
    llms = mirror / "llms.txt"
    if llms.is_file():
        entries = docs.parse_llms(llms.read_text(encoding="utf-8", errors="replace"))
        manifest.add_docs(manifest_data, key, entries)
        covered = set()
        for entry in entries:
            path = PurePosixPath(entry["path"])
            covered.add(entry["path"])
            if path.suffix:
                covered.add(str(path.with_suffix("")))
        md_files = [(p, t) for p, t in md_files if p not in covered]
    manifest.add_docs(manifest_data, key, docs.doc_entries(md_files))


def _index_repo_top(manifest_data: dict, key: str, mirror: Path) -> None:
    dirs = []
    for entry in mirror.iterdir():
        if not entry.is_dir():
            continue
        readme = next(
            (
                entry / name
                for name in ("README.md", "README.markdown", "README.mdx")
                if (entry / name).is_file()
            ),
            None,
        )
        text = (
            readme.read_text(encoding="utf-8", errors="replace") if readme else None
        )
        dirs.append((entry.name, text))
    manifest.extend_repo_top(manifest_data, docs.repo_top_entries(key, dirs))


def _follow_links(manifest_data: dict, key: str, mirror: Path) -> list[dict]:
    """Follow workflow-targeted links one hop, never more (ADR-0003).

    Returns records of what was found; storing and dedupe happen later,
    corpus-wide, in :func:`_store_followed`.
    """
    urls: set[str] = set()
    for _, text in _walk_files(mirror, [".md", ".markdown", ".mdx"]):
        urls.update(links.parse_link_list(text))
    records: list[dict] = []
    for url in sorted(urls):
        if not links.is_workflow_link(url):
            continue
        n8n_id = links.extract_n8n_id(url)
        page = fetching.fetch(url)
        if page is None:
            manifest.add_flag(manifest_data, key, f"unresolvable workflow link: {url}")
            continue
        if n8n_id:
            workflow_json = links.extract_page_workflow(page)
            if workflow_json is None:
                manifest.add_flag(manifest_data, key, f"no workflow JSON on page: {url}")
                continue
            stem = n8n_id
            guide = links.html_to_text(page)
            guide_path = f"fetched/{key}/{stem}.md"
        else:
            if not workflows.is_workflow(page):
                manifest.add_flag(manifest_data, key, f"not a workflow: {url}")
                continue
            workflow_json = page
            stem = "raw-" + hashlib.sha256(page.encode("utf-8")).hexdigest()[:12]
            guide = ""
            guide_path = ""
        records.append(
            {
                "repo": key,
                "url": url,
                "n8n_id": n8n_id or "",
                "workflow_json": workflow_json,
                "hash": dedupe.canonical_hash(workflow_json),
                "stem": stem,
                "guide": guide,
                "guide_path": guide_path,
            }
        )
    return records


def _store_followed(
    manifest_data: dict, fetched_dir: Path, records: list[dict]
) -> None:
    """Dedupe followed workflows corpus-wide, then store and record them."""
    mirror_workflows = [
        {"repo": w["repo"], "path": w["path"], "hash": w["hash"]}
        for w in manifest_data["workflows"]
    ]
    resolutions = dedupe.resolve_dedupes(
        mirror_workflows,
        [
            {"workflow_path": f"fetched/{r['repo']}/{r['stem']}.json", "hash": r["hash"]}
            for r in records
        ],
    )
    for record, resolution in zip(records, resolutions):
        dest = fetched_dir / record["repo"]
        dest.mkdir(parents=True, exist_ok=True)
        workflow_path = f"fetched/{record['repo']}/{record['stem']}.json"
        if resolution["status"] == "stored":
            (dest / f"{record['stem']}.json").write_text(
                record["workflow_json"], encoding="utf-8"
            )
        else:
            workflow_path = ""
        if record["guide"]:
            (dest / f"{record['stem']}.md").write_text(record["guide"], encoding="utf-8")
        manifest.add_followed(
            manifest_data,
            {
                "repo": record["repo"],
                "url": record["url"],
                "n8n_id": record["n8n_id"],
                "workflow_path": workflow_path,
                "guide_path": record["guide_path"],
                "dedupe": resolution,
            },
        )


def _walk_files(root: Path, suffixes: list[str]):
    """Yield ``(relative_path, text)`` for text files under ``root``."""
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = [d for d in dirnames if d != ".git"]
        for name in filenames:
            if suffixes and Path(name).suffix.lower() not in suffixes:
                continue
            path = Path(dirpath) / name
            try:
                text = path.read_text(encoding="utf-8", errors="replace")
            except (OSError, UnicodeError):
                continue
            yield path.relative_to(root), text


def _write_manifest(corpus: Path, manifest_data: dict) -> None:
    (corpus / "manifest.json").write_text(
        json.dumps(manifest_data, indent=2, ensure_ascii=False),
        encoding="utf-8",
    )
