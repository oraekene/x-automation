"""Pure docs-indexing functions: frontmatter, titles, llms.txt, one-liners.

These functions never touch the filesystem; callers pass text.
"""

import re
from pathlib import PurePosixPath

_FRONTMATTER = re.compile(r"^---\s*\n(.*?)\n---\s*\n?", re.S)
_FM_FIELD = re.compile(r"^(title|description):\s*(.+?)\s*$")
_HEADING = re.compile(r"^#\s+(.+?)\s*$", re.M)
_LLMS_BULLET = re.compile(
    r"-\s+\[([^\]]+)\]\(([^)]+)\)(?:\s*:\s*(.*))?\s*$"
)


def extract_frontmatter(text: str) -> dict:
    """Return ``{title, description}`` from a leading frontmatter block."""
    m = _FRONTMATTER.match(text)
    if not m:
        return {}
    data = {}
    for line in m.group(1).splitlines():
        field = _FM_FIELD.match(line.strip())
        if field:
            data[field.group(1)] = field.group(2).strip().strip("'\"")
    return data


def doc_title(text: str, path: str) -> str:
    """Title from frontmatter, else first H1, else the filename stem."""
    fm = extract_frontmatter(text)
    if fm.get("title"):
        return fm["title"]
    m = _HEADING.search(text)
    if m:
        return m.group(1).strip()
    return PurePosixPath(path).stem


def doc_description(text: str) -> str:
    """Description from frontmatter, else the first prose line of the body."""
    fm = extract_frontmatter(text)
    if fm.get("description"):
        return fm["description"]
    body = _FRONTMATTER.sub("", text, count=1)
    in_code = False
    for line in body.splitlines():
        if line.strip().startswith("```"):
            in_code = not in_code
            continue
        if in_code:
            continue
        line = line.strip()
        if not line or line.startswith(("#", "-", "*", ">", "```")):
            continue
        return line[:200]
    return ""


def doc_entries(files: list[tuple[str, str]]) -> list[dict]:
    """Index markdown files given as ``(relative_path, text)`` pairs."""
    entries = []
    for path, text in files:
        if PurePosixPath(path).suffix.lower() not in (".md", ".markdown", ".mdx"):
            continue
        entries.append(
            {
                "path": path,
                "title": doc_title(text, path),
                "description": doc_description(text),
            }
        )
    return entries


def parse_llms(contents: str) -> list[dict]:
    """Parse llmstxt.org format into ``[{path, title, description}]``.

    Only relative paths (no scheme, no leading ``/``) are kept.
    """
    entries = []
    for line in contents.splitlines():
        m = _LLMS_BULLET.match(line)
        if not m:
            continue
        title, url, desc = m.groups()
        path = url.lstrip("./")
        if "://" in path or path.startswith("/"):
            continue
        entries.append(
            {"path": path, "title": title, "description": (desc or "").strip()}
        )
    return entries


def readme_one_liner(text: str) -> str:
    """First line of a README: the heading or the first non-blank line."""
    for line in text.splitlines():
        line = line.strip()
        if not line:
            continue
        return line.lstrip("#").strip()[:200]
    return ""


def repo_top_entries(repo_key: str, dirs: list[tuple[str, str | None]]) -> list[dict]:
    """One-liner per top-level dir: README first line, else the dir name."""
    entries = []
    for name, readme_text in dirs:
        if readme_text:
            description = readme_one_liner(readme_text)
        else:
            description = name
        entries.append({"repo": repo_key, "path": name, "description": description})
    return entries
