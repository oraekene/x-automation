"""X GraphQL read layer (tickets 06 + 08).

The read side of the transport in ``xclient``: resolves GraphQL operations to
their queryId (three tiers), builds X search queries from structured criteria,
walks timeline cursors across pages, and maps raw X payloads into the funnel's
domain types (``Tweet``, ``UserProfile``). Ticket 08 adds the profile-driven
pass: People search (``search_profiles``) plus the profile extraction that
feeds it.

Seam: every read is driven through a ``transport`` callable with the same
signature as ``XClient.execute`` (``(url, body, session) -> payload``), so the
relay command layer and tests inject the same shape.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path
from typing import Callable, TypeVar

import xclient

T = TypeVar("T")

# Operation names this read layer needs queryIds for.
SEARCH_TIMELINE = "SearchTimeline"
USER_TWEETS = "UserTweets"
USER_BY_SCREEN_NAME = "UserByScreenName"

FALLBACK_QUERY_IDS: dict[str, str] = {
    USER_BY_SCREEN_NAME: xclient.USER_BY_SCREEN_NAME_QUERY_PLACEHOLDER,
    SEARCH_TIMELINE: "SearchTimelineFb",  # placeholder; superseded by client.json / fetched tier
    USER_TWEETS: "UserTweetsFb",
}


def _load_vendored_client_json() -> dict[str, str]:
    """Tier 1: the ``client.json`` snapshot shipped beside this module."""
    try:
        raw = json.loads(Path(__file__).with_name("client.json").read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}
    return {k: v for k, v in raw.items() if isinstance(v, str)}


class QueryIdNotFoundError(Exception):
    """No queryId for an operation in any of the three tiers."""


class QueryIdResolver:
    """Three-tier queryId resolution: client.json -> fallback constants -> fetched.

    Tier order follows the twitter-cli reference: a vendored ``client.json`` is
    the most stable source; fallback constants keep reads working offline with
    placeholder ids; the fetched tier refreshes from an injected loader.
    ``fetch`` (a ``() -> Mapping[str, str]`` callable; the seam tests stub)
    is called once and cached, and never overrides the vendored tier.

    Refresh path: drop a fresh X ``client.json`` in ``relay/client.json`` (tier
    1) or point ``fetch`` at a loader that returns a real queryId map (tier 3);
    run ``relay.py`` reads again to pick it up.
    """

    def __init__(
        self,
        *,
        client_json: dict[str, str] | None = None,
        fallback: dict[str, str] | None = None,
        fetch: Callable[[], dict[str, str]] | None = None,
    ):
        if client_json is None:
            client_json = _load_vendored_client_json()
        self._client_json = dict(client_json or {})
        self._fallback = dict(fallback if fallback is not None else FALLBACK_QUERY_IDS)
        self._fetch = fetch
        self._fetched: dict[str, str] | None = None

    def resolve(self, operation: str) -> str:
        if operation in self._client_json:
            return self._client_json[operation]
        if operation in self._fallback:
            return self._fallback[operation]
        if self._fetched is None and self._fetch is not None:
            self._fetched = self._fetch()
        if self._fetched and operation in self._fetched:
            return self._fetched[operation]
        raise QueryIdNotFoundError(f"no queryId resolved for {operation!r}")


@dataclass(frozen=True)
class SearchCriteria:
    """Structured search criteria compiled to an X ``q`` operator string.

    ``keywords`` are plain terms plus any operators the user typed directly
    (hashtags/mentions are accepted verbatim there); ``hashtags`` and
    ``mentions`` append ``#``/``from:`` operators.
    """

    keywords: list[str]
    hashtags: list[str] | None = None
    mentions: list[str] | None = None
    min_faves: int | None = None
    min_retweets: int | None = None
    min_replies: int | None = None
    lang: str | None = None
    since: str | None = None  # YYYY-MM-DD
    until: str | None = None  # YYYY-MM-DD

    def to_x_query(self) -> str:
        parts = [*self.keywords]
        if self.hashtags:
            parts.extend(f"#{h}" for h in self.hashtags)
        if self.mentions:
            parts.extend(f"from:{m}" for m in self.mentions)
        if self.min_faves:
            parts.append(f"min_faves:{self.min_faves}")
        if self.min_retweets:
            parts.append(f"min_retweets:{self.min_retweets}")
        if self.min_replies:
            parts.append(f"min_replies:{self.min_replies}")
        if self.lang:
            parts.append(f"lang:{self.lang}")
        if self.since:
            parts.append(f"since:{self.since}")
        if self.until:
            parts.append(f"until:{self.until}")
        return " ".join(parts)


@dataclass(frozen=True)
class ProfileCriteria:
    """Structured People-search criteria: keywords matched against names/bios
    plus the credibility filters a targeting profile's ``profile`` block
    expresses (follower count, verified flag, location)."""

    keywords: list[str]
    min_followers: int | None = None
    verified_only: bool = False
    location: str | None = None


@dataclass(frozen=True)
class Tweet:
    """A tweet as the funnel reads it."""

    id: str
    author: str
    text: str
    created_at: str
    favorite_count: int
    retweet_count: int
    reply_count: int
    lang: str
    in_reply_to_tweet_id: str | None = None
    in_reply_to_screen_name: str | None = None

    def as_mapping(self) -> dict:
        return {
            "id": self.id,
            "author": self.author,
            "text": self.text,
            "created_at": self.created_at,
            "favorite_count": self.favorite_count,
            "retweet_count": self.retweet_count,
            "reply_count": self.reply_count,
            "lang": self.lang,
            "in_reply_to_tweet_id": self.in_reply_to_tweet_id,
            "in_reply_to_screen_name": self.in_reply_to_screen_name,
        }


@dataclass(frozen=True)
class UserProfile:
    """An X account as the funnel reads it."""

    rest_id: str
    screen_name: str
    name: str
    bio: str
    followers_count: int
    following_count: int
    verified: bool
    location: str | None

    def as_mapping(self) -> dict:
        return {
            "rest_id": self.rest_id,
            "screen_name": self.screen_name,
            "name": self.name,
            "bio": self.bio,
            "followers_count": self.followers_count,
            "following_count": self.following_count,
            "verified": self.verified,
            "location": self.location,
        }


def _entry_shape(result: dict) -> dict:
    """The tweet payload, unwrapping visibility-wrapper shapes when present."""
    nested = result.get("tweet")
    if isinstance(nested, dict):
        wrapped = nested.get("result")
        if isinstance(wrapped, dict):
            return wrapped
    return result or {}


def _timeline(payload: dict) -> dict:
    """Locate the timeline object across the shapes X returns (search vs user).

    Search results nest under ``data.search_by_raw_query.search_timeline``;
    a user's own posts under ``data.user.result.timeline_v2``.
    """
    data = payload.get("data") or {}
    if isinstance(data.get("timeline"), dict):
        return data["timeline"]
    search_tl = (data.get("search_by_raw_query") or {}).get("search_timeline") or {}
    if isinstance(search_tl.get("timeline"), dict):
        return search_tl["timeline"]
    user_v2 = (data.get("user") or {}).get("result") or {}
    inner = user_v2.get("timeline_v2") or {}
    if isinstance(inner.get("timeline"), dict):
        return inner["timeline"]
    return {}


def _walk_entries(payload: dict, result_key: str) -> list[dict]:
    """Walk timeline entries, returning each entry's ``result`` object under
    the given ``itemContent`` key (``tweet_results`` for tweets, ``user_results``
    for People-search profiles)."""
    results: list[dict] = []
    instructions = _timeline(payload).get("instructions", [])
    for instruction in instructions:
        for entry in instruction.get("entries", []):
            content = entry.get("content") or {}
            item = content.get("itemContent") or content.get("entryContent") or {}
            result = (item.get(result_key) or {}).get("result")
            if not result:
                continue
            results.append(result)
    return results


def extract_tweets(payload: dict) -> list[Tweet]:
    """Read Tweet results out of a search/timeline payload."""
    return [_tweet_body(result) for result in _walk_entries(payload, "tweet_results")]


def _tweet_body(result: dict) -> Tweet:
    body = _entry_shape(result)
    legacy = body.get("legacy") or {}
    user = ((body.get("core") or {}).get("user_results") or {}).get("data") or {}
    return Tweet(
        id=str(body.get("rest_id") or legacy.get("id_str", "")),
        author=(user.get("legacy") or {}).get("screen_name") or "",
        text=legacy.get("full_text", ""),
        created_at=legacy.get("created_at", ""),
        favorite_count=int(legacy.get("favorite_count", 0)),
        retweet_count=int(legacy.get("retweet_count", 0)),
        reply_count=int(legacy.get("reply_count", 0)),
        lang=legacy.get("lang", ""),
        in_reply_to_tweet_id=legacy.get("in_reply_to_status_id_str") or None,
        in_reply_to_screen_name=legacy.get("in_reply_to_screen_name") or None,
    )


def extract_next_cursor(payload: dict) -> str | None:
    """The next Bottom cursor token, or None when the timeline is terminal."""
    instructions = _timeline(payload).get("instructions", [])
    for instruction in instructions:
        for entry in instruction.get("entries", []):
            content = entry.get("content") or {}
            if content.get("entryType") != "TimelineTimelineCursor":
                continue
            value = content.get("value") or {}
            if isinstance(value, dict) and value.get("cursorType") == "Bottom":
                return value.get("value")
            if isinstance(value, str):
                return value
    return None


def _walk_pages(
    transport,
    session,
    *,
    query_id: str,
    operation: str,
    host: str,
    max_pages: int,
    make_variables: Callable[[str | None], dict],
    extractor: Callable[[dict], list[T]],
) -> list[T]:
    """Walk a cursor-paginated timeline, collecting entries across pages."""
    items: list[T] = []
    cursor: str | None = None
    for _ in range(max_pages):
        url = xclient.graphql_url(host, query_id, operation)
        body = {
            "variables": make_variables(cursor),
            "features": {},
            "queryId": query_id,
            "url": url,
        }
        payload = transport(url, body, session)
        items.extend(extractor(payload))
        next_cursor = extract_next_cursor(payload)
        if next_cursor is None:
            break
        cursor = next_cursor
    return items


def search_tweets(
    transport: Callable[[str, dict, xclient.XSession], dict],
    session: xclient.XSession,
    *,
    criteria: SearchCriteria,
    resolver: QueryIdResolver,
    host: str = "https://x.com",
    max_pages: int = 10,
) -> list[Tweet]:
    """Walk SearchTimeline across pages until a terminal page or the cap."""
    query_id = resolver.resolve(SEARCH_TIMELINE)
    return _walk_pages(
        transport,
        session,
        query_id=query_id,
        operation=SEARCH_TIMELINE,
        host=host,
        max_pages=max_pages,
        extractor=extract_tweets,
        make_variables=lambda cursor: {
            "rawQuery": criteria.to_x_query(),
            "count": 20,
            "cursor": cursor,
            "product": "Top",
        },
    )


def _user_profile(user: dict) -> UserProfile:
    """Map the shared account shape (``xclient.user_from_result``) to the
    funnel's profile domain type."""
    return UserProfile(
        rest_id=str(user.get("rest_id") or ""),
        screen_name=user.get("screen_name") or "",
        name=user.get("name") or "",
        bio=user.get("description") or "",
        followers_count=int(user.get("followers_count") or 0),
        following_count=int(user.get("following_count") or 0),
        verified=bool(user.get("verified") or False),
        location=user.get("location") or None,
    )


