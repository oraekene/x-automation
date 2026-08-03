"""Write-layer tests (ticket 07): CreateTweet post/reply/quote over the transport."""

import json

import pytest

import xclient
import xreader
import xwriter

SESSION = xclient.XSession(auth_token="a", ct0="c", screen_name="bob")
RESOLVER = xreader.QueryIdResolver(client_json={"CreateTweet": "ctq"}, fallback={})
TEXT = "hello world"
QUOTED_URL = "https://x.com/bob/status/202"


def created_payload(tweet_id="101"):
    return {
        "data": {
            "create_tweet": {
                "tweet_results": {"result": {"rest_id": tweet_id, "legacy": {"id_str": tweet_id}}}
            }
        }
    }


class FakeTransport:
    """Canned transport; records (url, body, session) per call."""

    def __init__(self, payload=None, responses=None):
        self.payload = payload
        self.responses = list(responses or [])
        self.calls = []

    def __call__(self, url, body, session):
        self.calls.append((url, body, session))
        if self.responses:
            return self.responses.pop(0)
        if self.payload is not None:
            return self.payload
        raise AssertionError("no canned payload for transport call")


def test_post_tweet_sends_create_tweet_with_plain_text():
    transport = FakeTransport(payload=created_payload())
    tweet_id = xwriter.post_tweet(transport, SESSION, TEXT, resolver=RESOLVER)
    assert tweet_id == "101"
    url, body, session = transport.calls[0]
    assert session == SESSION
    assert url == "https://x.com/i/api/graphql/ctq/CreateTweet"
    assert body["queryId"] == "ctq"
    assert body["url"] == url
    variables = body["variables"]
    assert variables["tweet_text"] == TEXT
    assert variables["reply"] is None
    assert variables["attachment_url"] is None
    assert variables["dark_request"] is False


def test_reply_tweet_targets_in_reply_to():
    transport = FakeTransport(payload=created_payload())
    tweet_id = xwriter.reply_tweet(transport, SESSION, TEXT, in_reply_to_tweet_id="202", resolver=RESOLVER)
    assert tweet_id == "101"
    body = transport.calls[0][1]
    assert body["variables"]["reply"] == {"exclude_reply_user_ids": [], "in_reply_to_tweet_id": "202"}
    assert body["variables"]["attachment_url"] is None


def test_quote_tweet_attaches_quoted_url():
    transport = FakeTransport(payload=created_payload())
    tweet_id = xwriter.quote_tweet(transport, SESSION, TEXT, attachment_url=QUOTED_URL, resolver=RESOLVER)
    assert tweet_id == "101"
    body = transport.calls[0][1]
    assert body["variables"]["attachment_url"] == QUOTED_URL
    assert body["variables"]["reply"] is None


def test_missing_created_tweet_id_raises_x_error():
    transport = FakeTransport(payload={"data": {"create_tweet": {"tweet_results": {"result": {}}}}})
    with pytest.raises(xclient.XError):
        xwriter.post_tweet(transport, SESSION, TEXT, resolver=RESOLVER)


def test_create_tweet_errors_are_surfaced():
    transport = FakeTransport(payload={"errors": [{"code": 327, "message": "status is a duplicate"}]})
    with pytest.raises(xclient.XError):
        xwriter.post_tweet(transport, SESSION, TEXT, resolver=RESOLVER)


def test_writer_facade_delegates_plain_reply_quote():
    transport = FakeTransport(payload=created_payload())
    writer = xwriter.XWriter(transport, SESSION, resolver=RESOLVER)
    assert writer.post(TEXT) == "101"
    assert writer.reply(TEXT, in_reply_to_tweet_id="202") == "101"
    assert writer.quote(TEXT, attachment_url=QUOTED_URL) == "101"
    assert [c[0] for c in transport.calls] == ["https://x.com/i/api/graphql/ctq/CreateTweet"] * 3
    bodies = [c[1]["variables"] for c in transport.calls]
    assert bodies[0]["reply"] is None and bodies[0]["attachment_url"] is None
    assert bodies[1]["reply"] == {"exclude_reply_user_ids": [], "in_reply_to_tweet_id": "202"}
    assert bodies[2]["attachment_url"] == QUOTED_URL


def test_fallback_resolution_serves_offline_writes():
    transport = FakeTransport(payload=created_payload())
    tweet_id = xwriter.post_tweet(
        transport, SESSION, TEXT, resolver=xreader.QueryIdResolver(client_json={}, fallback={"CreateTweet": "ctq"})
    )
    assert tweet_id == "101"
    assert transport.calls[0][0] == "https://x.com/i/api/graphql/ctq/CreateTweet"


def test_rate_limit_backs_off_then_retries_through_client():
    sleeps = []
    client = xclient.XClient(
        session=FakeSession(
            [
                (429, b"rate limited"),
                (200, json.dumps(created_payload()).encode("utf-8")),
            ]
        ),
        backoff=xclient.Backoff(base_s=1.0, jitter_frac=0.0),
        pacer=None,
        sleep=sleeps.append,
    )
    writer = xwriter.XWriter(client.execute, SESSION, resolver=RESOLVER)
    assert writer.post(TEXT) == "101"
    assert sleeps == [1.0]


def test_write_rides_pacing_jitter_before_request():
    sleeps = []
    client = xclient.XClient(
        session=FakeSession([(200, json.dumps(created_payload()).encode("utf-8"))]),
        backoff=xclient.Backoff(jitter_frac=0.0),
        pacer=xclient.Pacer(mean_s=1.0, jitter_frac=0.0),
        sleep=sleeps.append,
    )
    writer = xwriter.XWriter(client.execute, SESSION, resolver=RESOLVER)
    assert writer.post(TEXT) == "101"
    assert sleeps == [1.0]


class FakeSession(xclient.Session):
    def __init__(self, responses):
        self.responses = list(responses)
        self.calls = []

    def request(self, method, url, headers, body):
        self.calls.append((url, body))
        return self.responses.pop(0)
