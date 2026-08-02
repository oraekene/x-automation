"""Host-agnostic X Automation Relay.

Polls the Worker command channel, executes commands locally, and reports
outcomes. Pairing binds this process to a user via a one-time pairing code.
`cookies set` persists the X session encrypted at rest; `whoami` proves the
session authenticates against X.

Ticket 05 scope: cookie store + X transport. Command execution over X
(search/post/reply/quote) arrives in tickets 06-07.
"""

from __future__ import annotations

import argparse
import json
import logging
import os
import sys
import time
import urllib.error
import urllib.request
from dataclasses import dataclass
from pathlib import Path
from typing import Callable

import cookiestore
import xclient

log = logging.getLogger("relay")

DEFAULT_POLL_INTERVAL_S = 5.0
DEFAULT_STATE_FILE = "relay-state.json"
DEFAULT_COOKIE_STORE = "x-cookies.bin"

COMMANDS_PATH = "/api/relays/{relay_id}/commands"
RESULTS_PATH = "/api/relays/{relay_id}/results"
PAIR_PATH = "/api/relays/pair"
CREATE_PATH = "/api/relays"


class RelayError(Exception):
    """A failure reaching or interpreting the Worker."""


@dataclass
class RelayConfig:
    poll_interval_s: float = DEFAULT_POLL_INTERVAL_S


@dataclass
class RelayState:
    relay_id: str
    token: str
    base_url: str

    def save(self, path: str | Path) -> None:
        Path(path).write_text(
            json.dumps({"relay_id": self.relay_id, "token": self.token, "base_url": self.base_url}),
            encoding="utf-8",
        )

    @classmethod
    def load(cls, path: str | Path) -> "RelayState":
        data = json.loads(Path(path).read_text(encoding="utf-8"))
        return cls(relay_id=data["relay_id"], token=data["token"], base_url=data["base_url"])


def fetch_json(
    url: str,
    *,
    method: str = "GET",
    token: str | None = None,
    body: dict | None = None,
) -> dict:
    """Request a URL and parse JSON; raises RelayError on failure."""
    headers = {"Accept": "application/json"}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    data = None
    if body is not None:
        headers["Content-Type"] = "application/json"
        data = json.dumps(body).encode("utf-8")
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        raise RelayError(f"HTTP {e.code} from {url}: {e.read().decode('utf-8', 'replace')}") from e
    except urllib.error.URLError as e:
        raise RelayError(f"unreachable {url}: {e.reason}") from e
    except json.JSONDecodeError as e:
        raise RelayError(f"non-JSON response from {url}") from e


def api(base_url: str, path: str) -> str:
    return f"{base_url.rstrip('/')}{path}"


def create_relay(base_url: str, name: str) -> dict:
    """Create a relay intent on the Worker; returns {relay_id, pairing_code}."""
    return fetch_json(api(base_url, CREATE_PATH), method="POST", body={"name": name})


def pair_relay(base_url: str, relay_id: str, pairing_code: str) -> dict:
    """Exchange the pairing code for a long-lived token."""
    return fetch_json(api(base_url, PAIR_PATH), method="POST", body={"relay_id": relay_id, "pairing_code": pairing_code})


def poll_commands(state: RelayState) -> list[dict]:
    """GET pending commands; raises RelayError on failure."""
    body = fetch_json(
        api(state.base_url, COMMANDS_PATH.format(relay_id=state.relay_id)),
        token=state.token,
    )
    return body.get("commands", [])


def report_results(state: RelayState, results: list[dict]) -> dict:
    """POST command outcomes back to the Worker."""
    return fetch_json(
        api(state.base_url, RESULTS_PATH.format(relay_id=state.relay_id)),
        method="POST",
        token=state.token,
        body={"results": results},
    )


def execute_command(command: dict) -> dict:
    """Run a single command locally; returns a result dict for the Worker."""
    command_type = command.get("type")
    if command_type == "echo":
        message = command.get("payload", {}).get("message", "")
        return {"ok": True, "output": {"echoed": message}}
    return {"ok": False, "output": {"error": f"unknown command type: {command_type!r}"}}


def run_once(state: RelayState) -> list[dict]:
    """Poll, execute, and report one round. Returns per-command results."""
    commands = poll_commands(state)
    results = []
    for command in commands:
        outcome = execute_command(command)
        results.append({"command_id": command.get("id"), **outcome})
    if results:
        report_results(state, results)
    return results


