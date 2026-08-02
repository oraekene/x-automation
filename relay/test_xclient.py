"""X transport tests (ticket 05): header shaping, error taxonomy,
retry/backoff, pacing, and an authenticated whoami read."""

import json
import random
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer

import pytest

import xclient


def auth_session(**extra):
    data = {"auth_token": "at-1", "ct0": "csrf-1"}
    data.update(extra)
    return xclient.XSession.from_mapping(data)


class FakeSession:
    """Deterministic HTTP seam; returns canned (status, bytes) per call."""

    def __init__(self, *responses):
        self.responses = [r if isinstance(r, tuple) else (200, r) for r in responses]
        self.calls = []

    def request(self, method, url, headers, body):
        self.calls.append((method, url, headers, body))
        status, payload = self.responses.pop(0)
        if isinstance(payload, dict):
            payload = json.dumps(payload).encode()
        return status, payload


def graphql_user_payload(rest_id="1234", screen_name="alice", name="Alice"):
    return {
        "data": {
            "result": {
                "__typename": "User",
                "rest_id": rest_id,
                "legacy": {"screen_name": screen_name, "name": name, "verified": False},
            }
        }
    }


class TestErrorTaxonomy:
    def test_429_rate_limit_is_retryable(self):
        err = xclient.classify_response(429, {"errors": [{"code": 88}]})
        assert isinstance(err, xclient.XRateLimitError)
        assert err.retryable is True

    def test_graphql_rate_error_code_is_retryable(self):
        err = xclient.classify_response(200, {"errors": [{"code": 88, "message": "rate limit exceeded"}]})
        assert isinstance(err, xclient.XRateLimitError)

    def test_401_bad_token_is_auth(self):
        err = xclient.classify_response(401, {"errors": [{"code": 32, "message": "Could not authenticate"}]})
        assert isinstance(err, xclient.XAuthError)
        assert err.retryable is False

    def test_logged_out_error_is_auth(self):
        err = xclient.classify_response(200, {"errors": [{"code": 326}]})
        assert isinstance(err, xclient.XAuthError)

    def test_not_found_code_34(self):
        err = xclient.classify_response(200, {"errors": [{"code": 34}]})
        assert isinstance(err, xclient.XNotFoundError)

    def test_not_found_code_50_user_missing(self):
        err = xclient.classify_response(200, {"errors": [{"code": 50}]})
        assert isinstance(err, xclient.XNotFoundError)
        assert err.retryable is False

    def test_500_is_transient_retryable(self):
        err = xclient.classify_response(500, {})
        assert isinstance(err, xclient.XTransientError)
        assert err.retryable is True

    def test_success_returns_none(self):
        assert xclient.classify_response(200, {"data": {}}) is None


class TestBackoffAndPacing:
    def test_jitter_off_gives_exponential(self):
        backoff = xclient.Backoff(base_s=1.0, factor=2.0, cap_s=30.0, jitter_frac=0.0)
        assert backoff.delay(1) == 1.0
        assert backoff.delay(2) == 2.0
        assert backoff.delay(3) == 4.0
        assert backoff.delay(4) == 8.0

    def test_backoff_caps(self):
        backoff = xclient.Backoff(base_s=4.0, factor=2.0, cap_s=5.0, jitter_frac=0.0)
        assert backoff.delay(1) == 4.0
        assert backoff.delay(5) == 5.0

    def test_jitter_stays_within_bounds(self):
        rng = random.Random(7)
        backoff = xclient.Backoff(base_s=2.0, factor=2.0, cap_s=60.0, jitter_frac=0.25, rng=rng)
        for attempt in range(1, 6):
            raw = min(2.0 * (2.0 ** (attempt - 1)), 60.0)
            assert raw * 0.75 <= backoff.delay(attempt) <= raw * 1.25

    def test_pacer_delay_human_bounds(self):
        pacer = xclient.Pacer(mean_s=5.0, jitter_frac=0.3, rng=random.Random(3))
        assert 3.5 <= pacer.delay() <= 6.5

    def test_pacer_applies_before_each_request(self):
        sleeps = []
        session = FakeSession(graphql_user_payload())
        xclient.whoami(
            auth_session(screen_name="alice"),
            http_session=session,
            sleep=sleeps.append,
            pacer=xclient.Pacer(mean_s=0.05, jitter_frac=0.0, rng=random.Random(0)),
            backoff=xclient.Backoff(base_s=0.01, factor=2.0, cap_s=0.1, jitter_frac=0.0),
        )
        assert sleeps == [0.05]


