import json
import threading
from contextlib import contextmanager
from http.server import BaseHTTPRequestHandler, HTTPServer

import relay as relay_mod


class HealthHandler(BaseHTTPRequestHandler):
    status = "ok"

    def do_GET(self):  # noqa: N802
        if self.path == "/health":
            body = json.dumps({"status": self.__class__.status, "d1": self.__class__.status == "ok"})
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(body.encode())
        else:
            self.send_response(404)
            self.end_headers()

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
        server.shutdown()
        thread.join()


def test_check_health_ok():
    with serving(HealthHandler) as base:
        assert relay_mod.check_health(base) is True


def test_check_health_degraded():
    class Degraded(HealthHandler):
        status = "degraded"

    with serving(Degraded) as base:
        assert relay_mod.check_health(base) is False


def test_check_health_unreachable():
    assert relay_mod.check_health("http://127.0.0.1:1") is False


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
    states = []

    def record(msg: str) -> None:
        states.append(msg)

    stop_count = 0

    def should_stop() -> bool:
        nonlocal stop_count
        stop_count += 1
        return stop_count >= 2

    with serving(HealthHandler) as base:
        config = relay_mod.RelayConfig(base_url=base, poll_interval_s=0.001)
        relay_mod.run(config, should_stop=should_stop, on_status=record, sleep=lambda _: None)
    assert states == ["connected"]


def test_fetch_json_raises_on_bad_url():
    try:
        relay_mod.fetch_json("http://127.0.0.1:1/health")
        assert False, "expected RelayError"
    except relay_mod.RelayError:
        pass