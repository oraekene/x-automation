# X access goes through a cookie/GraphQL relay, never the official API

The official X API free tier was discontinued (Feb 2026) and quote-posts were removed from all self-serve tiers (Apr 2026), so reply/quote/conversation automation against it costs real money per action and is technically blocked for quotes. The tool therefore talks to X through the user's own cookie session (auth_token + ct0) over the internal GraphQL API, executing from the user's residential IP via a relay process. twitter-cli (public-clis) is the reference implementation for this protocol, including its quote path (CreateTweet + attachment_url), queryId resolution, and error taxonomy. Cookie theft exposure is bounded: cookies never leave the relay machine except in encrypted form at rest; the Worker never sees or stores them.

Status: accepted
