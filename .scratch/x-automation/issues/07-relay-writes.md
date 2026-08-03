# 07 — Relay X client: writes

**What to build:** The write surface: CreateTweet for replies (in-reply-to), quotes via attachment_url, and plain posts, with jitter pacing. The three action types the funnel and conversations produce. Demo: the relay replies and quote-tweets for real from a product command.

**Blocked by:** 06

**Status:** done

- [x] Reply command posts a reply in-reply-to a target tweet
- [x] Quote command posts a quote with the quoted tweet attached (attachment_url)
- [x] Post command posts a plain tweet
- [x] Writes carry pacing/jitter and return the created tweet id to the command result
- [x] Rate-limit and transient errors trigger the backoff taxonomy

**Notes**

- Seams (confirmed with user): (1) `relay/xwriter.py` mirrors `xreader.py` — free functions (`post_tweet`/`reply_tweet`/`quote_tweet`) over the shared `_create_tweet` + `XWriter` facade, driven through the same injectable transport callable; (2) `execute_command` gained a `writer` param alongside `reader`; (3) the demo lives in new `relay post` / `relay reply` / `relay quote` CLI subcommands.
- Command payloads: `post` `{text}`, `reply` `{text, in_reply_to_tweet_id}`, `quote` `{text, attachment_url}`; results carry `{tweet_id}`. Missing fields and writer-missing fail cleanly as `ok:false`.
- CreateTweet variables: `tweet_text`, `reply` (`exclude_reply_user_ids: []` + `in_reply_to_tweet_id` — X rejects replies without the empty user list), `attachment_url` for quotes, `dark_request: false`. `features: {}` mirrors the read layer.
- Writes ride the transport's backoff taxonomy (HTTP 429/GraphQL rate-limit retry with jittered backoff, tested) and `make_writer` attaches a `Pacer` so each demo write is human-paced; created id extracted from `data.create_tweet.tweet_results.result.rest_id`; GraphQL errors (e.g. duplicate-status 327, permanent) surface as `XError`.
- Demo caveat: `relay post/reply/quote` need a real `CreateTweet` queryId — `relay/client.json` ships the `CreateTweetFb` placeholder (same pattern as SearchTimeline/UserTweets); drop a fresh `client.json` via the resolver refresh path to post for real.
- Code review (post-commit review at `78c5283`): fixed `exclude_reply_user_ids` reply shape, added write-pacing test, dropped the dead `FALLBACK_QUERY_IDS` constant, shared `_run_x_command` helper for the read/write dispatch blocks, honest `make_writer` docstring.