def run_loop(
    state: RelayState,
    *,
    config: RelayConfig | None = None,
    should_stop: Callable[[], bool] = lambda: False,
    on_status: Callable[[str], None] = lambda msg: log.info(msg),
    sleep: Callable[[float], None] = time.sleep,
) -> None:
    """Poll the command channel until should_stop() is True."""
    interval = (config or RelayConfig()).poll_interval_s
    while not should_stop():
        try:
            run_once(state)
            on_status("connected")
        except RelayError:
            on_status("unreachable")
        sleep(interval)


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="X Automation Relay")
    subparsers = parser.add_subparsers(dest="command", required=True)

    create_p = subparsers.add_parser("create", help="create a relay intent on the Worker")
    create_p.add_argument("--base-url", required=True, help="Worker base URL")
    create_p.add_argument("--name", default="relay", help="relay display name")
    create_p.add_argument("--verbose", action="store_true")

    pair_p = subparsers.add_parser("pair", help="pair this host with a relay intent")
    pair_p.add_argument("--base-url", required=True, help="Worker base URL")
    pair_p.add_argument("--relay-id", required=True, help="relay id from create")
    pair_p.add_argument("--code", required=True, help="pairing code from create")
    pair_p.add_argument("--state", default=DEFAULT_STATE_FILE, help="state file to persist token")
    pair_p.add_argument("--verbose", action="store_true")

    run_p = subparsers.add_parser("run", help="poll and execute commands in a loop")
    run_p.add_argument("--state", default=DEFAULT_STATE_FILE, help="state file from pair")
    run_p.add_argument("--poll-interval", type=float, default=DEFAULT_POLL_INTERVAL_S, help="seconds between polls")
    run_p.add_argument("--verbose", action="store_true")

    cookies_p = subparsers.add_parser("cookies", help="manage the encrypted X cookie store")
    cookies_sub = cookies_p.add_subparsers(dest="cookies_command", required=True)
    set_p = cookies_sub.add_parser("set", help="persist an X session (auth_token + ct0) encrypted at rest")
    set_p.add_argument("--store", default=DEFAULT_COOKIE_STORE, help="cookie store file")
    set_p.add_argument("--auth-token", default=None, help="X session auth_token cookie (or X_AUTH_TOKEN env)")
    set_p.add_argument("--ct0", default=None, help="X session ct0 cookie (or X_CT0 env)")
    set_p.add_argument("--screen-name", default=None, help="account screen name to persist with the session")
    set_p.add_argument("--verbose", action="store_true")

    whoami_p = subparsers.add_parser("whoami", help="verify the stored session against X and print the account")
    whoami_p.add_argument("--store", default=DEFAULT_COOKIE_STORE, help="cookie store file")
    whoami_p.add_argument("--screen-name", default=None, help="override the persisted screen name")
    whoami_p.add_argument("--host", default="https://x.com", help="X host (for tests)")
    whoami_p.add_argument("--max-attempts", type=int, default=3, help="transient retries before giving up")
    whoami_p.add_argument("--verbose", action="store_true")

    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv if argv is not None else sys.argv[1:])
    logging.basicConfig(
        level=logging.DEBUG if getattr(args, "verbose", False) else logging.INFO,
        format="%(asctime)s relay %(levelname)s %(message)s",
    )
    try:
        if args.command == "create":
            result = create_relay(args.base_url, args.name)
            print(f"relay_id={result['relay_id']}")
            print(f"pairing_code={result['pairing_code']}")
            print(f"pair this host with: relay.py --base-url {args.base_url} pair --relay-id {result['relay_id']} --code {result['pairing_code']}")
        elif args.command == "pair":
            result = pair_relay(args.base_url, args.relay_id, args.code)
            RelayState(relay_id=result["relay_id"], token=result["token"], base_url=args.base_url).save(args.state)
            log.info("paired relay_id=%s token persisted to %s", result["relay_id"], args.state)
        elif args.command == "run":
            state = RelayState.load(args.state)
            config = RelayConfig(poll_interval_s=args.poll_interval)
            log.info("starting, relay_id=%s poll_interval=%ss", state.relay_id, config.poll_interval_s)
            run_loop(state, config=config)
        elif args.command == "cookies" and args.cookies_command == "set":
            auth_token = args.auth_token or os.environ.get("X_AUTH_TOKEN")
            ct0 = args.ct0 or os.environ.get("X_CT0")
            if not auth_token or not ct0:
                raise RelayError("pass --auth-token/--ct0 or set X_AUTH_TOKEN/X_CT0")
            session = xclient.XSession(auth_token=auth_token, ct0=ct0, screen_name=args.screen_name)
            store = cookiestore.CookieStore(args.store)
            store.save(session.to_mapping())
            log.info("saved X session encrypted at rest to %s", args.store)
        elif args.command == "whoami":
            session = xclient.XSession.from_mapping(cookiestore.CookieStore(args.store).load())
            viewer = xclient.whoami(
                session,
                host=args.host,
                screen_name=args.screen_name,
                max_attempts=args.max_attempts,
                pacer=xclient.Pacer(),
            )
            print(f"authenticated: rest_id={viewer['rest_id']} screen_name={viewer['screen_name']} name={viewer['name']}")
    except (RelayError, cookiestore.CookieStoreError, xclient.XError) as e:
        log.error("%s", e)
        return 1
    except KeyboardInterrupt:
        log.info("stopped by interrupt")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())