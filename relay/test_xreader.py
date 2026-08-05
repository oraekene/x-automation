"""X GraphQL read-layer tests (ticket 06): queryId resolution, search query
building, domain mapping (Tweet/UserProfile), pagination, and command wiring.

Seams under test:
- queryId resolution: QueryIdResolver with an injected loader callable, so the
  fetch tier never touches real X in unit tests.
- transport: reader operations are driven through a callable transport backed
  by canned GraphQL payloads, matching the relay command seam.
"""

import json

import pytest

import xclient
import xreader


def tweet(rest_id, author="alice", full_text=None, in_reply_to_tweet_id=None, in_reply_to_screen_name=None):
    legacy = {
        "full_text": full_text or f"tweet {rest_id} text",
        "created_at": "Sat Jul 25 12:00:00 +0000 2026",
        "favorite_count": 10,
        "retweet_count": 2,
        "reply_count": 1,
        "lang": "en",
    }
    if in_reply_to_tweet_id:
        legacy["in_reply_to_status_id_str"] = in_reply_to_tweet_id
    if in_reply_to_screen_name:
        legacy["in_reply_to_screen_name"] = in_reply_to_screen_name
    return {
        "__typename": "Tweet",
        "rest_id": rest_id,
        "legacy": legacy,
        "core": {
            "user_results": {
                "data": {"legacy": {"screen_name": author, "name": "Alice"}}
            }
        },
    }


def timeline_payload(entries):
    return {
        "data": {
            "search_by_raw_query": {
                "search_timeline": {
                    "timeline": {
                        "instructions": [{"type": "TimelineAddEntries", "entries": entries}]
                    }
                }
            }
        }
    }


def tweet_entry(rest_id):
    return {"entryId": f"tweet-{rest_id}", "content": {"itemContent": {"tweet_results": {"result": tweet(rest_id)}}}}


def cursor_entry(token):
    return {
        "entryId": f"cursor-{token}",
        "content": {"entryType": "TimelineTimelineCursor", "value": {"value": token, "cursorType": "Bottom"}},
    }


class FakeTransport:
    def __init__(self, *responses):
        self.responses = [r if isinstance(r, dict) else json.loads(r) for r in responses]
        self.calls = []

    def __call__(self, url, query, session):
        self.calls.append((url, query))
        return self.responses.pop(0)


def session_in(**extra):
    data = {"auth_token": "at-1", "ct0": "csrf-1"}
    data.update(extra)
    return xclient.XSession.from_mapping(data)


def make_resolver():
    return xreader.QueryIdResolver(
        client_json={"UserByScreenName": "user-screen-id-current", "SearchTimeline": "search-tl-current"},
        fallback=xreader.FALLBACK_QUERY_IDS,
    )


class TestQueryIdResolution:
    def test_prefers_client_json_over_fallback(self):
        resolver = xreader.QueryIdResolver(
            client_json={"UserByScreenName": "real-json-id"},
            fallback={"UserByScreenName": "fallback-id"},
        )
        assert resolver.resolve("UserByScreenName") == "real-json-id"

    def test_falls_back_to_constants(self):
        resolver = xreader.QueryIdResolver(client_json={})
        assert resolver.resolve("UserByScreenName") == xreader.FALLBACK_QUERY_IDS["UserByScreenName"]
        assert resolver.resolve("UserTweets") == xreader.FALLBACK_QUERY_IDS["UserTweets"]

    def test_missing_operation_raises(self):
        resolver = xreader.QueryIdResolver(client_json={})
        with pytest.raises(xreader.QueryIdNotFoundError):
            resolver.resolve("NoSuchOperation")

    def test_fetched_tier_is_last_and_cached(self):
        calls = []

        def fetch():
            calls.append(1)
            return {"UserFollowingTimeline": "fetched-id", "UserByScreenName": "fetched-user"}

        resolver = xreader.QueryIdResolver(client_json={}, fetch=fetch)
        assert resolver.resolve("UserFollowingTimeline") == "fetched-id"
        assert resolver.resolve("UserFollowingTimeline") == "fetched-id"
        assert len(calls) == 1

    def test_fetch_never_overrides_client_json(self):
        resolver = xreader.QueryIdResolver(
            client_json={"SearchTimeline": "vendored-id"},
            fetch=lambda: {"SearchTimeline": "fetched-id"},
        )
        assert resolver.resolve("SearchTimeline") == "vendored-id"


