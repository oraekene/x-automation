"""X transport foundation (ticket 05).

Every X request is shaped like a Chrome browser session and authenticated with
the user's cookie session (auth_token + ct0). The error taxonomy classifies X
failures so transient ones retry over an exponential backoff with jitter, and
human-like pacing runs before every request. ``whoami`` proves an
authenticated read works with a valid session and fails cleanly with an
expired one.

The request layer is a small seam (``Session``): ``CurlCffiSession`` provides
Chrome TLS fingerprint impersonation via curl_cffi; the fallback
``StdlibSession`` applies identical header shaping so the relay runs anywhere.
"""

from __future__ import annotations

import json
import random
import time
import urllib.error
import urllib.request
import uuid
from dataclasses import dataclass, field
from typing import Callable, Mapping

# Pinned placeholder; queryId + feature-flag resolution arrives with the
# GraphQL reads ticket (06) that builds search/timeline on top of this.
USER_BY_SCREEN_NAME_QUERY_PLACEHOLDER = "LtX94E3zViT9Db4Z9Xs8g"

GRAPHQL_PATH = "/i/api/graphql/{query_id}/{operation_name}"

CHROME_USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
)
SEC_CH_UA = '"Not_A Brand";v="8", "Chromium";v="124", "Google Chrome";v="124"'

SESSION_COOKIES = ("auth_token", "ct0")


class XError(Exception):
    """A classified X failure."""

    retryable = False


class XTransientError(XError):
    retryable = True


class XRateLimitError(XError):
    retryable = True


class XAuthError(XError):
    retryable = False


class XNotFoundError(XError):
    retryable = False


@dataclass(frozen=True)
class XSession:
    """The cookie session that authenticates every X request (auth_token + ct0)."""

    auth_token: str
    ct0: str
    screen_name: str | None = None

    @classmethod
    def from_mapping(cls, data: Mapping[str, object]) -> "XSession":
        missing = [k for k in SESSION_COOKIES if not data.get(k)]
        if missing:
            raise XAuthError(f"session cookies missing: {', '.join(missing)}")
        return cls(str(data["auth_token"]), str(data["ct0"]), data.get("screen_name"))

    def to_mapping(self) -> dict[str, object]:
        return {"auth_token": self.auth_token, "ct0": self.ct0, "screen_name": self.screen_name}

    def cookie_header(self) -> str:
        return f"auth_token={self.auth_token}; ct0={self.ct0}"


def classify_response(status: int, body: dict | None) -> XError | None:
    """Map an HTTP/GraphQL response to an XError subclass, or None on success."""
    errors = body.get("errors") if isinstance(body, dict) else None
    if errors:
        for error in errors:
            code = error.get("code") if isinstance(error, dict) else None
            if code in (32, 64, 89, 326):
                return XAuthError(f"X cannot authenticate this session (code {code})")
            if code in (88, 429):
                return XRateLimitError(f"X is rate-limiting (code {code})")
            if code in (34, 50):
                return XNotFoundError(f"X could not find the resource (code {code})")
    if status == 429:
        return XRateLimitError("X returned HTTP 429")
    if status in (401, 403):
        return XAuthError(f"X returned HTTP {status}")
    if status == 404:
        return XNotFoundError("X returned HTTP 404")
    if status >= 500:
        return XTransientError(f"X returned HTTP {status}")
    return None


@dataclass
class Backoff:
    """Exponential backoff with optional jitter; attempt counting starts at 1."""

    base_s: float = 1.0
    factor: float = 2.0
    cap_s: float = 60.0
    jitter_frac: float = 0.25
    rng: random.Random = field(default_factory=random.Random)

    def delay(self, attempt: int) -> float:
        raw = min(self.base_s * (self.factor ** (attempt - 1)), self.cap_s)
        if self.jitter_frac <= 0:
            return raw
        return self.rng.uniform(raw * (1 - self.jitter_frac), raw * (1 + self.jitter_frac))


@dataclass
class Pacer:
    """Human-like pacing before each request: mean delay jittered within bounds."""

    mean_s: float = 2.0
    jitter_frac: float = 0.3
    rng: random.Random = field(default_factory=random.Random)

    def delay(self) -> float:
        return self.rng.uniform(self.mean_s * (1 - self.jitter_frac), self.mean_s * (1 + self.jitter_frac))


def new_client_transaction_id() -> str:
    return uuid.uuid4().hex.upper()


def twitter_request_headers(session: XSession, host: str = "https://x.com") -> dict[str, str]:
    """The Chrome-shaped header bundle every X request carries."""
    return {
        "Accept": "*/*",
        "Accept-Language": "en-US,en;q=0.9",
        "Cache-Control": "no-cache",
        "Content-Type": "application/json",
        "Origin": host,
        "Pragma": "no-cache",
        "Referer": host + "/",
        "User-Agent": CHROME_USER_AGENT,
        "sec-ch-ua": SEC_CH_UA,
        "sec-ch-ua-mobile": "?0",
        "sec-ch-ua-platform": '"Windows"',
        "Sec-Fetch-Dest": "empty",
        "Sec-Fetch-Mode": "cors",
        "Sec-Fetch-Site": "same-origin",
        "X-Csrf-Token": session.ct0,
        "X-Twitter-Active-User": "yes",
        "X-Client-Transaction-Id": new_client_transaction_id(),
        "Cookie": session.cookie_header(),
    }


