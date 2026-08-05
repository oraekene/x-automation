# 15 — Reconcile drafts stuck executing

**What to build:** The draft-side counterpart to the stale-claim sweep. When a relay claims a write command but never reports a result (relay goes offline permanently, result lost), the draft stays `executing` forever and its dedupe row permanently blocks the tweet across all the user's automations. The hourly maintenance pass already sweeps stale command claims back to pending; add a reconcile that resolves drafts whose command is stale (never reported within the same window) to `failed` with a reason, freeing their dedupe rows.

**Blocked by:** 11

**Status: done**

- [x] Maintenance sweep finds drafts `executing` whose command was claimed but never reported within the stale window, marks them `failed` (reason recorded in the command result), and clears their dedupe rows
- [x] Drafts whose command is still pending or recently claimed are left alone
- [x] Tested end to end: claim a write, never report, run maintenance → draft `failed`, tweet deduped row gone, inbox shows the failure

## Notes (deferred from ticket 11 @ 2026-08-04)

- Ticket 11's code review noted: "a relay that never reports a claimed write leaves its draft `executing` (command stale-claim sweep exists in maintenance, but the draft side has no reconcile pass yet)". The existing sweep lives in `src/scheduled.ts maintenance()` (STALE_CLAIM_MS); this ticket adds the matching draft-side reconcile. Dedupe rows must only be cleared when the sweep actually resolved the draft (never for `done`/`failed` drafts).
