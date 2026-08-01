"""Thin HTTP shell. Untested integration code."""

import http.client
import urllib.error
import urllib.request


def fetch(url: str, timeout: int = 10) -> str | None:
    """Fetch a URL's body as text; None on any network/HTTP error."""
    try:
        with urllib.request.urlopen(url, timeout=timeout) as response:
            return response.read().decode("utf-8", errors="replace")
    except (
        urllib.error.URLError,
        urllib.error.HTTPError,
        TimeoutError,
        OSError,
        http.client.HTTPException,
    ):
        return None