class Session:
    """Seam every X request flows through; swap for tests or a proxy."""

    def request(self, method: str, url: str, headers: dict[str, str], body: bytes | None) -> tuple[int, bytes]:
        raise NotImplementedError


class StdlibSession(Session):
    """Plain urllib backend with the same request shaping."""

    def request(self, method: str, url: str, headers: dict[str, str], body: bytes | None) -> tuple[int, bytes]:
        req = urllib.request.Request(url, data=body, headers=headers, method=method)
        try:
            with urllib.request.urlopen(req, timeout=30) as resp:
                return resp.getcode(), resp.read()
        except urllib.error.HTTPError as e:
            return e.code, e.read()
        except urllib.error.URLError as e:
            raise XTransientError(f"unreachable {url}: {e.reason}") from e


class CurlCffiSession(Session):
    """Chrome TLS fingerprint impersonation via curl_cffi."""

    def __init__(self, impersonate: str = "chrome"):
        try:
            from curl_cffi import requests as cffi_requests
        except ImportError as e:
            raise ImportError("curl_cffi is not installed; install it or use the stdlib session") from e
        self._requests = cffi_requests
        self._impersonate = impersonate

    def request(self, method: str, url: str, headers: dict[str, str], body: bytes | None) -> tuple[int, bytes]:
        resp = self._requests.request(
            method,
            url,
            headers=headers,
            data=body,
            impersonate=self._impersonate,
            timeout=30,
        )
        return resp.status_code, resp.content


def make_session(impersonate: bool = True) -> Session:
    if impersonate:
        try:
            return CurlCffiSession()
        except ImportError:
            pass
    return StdlibSession()


class XClient:
    def __init__(
        self,
        session: Session | None = None,
        *,
        backoff: Backoff | None = None,
        sleep: Callable[[float], None] = time.sleep,
        pacer: Pacer | None = None,
    ):
        self.session = session or make_session()
        self.backoff = backoff or Backoff()
        self._sleep = sleep
        self._pacer = pacer

    def execute(self, url: str, query: dict, session: XSession, *, max_attempts: int = 3) -> dict:
        headers = twitter_request_headers(session)
        attempt = 0
        while True:
            attempt += 1
            # Human pacing runs before every request, backoff only between retries.
            if self._pacer is not None:
                self._sleep(self._pacer.delay())
            try:
                return self._post(url, headers, query)
            except (XTransientError, XRateLimitError) as err:
                if attempt >= max_attempts:
                    raise
                self._sleep(self.backoff.delay(attempt))
                continue

    def _post(self, url: str, headers: dict[str, str], query: dict) -> dict:
        status, raw = self.session.request("POST", url, headers, json.dumps(query).encode("utf-8"))
        try:
            payload = json.loads(raw.decode("utf-8"))
        except (json.JSONDecodeError, UnicodeDecodeError):
            payload = None
        error = classify_response(status, payload)
        if error is not None:
            raise error
        if payload is None and status == 200:
            # X often serves an HTML logged-out page at HTTP 200 to a dead
            # session; name it an auth failure, not a mystery success.
            raise XAuthError("X returned a non-JSON 200 (likely a logged-out page)")
        return payload


def graphql_url(host: str, query_id: str, operation_name: str) -> str:
    return f"{host.rstrip('/')}{GRAPHQL_PATH.format(query_id=query_id, operation_name=operation_name)}"


def whoami(
    session: XSession,
    *,
    host: str = "https://x.com",
    http_session: Session | None = None,
    screen_name: str | None = None,
    max_attempts: int = 3,
    sleep: Callable[[float], None] = time.sleep,
    backoff: Backoff | None = None,
    pacer: Pacer | None = None,
    query_id: str | None = None,
) -> dict:
    """Verify an authenticated session by reading an account, and return it.

    ``query_id`` lets the caller resolve the real operation id through the
    three-tier resolver (xreader); when omitted the pinned placeholder is used.
    """
    screen = screen_name or session.screen_name
    if not screen:
        raise XAuthError("whoami needs a screen_name (pass it or persist it with `relay cookies set`)")

    client = XClient(session=http_session, backoff=backoff, sleep=sleep, pacer=pacer)
    qid = query_id or USER_BY_SCREEN_NAME_QUERY_PLACEHOLDER
    url = graphql_url(host, qid, "UserByScreenName")
    body = {
        "variables": {"screen_name": screen, "withSafetyModeUserFields": False},
        "features": {},
        "queryId": qid,
    }
    payload = client.execute(url, body, session, max_attempts=max_attempts)
    return _unwrap_user(payload)


def _unwrap_user(payload: dict) -> dict:
    if not isinstance(payload, dict):
        raise XNotFoundError("whoami response was not an object")
    result = (payload.get("data") or {}).get("result")
    if not isinstance(result, dict):
        raise XNotFoundError("whoami response lacks a user result")
    user = user_from_result(result)
    return {key: user.get(key) for key in ("rest_id", "screen_name", "name", "verified")}


def user_from_result(result: dict) -> dict:
    """Map a UserByScreenName ``data.result`` object to the shared account
    shape both whoami and the GraphQL read layer consume."""
    legacy = result.get("legacy") or {}
    return {
        "rest_id": result.get("rest_id"),
        "screen_name": legacy.get("screen_name"),
        "name": legacy.get("name"),
        "verified": legacy.get("verified"),
        "description": legacy.get("description"),
        "followers_count": legacy.get("followers_count"),
        "following_count": legacy.get("following_count"),
        "location": legacy.get("location"),
    }