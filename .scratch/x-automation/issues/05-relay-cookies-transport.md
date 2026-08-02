# 05 — Relay X client: cookies + transport

**What to build:** The relay's X transport foundation, before any X-specific GraphQL: encrypted-at-rest cookie store (auth_token + ct0), Chrome TLS impersonation (curl_cffi-style), the HTTP client layer, the error taxonomy with retry/backoff, and pacing/jitter utilities. Proves cookies authenticate against X without executing any product behavior.

**Blocked by:** 02

**Status:** ready-for-agent

- [ ] Cookies stored encrypted at rest in a relay-local store, survive restart
- [ ] TLS impersonation and request shaping (UA, sec-ch-ua, x-client-transaction-id) applied to all requests
- [ ] Error taxonomy classifies X failures (auth, rate limit, not-found, transient) and backoff/retry applies to transient ones
- [ ] Pacing/jitter utilities apply human-like delays between requests
- [ ] An authenticated read call (e.g. whoami/verify credentials) succeeds with a valid session and fails cleanly with an expired one
