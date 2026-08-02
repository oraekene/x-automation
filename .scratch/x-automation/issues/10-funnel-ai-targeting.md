# 10 — Funnel Stage 3: AI targeting + provider config

**What to build:** The user-keyed AI layer: provider configuration (base URL + API key + model, with the prefilled free-endpoint menu: NVIDIA NIM, OpenCode Zen, Groq, Gemini, OpenRouter, Cerebras, Mistral, GitHub Models, Cloudflare Workers AI), and the AI targeting verdict on each candidate: action (reply | quote | skip), reason, priority — against the targeting profile. Drafts (with verdict) written to D1 and listed in the dashboard.

**Blocked by:** 09

**Status:** ready-for-agent

- [ ] User configures provider triple in dashboard; menu prefills known free endpoints
- [ ] AI targets each surviving candidate against the targeting profile and outputs action/reason/priority
- [ ] Drafts persisted to D1 with verdict, provider, and model used
- [ ] Dashboard lists drafts with action, reason, priority
- [ ] Provider failure handled: no draft produced, error surfaced, retried on next tick