def profile_lookup(
    transport,
    session: xclient.XSession,
    screen_name: str,
    *,
    resolver: QueryIdResolver,
    host: str = "https://x.com",
) -> UserProfile:
    query_id = resolver.resolve(USER_BY_SCREEN_NAME)
    url = xclient.graphql_url(host, query_id, USER_BY_SCREEN_NAME)
    body = {
        "variables": {"screen_name": screen_name, "withSafetyModeUserFields": False},
        "features": {},
        "queryId": query_id,
        "url": url,
    }
    payload = transport(url, body, session)
    result = (payload.get("data") or {}).get("result") or {}
    return _user_profile(xclient.user_from_result(result))


def extract_profiles(payload: dict) -> list[UserProfile]:
    """Read user results out of a People-search timeline (SearchTimeline with
    product=People), where each entry carries ``itemContent.user_results``."""
    return [
        _user_profile(xclient.user_from_result(result))
        for result in _walk_entries(payload, "user_results")
    ]


def _matches_profile_criteria(profile: UserProfile, criteria: ProfileCriteria) -> bool:
    if criteria.min_followers is not None and profile.followers_count < criteria.min_followers:
        return False
    if criteria.verified_only and not profile.verified:
        return False
    if criteria.location:
        if not profile.location or criteria.location.casefold() not in profile.location.casefold():
            return False
    return True


