# 12 — Conversations (inbound multi-turn)

**What to build:** Inbound mode: monitor replies to the user's own tweets, open a Conversation, generate reply drafts through the funnel, and terminate per the user's rules — deterministic caps (max turns default 5 / cap 8, per-user budgets, inactivity timeout, quiet hours) plus semantic AI judgment (continue | close_with_message | close_silent with reason; goal completion, loop detection, signal decay). Every close logged with reason; all parameters user-configurable.

**Blocked by:** 11

**Status: done**

- [x] Inbound replies to the user's tweets are detected and open a Conversation
- [x] Each turn produces a reply draft through the funnel with conversation context
- [x] Deterministic termination caps enforced and configurable
- [x] Semantic termination verdict (continue | close_with_message | close_silent) applied with reason
- [x] Dashboard shows conversations, turn counts, and the logged reason for every close
