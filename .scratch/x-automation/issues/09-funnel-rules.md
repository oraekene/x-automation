# 09 — Funnel rules: heuristic filter + guardrails

**What to build:** The user-configurable deterministic rules engine covering Stage 2 (heuristic filter to ~50) and Stage 4 (guardrails): budgets (max posts/day, max replies/day), dedupe across automations/accounts, allowlist/blocklist, quiet hours, diversity, and per-account kill switches. All parameters have automated defaults plus user overrides. Demo: candidates filtered, budget exceeded → nothing acts.

**Blocked by:** 08

**Status:** ready-for-agent

- [ ] Rules engine applies configurable heuristic weights and thresholds, reducing the pool to the configured target size
- [ ] Budgets enforced per account/day with quiet hours; exceeded budget blocks actions
- [ ] Dedupe across automations and accounts prevents double-engagement
- [ ] Allowlist/blocklist and per-account kill switches enforced
- [ ] Every rule decision is recorded in the funnel audit trail