class TestHeaderShaping:
    def test_shaped_headers_present(self):
        session = auth_session()
        headers = xclient.twitter_request_headers(session)
        assert headers["User-Agent"].startswith("Mozilla/5.0")
        assert headers["User-Agent"].endswith("Chrome/124.0.0.0 Safari/537.36")
        assert "Chromium" in headers["sec-ch-ua"]
        assert headers["sec-ch-ua-platform"] == '"Windows"'
        assert headers["sec-ch-ua-mobile"] == "?0"
        assert headers["X-Csrf-Token"] == "csrf-1"
        assert headers["Cookie"] == session.cookie_header()
        assert headers["Sec-Fetch-Site"] == "same-origin"
        assert headers["X-Client-Transaction-Id"]

    def test_client_transaction_id_varies_per_call(self):
        first = xclient.twitter_request_headers(auth_session())
        second = xclient.twitter_request_headers(auth_session())
        assert len(first["X-Client-Transaction-Id"]) >= 32
        assert first["X-Client-Transaction-Id"] != second["X-Client-Transaction-Id"]


class TestXSession:
    def test_from_mapping_requires_both_cookies(self):
        with pytest.raises(xclient.XAuthError):
            xclient.XSession.from_mapping({"auth_token": "x"})

    def test_round_trips_through_mapping(self):
        session = xclient.XSession.from_mapping({"auth_token": "a", "ct0": "b", "screen_name": "al"})
        assert xclient.XSession.from_mapping(session.to_mapping()) == session


class TestWhoami:
    def test_valid_session_returns_viewer(self):
        session = FakeSession(graphql_user_payload())
        result = xclient.whoami(auth_session(screen_name="alice"), http_session=session)
        assert result == {"rest_id": "1234", "screen_name": "alice", "name": "Alice", "verified": False}
        method, url, headers, body = session.calls[0]
        assert method == "POST"
        assert url.endswith("/UserByScreenName")
        assert "/i/api/graphql/" in url
        assert headers["X-Csrf-Token"] == "csrf-1"
        assert "auth_token=at-1" in headers["Cookie"]

    def test_expired_session_fails_cleanly(self):
        expired = (401, {"errors": [{"code": 89, "message": "Invalid or expired token"}]})
        with pytest.raises(xclient.XAuthError):
            xclient.whoami(auth_session(screen_name="alice"), http_session=FakeSession(expired))

    def test_empty_session_rejected(self):
        with pytest.raises(xclient.XAuthError):
            xclient.whoami(xclient.XSession(auth_token="", ct0="csrf-1"), http_session=FakeSession())

    def test_screen_name_resolves_from_session(self):
        session = FakeSession(graphql_user_payload(screen_name="kept"))
        xclient.whoami(auth_session(screen_name="saved-store"), http_session=session)
        body = json.loads(session.calls[0][3])
        assert body["variables"]["screen_name"] == "saved-store"

    def test_retries_transient_then_succeeds(self):
        sleeps = []
        session = FakeSession((500, {}), graphql_user_payload())
        result = xclient.whoami(
            auth_session(screen_name="alice"),
            http_session=session,
            sleep=sleeps.append,
            backoff=xclient.Backoff(base_s=0.01, factor=2.0, cap_s=0.1, jitter_frac=0.0),
        )
        assert result["screen_name"] == "alice"
        assert sleeps == [0.01]

    def test_raises_after_retries_exhausted(self):
        session = FakeSession((500, {}), (500, {}), (500, {}))
        with pytest.raises(xclient.XTransientError):
            xclient.whoami(
                auth_session(screen_name="alice"),
                http_session=session,
                max_attempts=3,
                sleep=lambda _: None,
                backoff=xclient.Backoff(base_s=0.0, factor=2.0, cap_s=0.0, jitter_frac=0.0),
            )


def test_whoami_over_real_http_to_a_fake_x_server():
    """Seam 2: the stdlib session talks to a local GraphQL stand-in."""
    seen = {}

    class FakeX(BaseHTTPRequestHandler):
        def do_POST(self):  # noqa: N802
            seen["path"] = self.path
            seen["x-csrf"] = self.headers.get("X-Csrf-Token")
            seen["cookie"] = self.headers.get("Cookie")
            length = int(self.headers.get("Content-Length", 0))
            seen["body"] = self.rfile.read(length).decode()
            body = json.dumps(graphql_user_payload("999", "bob", "Bob")).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(body)

        def log_message(self, *args):  # silence
            pass

    server = HTTPServer(("127.0.0.1", 0), FakeX)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        host = f"http://127.0.0.1:{server.server_port}"
        result = xclient.whoami(
            auth_session(screen_name="bob"),
            http_session=xclient.StdlibSession(),
            host=host,
        )
        assert result == {
            "rest_id": "999",
            "screen_name": "bob",
            "name": "Bob",
            "verified": False,
        }
        assert "/i/api/graphql" in seen["path"]
        assert seen["x-csrf"] == "csrf-1"
        assert "auth_token=at-1" in seen["cookie"]
        payload = json.loads(seen["body"])
        assert payload["variables"]["screen_name"] == "bob"
    finally:
        server.shutdown()
        thread.join()