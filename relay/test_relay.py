import json
import threading
from contextlib import contextmanager
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

import relay as relay_mod
import xreader


class FakeWorker(BaseHTTPRequestHandler):
    """Stands in for the Worker command channel.

    Class state (shared across requests): create -> issues relay_id + code,
    pair -> token, commands -> pending list, results recorder.
    """

    pairing_code = "ABC123"
    relay_id = "relay-1"
    token = "tok-123"
    commands = []
    results = []
    last_auth = None

    def _read_json(self):
        length = int(self.headers.get("Content-Length", 0))
        return json.loads(self.rfile.read(length).decode()) if length else {}

    def _send(self, code, payload):
        body = json.dumps(payload).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self):  # noqa: N802
        body = self._read_json()
        if self.path == "/api/relays":
            self._send(201, {"relay_id": self.relay_id, "pairing_code": self.pairing_code})
        elif self.path == "/api/relays/pair":
            if body.get("relay_id") != self.relay_id or body.get("pairing_code") != self.pairing_code:
                self._send(401, {"error": "invalid pairing code"})
            else:
                self._send(200, {"relay_id": self.relay_id, "token": self.token})
        elif self.path == f"/api/relays/{self.relay_id}/results":
            self.__class__.results.extend(body.get("results", []))
            self._send(200, {"updated": len(body.get("results", []))})
        else:
            self._send(404, {"error": "not found"})

    def do_GET(self):  # noqa: N802
        self.__class__.last_auth = self.headers.get("Authorization")
        if self.path == f"/api/relays/{self.relay_id}/commands":
            if self.headers.get("Authorization") != f"Bearer {self.token}":
                self._send(401, {"error": "unauthorized"})
            else:
                self._send(200, {"commands": self.__class__.commands})
        else:
            self._send(404, {"error": "not found"})

    def log_message(self, *args):  # silence
        pass


