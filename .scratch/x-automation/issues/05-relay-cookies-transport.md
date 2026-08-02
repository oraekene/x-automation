# 05 — Relay X client: cookies + transport

**What to build:** The relay's X transport foundation, before any X-specific GraphQL: encrypted-at-rest cookie store (auth_token + ct0), Chrome TLS impersonation (curl_cffi-style), the HTTP client layer, the error taxonomy with retry/backoff, and pacing/jitter utilities. Proves cookies authenticate against X without executing any product behavior.

**Blocked by:** 02

**Status:** ready-for-agent

- [x] Cookies stored encrypted at rest in a relay-local store, survive restart
- [x] TLS impersonation and request shaping (UA, sec-ch-ua, x-client-transaction-id) applied to all requests
- [x] Error taxonomy classifies X failures (auth, rate limit, not-found, transient) and backoff/retry applies to transient ones
- [x] Pacing/jitter utilities apply human-like delays between requests
- [x] An authenticated read call (e.g. whoami/verify credentials) succeeds with a valid session and fails cleanly with an expired one

## Notes (ticket 05 done, @ 2026-08-02)

- TLS impersonation: `CurlCffiSession` (Chrome fingerprint) is the first choice
  when `curl_cffi` (now a dependency) is installed; `StdlibSession` keeps the
  relay runnable anywhere with identical header shaping.
- `whoami` proves the session can read from X and fails cleanly when expired;
  it is a credential probe, not an identity claim (it reads whatever
  screen_name is persisted). A strict "current viewer" query can land with the
  GraphQL reads ticket (06).
- Encryption at rest guards the store file alone (casual reads, stray copies);
  the sibling key file is 0600 on POSIX. A stronger boundary is out of scope
  for a single-session snapshot.
- `relay cookies set` prefers `X_AUTH_TOKEN`/`X_CT0` env vars so the session is
  not exposed on the process list; CLI flags still work for throwaway setups.