class TestSearchBuilding:
    def test_to_x_query_composes_operators(self):
        criteria = xreader.SearchCriteria(
            keywords=["roadmap", "vmruiz"],
            hashtags=["remit"],
            mentions=["bob"],
            min_faves=10,
            min_retweets=5,
            min_replies=2,
            lang="en",
            since="2026-07-01",
            until="2026-07-31",
        )
        assert criteria.to_x_query() == (
            "roadmap vmruiz #remit from:bob min_faves:10 min_retweets:5 min_replies:2 lang:en since:2026-07-01 until:2026-07-31"
        )

    def test_keywords_only(self):
        assert xreader.SearchCriteria(keywords=["rust"]).to_x_query() == "rust"


class TestDomainMapping:
    def test_timeline_payload_maps_to_tweets(self):
        payload = timeline_payload([tweet_entry("1"), cursor_entry("next-bob")])
        tweets = xreader.extract_tweets(payload)
        assert len(tweets) == 1
        assert tweets[0].author == "alice"
        assert tweets[0].favorite_count == 10
        assert tweets[0].text == "tweet 1 text"
        assert tweets[0].reply_count == 1
        assert tweets[0].lang == "en"

    def test_tweet_extracts_in_reply_to_fields(self):
        reply_data = tweet(
            "99",
            author="bob",
            full_text="replying to you",
            in_reply_to_tweet_id="original-123",
            in_reply_to_screen_name="alice",
        )
        entry = {"entryId": "tweet-99", "content": {"itemContent": {"tweet_results": {"result": reply_data}}}}
        payload = timeline_payload([entry])
        tweets = xreader.extract_tweets(payload)
        assert len(tweets) == 1
        assert tweets[0].in_reply_to_tweet_id == "original-123"
        assert tweets[0].in_reply_to_screen_name == "alice"

    def test_tweet_in_reply_fields_none_when_not_reply(self):
        payload = timeline_payload([tweet_entry("1")])
        tweets = xreader.extract_tweets(payload)
        assert tweets[0].in_reply_to_tweet_id is None
        assert tweets[0].in_reply_to_screen_name is None

    def test_tweet_as_mapping_includes_reply_fields(self):
        t = xreader.Tweet(
            id="99", author="bob", text="reply", created_at="",
            favorite_count=0, retweet_count=0, reply_count=0, lang="en",
            in_reply_to_tweet_id="orig-1", in_reply_to_screen_name="alice",
        )
        m = t.as_mapping()
        assert m["in_reply_to_tweet_id"] == "orig-1"
        assert m["in_reply_to_screen_name"] == "alice"


class TestPagination:
    def test_paginates_until_terminal_page(self):
        transport = FakeTransport(
            timeline_payload([tweet_entry("1"), cursor_entry("abc")]),
            timeline_payload([tweet_entry("2")]),
        )
        tweets = xreader.search_tweets(
            transport,
            session_in(),
            criteria=xreader.SearchCriteria(keywords=["rust"]),
            resolver=make_resolver(),
        )
        assert [t.id for t in tweets] == ["1", "2"]
        first_url, first_query = transport.calls[0]
        assert first_query["variables"].get("cursor") is None
        assert first_url.endswith("/SearchTimeline")
        _, second_query = transport.calls[1]
        assert second_query["variables"]["cursor"] == "abc"

    def test_stops_when_no_cursor_present(self):
        transport = FakeTransport(timeline_payload([tweet_entry("1")]))
        tweets = xreader.search_tweets(
            transport,
            session_in(),
            criteria=xreader.SearchCriteria(keywords=["rust"]),
            resolver=make_resolver(),
        )
        assert [t.id for t in tweets] == ["1"]
        assert len(transport.calls) == 1

    def test_max_pages_bounds_the_walk(self):
        transport = FakeTransport(
            timeline_payload([tweet_entry("1"), cursor_entry("a")]),
            timeline_payload([tweet_entry("2"), cursor_entry("b")]),
            timeline_payload([tweet_entry("3"), cursor_entry("c")]),
        )
        tweets = xreader.search_tweets(
            transport,
            session_in(),
            criteria=xreader.SearchCriteria(keywords=["rust"]),
            resolver=make_resolver(),
            max_pages=2,
        )
        assert len(tweets) == 2
        assert len(transport.calls) == 2


