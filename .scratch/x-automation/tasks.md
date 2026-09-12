# x-automation task list

Companion to `spec.md` (user stories US01-US45) and `issues/` (build tickets 01-15).
Each item links its GitHub issue. Check an item off only when its acceptance
criterion is met and the issue is closed.

## Security

- [ ] T01 Production auth — set ACCESS_TEAM/AUD, remove AUTH_DEV (#2)
- [ ] T02 Rotate X session exposed in chat (#4)
- [ ] T03 Backup/restore story for relay state and cookie files (#6)

## Spec gaps

- [ ] T04 US12 semantic candidate discovery (#5, issues/08)
- [ ] T05 US22 user voice/style for drafts (#3)
- [ ] T06 US29/30 time-of-day schedules + dashboard UI (#1, ticket 13)
- [ ] T07 US43 pace the X read path (#9)
- [ ] T08 Quiet hours pause open conversations (#10)
- [ ] T09 Cron slot 3 budget resets: deploy or record drop decision (#8)

## Code health (refactor only as touched; suite must stay green)

- [ ] T10 Shared LLM-call pipeline in ai.ts (#12)
- [ ] T11 Provider credentials type (#7)
- [ ] T12 Conversation defaults single source (#11)
- [ ] T13 Auth middleware + SQL helper reuse (#13)

## Verification

- [ ] T14 Finish live QA of remaining dashboard sections (#16)
- [ ] T15 Live end-to-end proof tick-to-tweet, both directions (#17)
- [ ] T16 Exercise POST /api/results live (#18)

## Ops

- [ ] T17 Relay run loop survives reboots (#14)
- [ ] T18 Faster suite or CI per commit (#15)
- [x] T19 Ticket-15 reconcile ordering — fixed, regression test drives maintenance (#20)
- [ ] T20 US40 magic-link auth path beyond 50 users (#19)
- [ ] T21 Real X queryIds for reads/writes — all four captured live; needs relay restart + live proof (#21)

## GitHub mirror (all open, 2026-09-12)

- #1 US29/30 schedules — https://github.com/oraekene/x-automation/issues/1
- #2 Production auth — https://github.com/oraekene/x-automation/issues/2
- #3 US22 voice/style — https://github.com/oraekene/x-automation/issues/3
- #4 Rotate X session — https://github.com/oraekene/x-automation/issues/4
- #5 US12 semantic discovery — https://github.com/oraekene/x-automation/issues/5
- #6 Backup/restore relay files — https://github.com/oraekene/x-automation/issues/6
- #7 Provider credentials type — https://github.com/oraekene/x-automation/issues/7
- #8 Cron slot 3 — https://github.com/oraekene/x-automation/issues/8
- #9 US43 read pacing — https://github.com/oraekene/x-automation/issues/9
- #10 Quiet hours open conversations — https://github.com/oraekene/x-automation/issues/10
- #11 Conversation defaults — https://github.com/oraekene/x-automation/issues/11
- #12 LLM pipeline refactor — https://github.com/oraekene/x-automation/issues/12
- #13 Auth middleware — https://github.com/oraekene/x-automation/issues/13
- #14 Relay reboot survival — https://github.com/oraekene/x-automation/issues/14
- #15 Slow suite / CI — https://github.com/oraekene/x-automation/issues/15
- #16 Finish live QA — https://github.com/oraekene/x-automation/issues/16
- #17 Live end-to-end proof — https://github.com/oraekene/x-automation/issues/17
- #18 POST /api/results live — https://github.com/oraekene/x-automation/issues/18
- #19 US40 magic-link auth — https://github.com/oraekene/x-automation/issues/19
- #20 Ticket-15 reconcile ordering (fixed) — https://github.com/oraekene/x-automation/issues/20
- #21 Real queryIds for reads — https://github.com/oraekene/x-automation/issues/21