def search_profiles(
    transport,
    session,
    *,
    criteria: ProfileCriteria,
    resolver: QueryIdResolver,
    host: str = "https://x.com",
    max_pages: int = 3,
    max_profiles: int = 50,
) -> list[UserProfile]:
    """The profile-driven pass: People search by keyword, filtered to the
    targeting profile's credibility criteria, capped at ``max_profiles``."""
    found = _walk_pages(
        transport,
        session,
        query_id=resolver.resolve(SEARCH_TIMELINE),
        operation=SEARCH_TIMELINE,
        host=host,
        max_pages=max_pages,
        make_variables=lambda cursor: {
            "rawQuery": " ".join(criteria.keywords),
            "count": 20,
            "cursor": cursor,
            "product": "People",
        },
        extractor=extract_profiles,
    )
    return [p for p in found if _matches_profile_criteria(p, criteria)][:max_profiles]


def user_posts(
    transport,
    session,
    screen_name,
    *,
    resolver,
    host="https://x.com",
    max_pages=1,
) -> list[Tweet]:
    """The account's own recent posts. Resolves the profile for its rest_id,
    then walks UserTweets pages."""
    profile = profile_lookup(transport, session, screen_name, resolver=resolver, host=host)
    query_id = resolver.resolve(USER_TWEETS)
    return _walk_pages(
        transport,
        session,
        query_id=query_id,
        operation=USER_TWEETS,
        host=host,
        max_pages=max_pages,
        extractor=extract_tweets,
        make_variables=lambda cursor: {
            "userId": profile.rest_id,
            "count": 20,
            "cursor": cursor,
            "includePromotedContent": True,
        },
    )


