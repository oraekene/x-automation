# 08 — Funnel Stage 1: Universe

**What to build:** Automation creation (search criteria + targeting profile via API and dashboard), and the Universe stage that builds the candidate pool: deterministic search passes (operators, engagement thresholds, time windows) and profile-driven passes (search target profiles → pull their recent tweets), run by the tick through relay commands. Semantic (embedding/AI-assisted) discovery lands in a later ticket. Candidates stored in D1 and visible in the dashboard.

**Blocked by:** 04 + 06

**Status:** ready-for-agent

- [ ] Create an automation with search criteria and a targeting profile via API and dashboard
- [ ] Tick runs due automations, issuing search and profile passes through the relay
- [ ] Deterministic passes return candidates with engagement metadata, deduped into a candidate pool in D1
- [ ] Profile-driven pass: target profiles matched by bio/followers/verified/location feed their recent tweets into the pool
- [ ] Candidate pool visible in the dashboard with per-candidate metadata