@contextmanager
def serving(handler):
    server = HTTPServer(("127.0.0.1", 0), handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield f"http://127.0.0.1:{server.server_port}"
    finally:
        FakeWorker.commands = []
        FakeWorker.results = []
        FakeWorker.last_auth = None
        server.shutdown()
        thread.join()


def state_for(base):
    return relay_mod.RelayState(relay_id=FakeWorker.relay_id, token=FakeWorker.token, base_url=base)


def test_pair_exchange_returns_token():
    with serving(FakeWorker) as base:
        result = relay_mod.pair_relay(base, FakeWorker.relay_id, FakeWorker.pairing_code)
        assert result["relay_id"] == FakeWorker.relay_id
        assert result["token"] == FakeWorker.token


def test_pair_rejects_bad_code():
    with serving(FakeWorker) as base:
        try:
            relay_mod.pair_relay(base, FakeWorker.relay_id, "NOPE")
            assert False, "expected RelayError"
        except relay_mod.RelayError as e:
            assert "401" in str(e)


def test_state_save_and_load_roundtrip(tmp_path: Path):
    f = tmp_path / "state.json"
    relay_mod.RelayState(relay_id="r1", token="t1", base_url="http://x").save(f)
    loaded = relay_mod.RelayState.load(f)
    assert loaded.relay_id == "r1"
    assert loaded.token == "t1"
    assert loaded.base_url == "http://x"


def test_execute_echo_command():
    result = relay_mod.execute_command({"type": "echo", "payload": {"message": "hi"}})
    assert result == {"ok": True, "output": {"echoed": "hi"}}


class FakeReader:
    """Fake read seam; returns canned domain values and records calls."""

    def __init__(self, tweets=None, profile=None):
        self.tweets = tweets or []
        self.fake_profile = profile or xreader.UserProfile(
            rest_id="1", screen_name="bob", name="B", bio="", followers_count=0, following_count=0, verified=False, location=None
        )
        self.calls = []

    def search(self, criteria):
        self.calls.append(("search", criteria))
        return self.tweets

    def user_posts(self, screen_name):
        self.calls.append(("user_posts", screen_name))
        return self.tweets

    def profile(self, screen_name):
        self.calls.append(("profile", screen_name))
        return self.fake_profile


def make_tweet(id="1", author="bob"):
    return xreader.Tweet(id=id, author=author, text="hello", created_at="", favorite_count=1, retweet_count=0, reply_count=0, lang="en")


def test_search_command_reports_tweets():
    reader = FakeReader(tweets=[make_tweet("1"), make_tweet("2")])
    result = relay_mod.execute_command(
        {
            "type": "search",
            "payload": {"keywords": ["openai"], "lang": "en", "min_faves": 5},
        },
        reader=reader,
    )
    assert result["ok"] is True
    assert [t["id"] for t in result["output"]["tweets"]] == ["1", "2"]
    called, criteria = reader.calls[0]
    assert called == "search"
    assert criteria.lang == "en"
    assert criteria.min_faves == 5
    assert criteria.keywords == ["openai"]


def test_user_posts_command_reports_tweets():
    reader = FakeReader(tweets=[make_tweet("7")])
    result = relay_mod.execute_command(
        {"type": "user_posts", "payload": {"screen_name": "bob"}},
        reader=reader,
    )
    assert result["ok"] is True
    assert reader.calls == [("user_posts", "bob")]
    assert result["output"]["tweets"][0]["id"] == "7"


def test_profile_command_reports_profile():
    reader = FakeReader(profile=xreader.UserProfile(
        rest_id="1", screen_name="bob", name="Bob", bio="bio", followers_count=9, following_count=1, verified=True, location="LA"
    ))
    result = relay_mod.execute_command(
        {"type": "profile", "payload": {"screen_name": "bob"}},
        reader=reader,
    )
    assert result["ok"] is True
    profile = result["output"]["profile"]
    assert profile["screen_name"] == "bob"
    assert profile["followers_count"] == 9


def test_read_command_without_reader_fails_cleanly():
    result = relay_mod.execute_command({"type": "search", "payload": {"keywords": ["x"]}})
    assert result["ok"] is False
    assert "reader" in result["output"]["error"]


def test_run_once_routes_read_commands_through_reader():
    with serving(FakeWorker) as base:
        FakeWorker.commands = [
            {"id": "c10", "type": "search", "payload": {"keywords": ["x"]}},
            {"id": "c11", "type": "echo", "payload": {"message": "hi"}},
        ]
        results = relay_mod.run_once(state_for(base), reader=FakeReader(tweets=[make_tweet("3")]))
        assert results == [
            {"command_id": "c10", "ok": True, "output": {"tweets": [make_tweet("3").as_mapping()]}},
            {"command_id": "c11", "ok": True, "output": {"echoed": "hi"}},
        ]
        assert FakeWorker.results == results


def test_execute_unknown_command_fails():
    result = relay_mod.execute_command({"type": "nope"})
    assert result["ok"] is False
    assert "unknown command type" in result["output"]["error"]


def test_run_once_polls_executes_reports():
    with serving(FakeWorker) as base:
        FakeWorker.commands = [
            {"id": "c1", "type": "echo", "payload": {"message": "one"}},
            {"id": "c2", "type": "echo", "payload": {"message": "two"}},
        ]
        results = relay_mod.run_once(state_for(base))
        assert FakeWorker.last_auth == f"Bearer {FakeWorker.token}"
        assert FakeWorker.results == [
            {"command_id": "c1", "ok": True, "output": {"echoed": "one"}},
            {"command_id": "c2", "ok": True, "output": {"echoed": "two"}},
        ]
        assert len(results) == 2


def test_run_once_reports_failure_for_unknown_type():
    with serving(FakeWorker) as base:
        FakeWorker.commands = [{"id": "c1", "type": "mystery", "payload": {}}]
        relay_mod.run_once(state_for(base))
        assert FakeWorker.results == [{"command_id": "c1", "ok": False, "output": {"error": "unknown command type: 'mystery'"}}]


def test_run_loop_connected_status():
    states = []

    def record(msg: str) -> None:
        states.append(msg)

    stop_count = 0

    def should_stop() -> bool:
        nonlocal stop_count
        stop_count += 1
        return stop_count >= 2

    with serving(FakeWorker) as base:
        relay_mod.run_loop(state_for(base), should_stop=should_stop, on_status=record, sleep=lambda _: None)
    assert states == ["connected"]


def test_run_loop_unreachable():
    states = []

    def record(msg: str) -> None:
        states.append(msg)

    stop_count = 0

    def should_stop() -> bool:
        nonlocal stop_count
        stop_count += 1
        return stop_count >= 3

    relay_mod.run_loop(
        state_for("http://127.0.0.1:1"),
        should_stop=should_stop,
        on_status=record,
        sleep=lambda _: None,
    )
    assert states == ["unreachable", "unreachable"]


def test_fetch_json_raises_on_bad_url():
    try:
        relay_mod.fetch_json("http://127.0.0.1:1/health")
        assert False, "expected RelayError"
    except relay_mod.RelayError:
        pass