class XReader:
    """The production read seam the command channel calls: wraps a transport so
    ``search``/``user_posts``/``profile``/``inbound_scan`` share one resolution
    + session."""

    def __init__(
        self,
        transport,
        session: xclient.XSession,
        *,
        host: str = "https://x.com",
        resolver: QueryIdResolver | None = None,
        screen_name: str | None = None,
    ):
        self._transport = transport
        self._session = session
        self.host = host
        self._resolver = resolver or QueryIdResolver()
        self._screen_name = screen_name or session.screen_name

    @classmethod
    def from_client(
        cls,
        session: xclient.XSession,
        *,
        host: str = "https://x.com",
        screen_name: str | None = None,
    ) -> "XReader":
        return cls(xclient.XClient().execute, session, host=host, screen_name=screen_name)

    def search(self, criteria: SearchCriteria, *, max_pages: int = 10) -> list[Tweet]:
        return search_tweets(
            self._transport,
            self._session,
            criteria=criteria,
            resolver=self._resolver,
            host=self.host,
            max_pages=max_pages,
        )

    def user_posts(self, screen_name: str, *, max_pages: int = 1) -> list[Tweet]:
        return user_posts(
            self._transport,
            self._session,
            screen_name,
            resolver=self._resolver,
            host=self.host,
            max_pages=max_pages,
        )

    def profile(self, screen_name: str) -> UserProfile:
        return profile_lookup(
            self._transport,
            self._session,
            screen_name,
            resolver=self._resolver,
            host=self.host,
        )

    def search_profiles(
        self,
        criteria: ProfileCriteria,
        *,
        max_pages: int = 3,
        max_profiles: int = 50,
    ) -> list[UserProfile]:
        return search_profiles(
            self._transport,
            self._session,
            criteria=criteria,
            resolver=self._resolver,
            host=self.host,
            max_pages=max_pages,
            max_profiles=max_profiles,
        )

    def inbound_scan(self, *, max_pages: int = 1) -> list[Tweet]:
        """Find recent replies/mentions directed at the user. Searches for
        ``to:<screen_name>`` and returns tweets that have ``in_reply_to_tweet_id``
        set, so the Worker can trace them into conversations."""
        if not self._screen_name:
            raise ValueError("screen_name is required for inbound_scan")
        criteria = SearchCriteria(keywords=[f"to:{self._screen_name}"])
        tweets = search_tweets(
            self._transport,
            self._session,
            criteria=criteria,
            resolver=self._resolver,
            host=self.host,
            max_pages=max_pages,
        )
        return [t for t in tweets if t.in_reply_to_tweet_id is not None]