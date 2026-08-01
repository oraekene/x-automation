"""Pure link parsing and classification for followed workflows.

A link is followed only when its target is an importable n8n workflow: a
community workflow page (``/workflows/<id>-<slug>/``) or a raw JSON file.
Everything else stays text. These functions never touch the network.
"""

import json
import re
from html.parser import HTMLParser
from urllib.parse import urlparse

from n8ncorpus import workflows

_MD_LINK = re.compile(r"\[[^\]]*\]\(([^)\s]+)\)")
_BARE_URL = re.compile(r"https?://[^\s\)\]>]+")
_WORKFLOW_PAGE = re.compile(r"/workflows/(\d+)(?:-[^/]*)?/?$")
_SCRIPT_JSON = re.compile(
    r'<script[^>]*type=["\']application/json["\'][^>]*>(.*?)</script>', re.S
)
N8N_PAGE_HOSTS = ("n8n.io", "www.n8n.io")


def parse_link_list(text: str) -> list[str]:
    """Every absolute http(s) URL in a markdown file, deduplicated."""
    urls = []
    for m in _MD_LINK.finditer(text):
        url = m.group(1).rstrip(".,;")
        if url.startswith(("http://", "https://")):
            urls.append(url)
    for m in _BARE_URL.finditer(text):
        urls.append(m.group(0).rstrip(".,;"))
    return list(dict.fromkeys(urls))


def extract_n8n_id(url: str) -> str | None:
    """The workflow id from an n8n.io community workflow page URL."""
    m = _WORKFLOW_PAGE.search(url)
    return m.group(1) if m else None


def is_workflow_link(url: str) -> bool:
    """True when following this link can yield an importable workflow.

    GitHub blob pages (HTML, not raw JSON) are never workflow targets;
    raw.githubusercontent.com links are.
    """
    if extract_n8n_id(url) is not None:
        return True
    if "/blob/" in url:
        return False
    return url.endswith(".json")


def extract_page_workflow(html: str) -> str | None:
    """The workflow JSON embedded in a workflow page, if any."""
    for m in _SCRIPT_JSON.finditer(html):
        candidate = m.group(1).strip()
        if workflows.is_workflow(candidate):
            return candidate
    return None


def is_n8n_page(url: str) -> bool:
    """True for n8n.io community workflow page URLs."""
    return urlparse(url).netloc in N8N_PAGE_HOSTS


def n8n_api_url(n8n_id: str) -> str:
    """The api.n8n.io endpoint serving the template record for an id."""
    return f"https://api.n8n.io/api/workflows/{n8n_id}"


def extract_api_workflow(body: str) -> tuple[str, str] | None:
    """The workflow JSON and description from an api.n8n.io record.

    Returns ``(workflow_json, description)``, or None when the body has
    no workflow-shaped payload. Live n8n.io pages no longer embed the
    workflow JSON in their HTML (they render from this API instead).
    """
    try:
        data = json.loads(body).get("data") or {}
    except (json.JSONDecodeError, AttributeError):
        return None
    workflow = data.get("workflow")
    if isinstance(workflow, str):
        try:
            workflow = json.loads(workflow)
        except json.JSONDecodeError:
            return None
    if not isinstance(workflow, dict):
        return None
    workflow = dict(workflow)
    if not isinstance(workflow.get("name"), str):
        # Some API records omit the workflow's name (it lives on the
        # parent record); a workflow must carry its name to be indexable.
        record_name = data.get("name")
        if isinstance(record_name, str):
            workflow["name"] = record_name
    workflow_json = json.dumps(workflow)
    if not workflows.is_workflow(workflow_json):
        return None
    return workflow_json, data.get("description") or ""


class _TextExtractor(HTMLParser):
    def __init__(self):
        super().__init__()
        self.parts: list[str] = []
        self._in_script = False

    def handle_starttag(self, tag, attrs):
        if tag == "script":
            self._in_script = True

    def handle_endtag(self, tag):
        if tag == "script":
            self._in_script = False

    def handle_data(self, data):
        if not self._in_script and data.strip():
            self.parts.append(" ".join(data.split()))


def html_to_text(html: str) -> str:
    """Strip tags (and script contents), collapse whitespace."""
    extractor = _TextExtractor()
    extractor.feed(html)
    return " ".join(extractor.parts)
