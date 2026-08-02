# 01 — Scaffold + deploy

**What to build:** The repository layout that hosts both halves of the product — the Cloudflare Worker app and the host-agnostic Relay binary — with a deployed hello-world Worker and a provisioned D1 database. The Relay binary starts, connects to the Worker's base URL, and logs. Deployable via wrangler from a local checkout.

**Blocked by:** None — can start immediately.

**Status:** ready-for-agent

- [ ] Repo has a Worker app (wrangler config, D1 binding) and a Relay binary, each runnable independently
- [ ] Worker deploys via wrangler and responds on a health endpoint
- [ ] D1 database provisioned and reachable from the Worker
- [ ] Relay binary starts, polls a configurable base URL, and logs connectivity status
