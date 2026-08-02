# 07 — Relay X client: writes

**What to build:** The write surface: CreateTweet for replies (in-reply-to), quotes via attachment_url, and plain posts, with jitter pacing. The three action types the funnel and conversations produce. Demo: the relay replies and quote-tweets for real from a product command.

**Blocked by:** 06

**Status:** ready-for-agent

- [ ] Reply command posts a reply in-reply-to a target tweet
- [ ] Quote command posts a quote with the quoted tweet attached (attachment_url)
- [ ] Post command posts a plain tweet
- [ ] Writes carry pacing/jitter and return the created tweet id to the command result
- [ ] Rate-limit and transient errors trigger the backoff taxonomy