def test_profile_lookup_carries_user_profile():
    payload = {
        "data": {
            "result": {
                "rest_id": "111",
                "legacy": {
                    "screen_name": "nobody",
                    "name": "Bob Nobody",
                    "description": "profile bio",
                    "followers_count": 800,
                    "following_count": 12,
                    "verified": True,
                    "location": "Lisbon",
                },
            }
        }
    }
    transport = FakeTransport(payload)
    profile = xreader.profile_lookup(transport, session_in(), "nobody", resolver=make_resolver())
    assert profile.screen_name == "nobody"
    assert profile.bio == "profile bio"
    assert profile.followers_count == 800
    assert profile.verified is True
    assert profile.location == "Lisbon"


def test_profile_lookup_url_targets_user_by_screen_name():
    transport = FakeTransport({"data": {"result": {"rest_id": "1", "legacy": {}}}})
    xreader.profile_lookup(transport, session_in(), "nobody", resolver=make_resolver())
    url, _ = transport.calls[0]
    assert url.endswith("/UserByScreenName")
    assert "user-screen-id-current" in url


def user_posts_payload(rest_ids):
    entries = [tweet_entry(r) for r in rest_ids]
    return {
        "data": {
            "user": {
                "result": {
                    "timeline_v2": {
                        "timeline": {
                            "instructions": [{"type": "TimelineAddEntries", "entries": entries}]
                        }
                    }
                }
            }
        }
    }


def test_user_posts_single_page():
    profile_payload = {
        "data": {
            "result": {
                "rest_id": "111",
                "legacy": {"screen_name": "nobody", "name": "Bob", "description": "", "followers_count": 0},
            }
        }
    }
    transport = FakeTransport(profile_payload, user_posts_payload(["10", "11"]))
    posts = xreader.user_posts(
        transport,
        session_in(),
        "nobody",
        resolver=make_resolver(),
    )
    assert [t.id for t in posts] == ["10", "11"]
    _, timeline_body = transport.calls[1]
    assert timeline_body["variables"]["userId"] == "111"


def test_user_posts_paginates():
    profile_payload = {
        "data": {
            "result": {
                "rest_id": "111",
                "legacy": {"screen_name": "nobody", "name": "Bob", "description": "", "followers_count": 0},
            }
        }
    }
    paged = lambda rest_ids, cursor=None: {
        "data": {
            "user": {
                "result": {
                    "timeline_v2": {
                        "timeline": {
                            "instructions": [
                                {
                                    "type": "TimelineAddEntries",
                                    "entries": [
                                        *(tweet_entry(r) for r in rest_ids),
                                        *(cursor and [cursor_entry(cursor)] or []),
                                    ],
                                }
                            ]
                        }
                    }
                }
            }
        }
    }
    transport = FakeTransport(
        profile_payload,
        paged(["10"], "a"),
        paged(["11"]),
    )
    posts = xreader.user_posts(
        transport,
        session_in(),
        "nobody",
        resolver=make_resolver(),
        max_pages=2,
    )
    assert [t.id for t in posts] == ["10", "11"]
    assert transport.calls[2][1]["variables"]["cursor"] == "a"

def user_result(rest_id, screen_name, *, followers=500, verified=False, location="London", bio="founder"):
    return {
        "rest_id": rest_id,
        "legacy": {
            "screen_name": screen_name,
            "name": screen_name.title(),
            "verified": verified,
            "description": bio,
            "followers_count": followers,
            "following_count": 2,
            "location": location,
        },
    }


