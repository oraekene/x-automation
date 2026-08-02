"""Host-agnostic Relay: polls the Worker for commands and executes them.

Ticket 01 scope: start, poll a configurable base URL, log connectivity.
Later tickets add the cookie store, X GraphQL client, and write actions.
"""

from __future__ import annotations

import argparse
import json
import logging
import sys
import time
import urllib.error
import urllib.request
from dataclasses import dataclass
from typing import Callable

log = logging.getLogger("relay")

DEFAULT_POLL_INTERVAL_S = 5.0
HEALTH_PATH = "/health"


@dataclass
class RelayConfig:
    base_url: str
    poll_interval_s: float = DEFAULT_POLL_INTERVAL_S


def fetch_json(url: str) -> dict:
    """GET a URL and parse JSON; raises RelayError on failure."""
    req = urllib.request.Request(url)
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        raise RelayError(f"HTTP {e.code} from {url}") from e
    except urllib.error.URLError as e:
        raise RelayError(f"unreachable {url}: {e.reason}") from e
    except json.JSONDecodeError as e:
        raise RelayError(f"non-JSON response from {url}") from e


class RelayError(Exception):
    """A failure reaching or interpreting the Worker."""


def check_health(base_url: str) -> bool:
    """Return True when the Worker reports ok."""
    try:
        body = fetch_json(f"{base_url.rstrip('/')}{HEALTH_PATH}")
        return body.get("status") == "ok"
    except RelayError:
        return False


def run(
    config: RelayConfig,
    *,
    should_stop: Callable[[], bool] = lambda: False,
    on_status: Callable[[str], None] = lambda msg: log.info(msg),
    sleep: Callable[[float], None] = time.sleep,
) -> None:
    """Poll the Worker health endpoint until should_stop() is True."""
    while not should_stop():
        if check_health(config.base_url):
            on_status("connected")
        else:
            on_status("unreachable")
        sleep(config.poll_interval_s)


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="X Automation Relay")
    parser.add_argument("--base-url", required=True, help="Worker base URL, e.g. https://x-auto.example.workers.dev")
    parser.add_argument("--poll-interval", type=float, default=DEFAULT_POLL_INTERVAL_S, help="seconds between polls")
    parser.add_argument("--verbose", action="store_true", help="debug logging")
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv if argv is not None else sys.argv[1:])
    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.INFO,
        format="%(asctime)s relay %(levelname)s %(message)s",
    )
    config = RelayConfig(base_url=args.base_url, poll_interval_s=args.poll_interval)
    log.info("starting, base_url=%s poll_interval=%ss", config.base_url, config.poll_interval_s)
    try:
        run(config)
    except KeyboardInterrupt:
        log.info("stopped by interrupt")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
