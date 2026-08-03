"""X GraphQL write layer (ticket 07).

The write side of the transport in ``xclient``: drives the CreateTweet
operation for the three action types the funnel and conversations produce —
plain posts, replies in-reply-to a target tweet, and quotes attaching a
quoted tweet via ``attachment_url``. Each write returns the created tweet id.

Pacing and the retry/backoff taxonomy live in the transport
(``XClient.execute``), so a write rides the same jitter and backoff as any
other request. This layer owns the operation body and the
created-tweet-id extraction, and surfaces GraphQL errors as ``XError``.

Seam: the same one as the read layer — every write is driven through a
``transport`` callable with the same signature as ``XClient.execute``
(``(url, body, session) -> payload``), so the relay command layer and tests
inject the same shape.
"""

from __future__ import annotations

from typing import Callable

import xclient
import xreader

# Operation name the write layer resolves a queryId for. The queryId itself
# comes from the same three-tier resolver as reads (vendored client.json,
# fallback constants in xreader, or a fetched loader); offline writes resolve
# from the vendored ``relay/client.json`` entry.
CREATE_TWEET = "CreateTweet"


def _create_tweet_body(
    text: str,
    *,
    in_reply_to_tweet_id: str | None = None,
    attachment_url: str | None = None,
) -> dict:
    """The CreateTweet variables for a plain post, reply, or quote.

    X rejects replies without ``exclude_reply_user_ids``; quotes attach the
    quoted tweet via ``attachment_url``.
    """
    return {
        "tweet_text": text,
        "reply": {"exclude_reply_user_ids": [], "in_reply_to_tweet_id": in_reply_to_tweet_id}
        if in_reply_to_tweet_id
        else None,
        "attachment_url": attachment_url,
        "dark_request": False,
    }


def _created_tweet_id(payload: dict) -> str:
    """The created tweet id out of a CreateTweet payload, or an XError when
    the write did not produce one (e.g. a duplicate-status GraphQL error)."""
    result = ((payload.get("data") or {}).get("create_tweet") or {}).get("tweet_results") or {}
    result = result.get("result") or {}
    tweet_id = result.get("rest_id") or result.get("id_str")
    if tweet_id is None:
        detail = "; ".join(str(e) for e in payload.get("errors", [])) if payload.get("errors") else "no result"
        raise xclient.XError(f"CreateTweet returned no tweet id ({detail})")
    return str(tweet_id)


def _create_tweet(
    transport: Callable[[str, dict, xclient.XSession], dict],
    session: xclient.XSession,
    text: str,
    *,
    resolver: xreader.QueryIdResolver,
    host: str = "https://x.com",
    in_reply_to_tweet_id: str | None = None,
    attachment_url: str | None = None,
) -> str:
    """Drive one CreateTweet through the transport and return the created id."""
    query_id = resolver.resolve(CREATE_TWEET)
    url = xclient.graphql_url(host, query_id, CREATE_TWEET)
    body = {
        "variables": _create_tweet_body(
            text, in_reply_to_tweet_id=in_reply_to_tweet_id, attachment_url=attachment_url
        ),
        "features": {},
        "queryId": query_id,
        "url": url,
    }
    payload = transport(url, body, session)
    return _created_tweet_id(payload)


def post_tweet(
    transport: Callable[[str, dict, xclient.XSession], dict],
    session: xclient.XSession,
    text: str,
    *,
    resolver,
    host: str = "https://x.com",
) -> str:
    """Post a plain tweet; returns the created tweet id."""
    return _create_tweet(transport, session, text, resolver=resolver, host=host)


def reply_tweet(
    transport: Callable[[str, dict, xclient.XSession], dict],
    session: xclient.XSession,
    text: str,
    in_reply_to_tweet_id: str,
    *,
    resolver,
    host: str = "https://x.com",
) -> str:
    """Post a reply in-reply-to ``in_reply_to_tweet_id``; returns the created tweet id."""
    return _create_tweet(
        transport,
        session,
        text,
        resolver=resolver,
        host=host,
        in_reply_to_tweet_id=in_reply_to_tweet_id,
    )


def quote_tweet(
    transport: Callable[[str, dict, xclient.XSession], dict],
    session: xclient.XSession,
    text: str,
    attachment_url: str,
    *,
    resolver,
    host: str = "https://x.com",
) -> str:
    """Post a quote with the quoted tweet attached via ``attachment_url``."""
    return _create_tweet(
        transport,
        session,
        text,
        resolver=resolver,
        host=host,
        attachment_url=attachment_url,
    )


class XWriter:
    """The production write seam the command channel calls: wraps a transport
    so ``post``/``reply``/``quote`` share one resolution + session."""

    def __init__(
        self,
        transport,
        session: xclient.XSession,
        *,
        host: str = "https://x.com",
        resolver: xreader.QueryIdResolver | None = None,
    ):
        self._transport = transport
        self._session = session
        self.host = host
        self._resolver = resolver or xreader.QueryIdResolver()

    @classmethod
    def from_client(
        cls,
        session: xclient.XSession,
        *,
        host: str = "https://x.com",
        pacer: xclient.Pacer | None = None,
    ) -> "XWriter":
        return cls(xclient.XClient(pacer=pacer).execute, session, host=host)

    def post(self, text: str) -> str:
        return post_tweet(self._transport, self._session, text, resolver=self._resolver, host=self.host)

    def reply(self, text: str, *, in_reply_to_tweet_id: str) -> str:
        return reply_tweet(
            self._transport,
            self._session,
            text,
            in_reply_to_tweet_id,
            resolver=self._resolver,
            host=self.host,
        )

    def quote(self, text: str, *, attachment_url: str) -> str:
        return quote_tweet(
            self._transport,
            self._session,
            text,
            attachment_url,
            resolver=self._resolver,
            host=self.host,
        )
