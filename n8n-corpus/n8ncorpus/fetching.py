"""Thin HTTP shell. Untested integration code."""

import http.client
import time
import urllib.error
import urllib.request

BROWSER_UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36"
)


def fetch(url: str, timeout: int = 10, attempts: int = 3) -> str | None:
    """Fetch a URL's body as text; None on any network/HTTP error.

    Sends a browser-like User-Agent: n8n.io (and its api.n8n.io backend)
    answer 403 Forbidden to Python's default ``Python-urllib`` agent.
    Retries transient failures (network errors and 5xx) with backoff;
    a definitive 4xx answer is returned immediately, not retried.
    """
    request = urllib.request.Request(url, headers={"User-Agent": BROWSER_UA})
    for attempt in range(attempts):
        try:
            with urllib.request.urlopen(request, timeout=timeout) as response:
                return response.read().decode("utf-8", errors="replace")
        except urllib.error.HTTPError as exc:
            if exc.code < 500 or attempt + 1 >= attempts:
                return None
            time.sleep(1.5**attempt)
        except (
            urllib.error.URLError,
            TimeoutError,
            OSError,
            http.client.HTTPException,
        ):
            if attempt + 1 >= attempts:
                return None
            time.sleep(1.5**attempt)
    return None