def profile_entry(rest_id, screen_name, **kwargs):
    return {
        "entryId": f"user-{rest_id}",
        "content": {"itemContent": {"user_results": {"result": user_result(rest_id, screen_name, **kwargs)}}},
    }


class TestProfileSearch:
    def test_extract_profiles_reads_people_results(self):
        payload = timeline_payload(
            [profile_entry("1", "founder1", followers=1200), profile_entry("2", "founder2")]
        )
        profiles = xreader.extract_profiles(payload)
        assert [p.screen_name for p in profiles] == ["founder1", "founder2"]
        assert profiles[0].followers_count == 1200
        assert profiles[0].location == "London"

    def test_search_profiles_filters_and_sends_people_product(self):
        transport = FakeTransport(
            timeline_payload(
                [
                    profile_entry("1", "big_founder", followers=5000, verified=True, location="London"),
                    profile_entry("2", "small_dev", followers=50),
                    profile_entry("3", "londoner", followers=900),
                ]
            )
        )
        criteria = xreader.ProfileCriteria(
            keywords=["founder"], min_followers=1000, verified_only=True, location="london"
        )
        profiles = xreader.search_profiles(
            transport, session_in(), criteria=criteria, resolver=make_resolver()
        )
        assert [p.screen_name for p in profiles] == ["big_founder"]
        url, query = transport.calls[0]
        assert url == "https://x.com/i/api/graphql/search-tl-current/SearchTimeline"
        assert query["variables"]["rawQuery"] == "founder"
        assert query["variables"]["product"] == "People"

    def test_search_profiles_walks_pages_and_caps(self):
        transport = FakeTransport(
            timeline_payload([profile_entry("1", "a"), profile_entry("2", "b"), cursor_entry("c1")]),
            timeline_payload([profile_entry("3", "c"), profile_entry("4", "d")]),
        )
        profiles = xreader.search_profiles(
            transport,
            session_in(),
            criteria=xreader.ProfileCriteria(keywords=["x"]),
            resolver=make_resolver(),
            max_profiles=3,
        )
        assert len(transport.calls) == 2
        assert [p.screen_name for p in profiles] == ["a", "b", "c"]

    def test_search_profiles_stops_without_next_cursor(self):
        transport = FakeTransport(timeline_payload([profile_entry("1", "a")]))
        profiles = xreader.search_profiles(
            transport, session_in(), criteria=xreader.ProfileCriteria(keywords=["x"]), resolver=make_resolver()
        )
        assert len(transport.calls) == 1
        assert [p.screen_name for p in profiles] == ["a"]


class TestInboundScan:
    def test_inbound_scan_filters_to_reply_tweets(self):
        reply_data = tweet(
            "r1",
            author="bob",
            full_text="replying to you",
            in_reply_to_tweet_id="user-tweet-1",
            in_reply_to_screen_name="alice",
        )
        non_reply = tweet("r2", author="carol", full_text="just a tweet")
        transport = FakeTransport(
            timeline_payload([
                {"entryId": "tweet-r1", "content": {"itemContent": {"tweet_results": {"result": reply_data}}}},
                {"entryId": "tweet-r2", "content": {"itemContent": {"tweet_results": {"result": non_reply}}}},
            ])
        )
        reader = xreader.XReader(transport, session_in(), screen_name="alice", resolver=make_resolver())
        inbound = reader.inbound_scan(max_pages=1)
        assert len(inbound) == 1
        assert inbound[0].in_reply_to_tweet_id == "user-tweet-1"

    def test_inbound_scan_uses_to_screen_name_search(self):
        transport = FakeTransport(timeline_payload([]))
        reader = xreader.XReader(transport, session_in(), screen_name="alice", resolver=make_resolver())
        reader.inbound_scan(max_pages=1)
        _, query = transport.calls[0]
        assert query["variables"]["rawQuery"] == "to:alice"

    def test_inbound_scan_requires_screen_name(self):
        session = xclient.XSession.from_mapping({"auth_token": "at", "ct0": "ct"})
        reader = xreader.XReader(FakeTransport({}), session, resolver=make_resolver())
        reader._screen_name = None
        with pytest.raises(ValueError, match="screen_name"):
            reader.inbound_scan()
