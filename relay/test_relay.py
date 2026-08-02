import json
import threading
import unittest.mock as mock
from http.server import BaseHTTPRequestHandler, HTTPServer

import relay as relay_mod


class Handler(BaseHTTPRequestHandler):
    healthy = True

    def do_GET(self):  # noqa: N802
        if self.path == "/health":
            body = json.dumps({"status": "ok" if Handler.healthy else "degraded", "d1": Handler.healthy})
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(body.encode())
        else:
            self.send_response(404)
            self.end_headers()

    def log_message(self, *args):  # silence
        pass


def test_check_health_ok():
    server = HTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        base = f"http://127.0.0.1:{server.server_port}"
        assert relay_mod.check_health(base, {}) is True
    finally:
        server.shutdown()
        thread.join()


def test_check_health_degraded():
    Handler.healthy = False
    server = HTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        base = f"http://127.0.0.1:{server.server_port}"
        assert relay_mod.check_health(base, {}) is False
    finally:
        Handler.healthy = True
        server.shutdown()
        thread.join()


def test_check_health_unreachable():
    assert relay_mod.check_health("http://127.0.0.1:1", {}) is False


def test_run_polls_until_stopped():
    states = []

    def record(msg: str) -> None:
        states.append(msg)

    stop_count = 0

    def should_stop() -> bool:
        nonlocal stop_count
        stop_count += 1
        return stop_count >= 3

    config = relay_mod.RelayConfig(base_url="http://127.0.0.1:1", poll_interval_s=0.001)
    relay_mod.run(config, should_stop=should_stop, on_status=record, sleep=lambda _: None)
    assert len(states) == 2
    assert all(s == "unreachable" for s in states)


def test_run_connected_status():
    server = HTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        states = []

        def record(msg: str) -> None:
            states.append(msg)

        stop_count = 0

        def should_stop() -> bool:
            nonlocal stop_count
            stop_count += 1
            return stop_count >= 2

        config = relay_mod.RelayConfig(base_url=f"http://127.0.0.1:{server.server_port}", poll_interval_s=0.001)
        relay_mod.run(config, should_stop=should_stop, on_status=record, sleep=lambda _: None)
        assert states == ["connected"]
    finally:
        server.shutdown()
        thread.join()


def test_fetch_json_raises_on_bad_url():
    try:
        relay_mod.fetch_json("http://127.0.0.1:1/health")
        assert False, "expected RelayError"
    except relay_mod.RelayError:
        pass
