# AI layer is provider-agnostic and user-keyed

All AI calls (targeting decisions, reply/quote drafts, semantic conversation termination) go to an OpenAI-compatible endpoint configured per user as a base URL + API key + model triple, stored with the user's own credentials. The UI prefills a menu of free endpoints — NVIDIA NIM (build.nvidia.com), OpenCode Zen (opencode.ai/zen/v1), Groq, Gemini AI Studio, OpenRouter free models, Cerebras, Mistral, GitHub Models, and Cloudflare Workers AI — but any OpenAI-compatible endpoint works, including the user's own. No provider lock-in, no shared-key liability, no cost to the operator. Drafts are written to D1 before execution so every action can be reviewed in the inbox before posting. A user-configured webhook (POST /api/content) is an equivalent content source for external agents such as the Hermes job-hunting plugin.

Status: accepted
