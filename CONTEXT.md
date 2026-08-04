# Project Context

This project builds and maintains a local, queryable **knowledge corpus** of the Hermes-Agent ecosystem (source repository + documentation website), and establishes Hermes-Agent as the **base template framework** for all future software projects.

## Language

**Corpus**:
The local, queryable full snapshot of the Hermes-Agent repository and its documentation website, used for offline search, reading, and cross-referencing (e.g., "how does the gateway work?" answered by consulting source and docs together).
_Avoid_: crawl output, dump, mirror

**Crawl**:
The process of fetching and persisting the Hermes-Agent repository and its documentation website into the corpus.
_Avoid_: scrape, harvest

**Repo**:
The Hermes-Agent source repository on GitHub: `NousResearch/hermes-agent`. MIT-licensed, Python + TypeScript, actively released.
_Avoid_: GitHub repo, the source

**Docs site**:
The official documentation website at `hermes-agent.nousresearch.com/docs`. A Docusaurus site whose content source lives inside the repo at `website/docs/`; also serves machine-readable `llms.txt` (~17 KB index) and `llms-full.txt` (~1.8 MB full text).
_Avoid_: website, the site, docs page

**Base template framework**:
The role the Repo plays as the foundation for all future software projects. Two modes, chosen per project:
- **Profile distribution**: a small git repo packaging an agent's personality, skills, cron jobs, config, and plugins, installed on top of a hermes-agent base. Stays current with upstream.
- **Snapshot project**: a project built inside a one-time copy of the Repo pinned at a single version; the copy is never synced with upstream, so the project diverges permanently from that point.
_Avoid_: template, boilerplate, fork (a git fork implies upstream tracking; a Snapshot project never syncs)

**Corpus snapshot**:
The Repo working tree and Docs content captured at one pinned version, as stored in the Corpus. Pinned to a Release tag at crawl time.
_Avoid_: the snapshot, dump version

**Release tag**:
A date-stamped git tag on the Repo (e.g., `v2026.7.30`, the v0.19.1 release) that identifies the pinned version of a Corpus snapshot or a Snapshot project. Version-style names like "v0.19.1" are release titles, not tags.
_Avoid_: version, release number

**Docs content**:
The documentation pages taken from the pinned Repo tree (`website/docs/` plus any doc-generation scripts under `website/`), not from the live Docs site. Keeps code and docs version-consistent within a Corpus snapshot.
_Avoid_: live docs, deployed docs

**Manifest**:
The index that maps every path in the Corpus to a short description, derived from the Docs site's `llms.txt` structure. The Corpus is queried by reading files or ripgrep; the Manifest is the map.
_Avoid_: index file, TOC

# Project Context — X Automation Tool

This project builds a free, multi-user, multi-account X automation tool on the Cloudflare free tier. A Cloudflare Worker coordinates scheduling, decisioning, and state; a host-agnostic Relay process the user runs at home executes every X action with the user's own cookie session. See `.scratch/x-automation/spec.md` and `docs/adr/0003`–`0006`.

## Language

**Relay**:
The host-agnostic single-file process the user runs (laptop, NAS, Raspberry Pi, phone, or free VM) that owns X cookies and executes X actions from a residential IP. Polls the Worker for commands.
_Avoid_: client, agent, bot, worker

**Tick**:
The per-minute cron firing that reads due schedules from D1 and fans out automation jobs. One of the five free-tier cron slots; scheduling is jobs-as-data.
_Avoid_: scheduler daemon, cron job (per-automation crons don't exist)

**Funnel**:
The four-stage decision pipeline: Universe (search) → Heuristic filter → AI targeting → Guardrails. Outputs an action per candidate: reply | quote | skip, with reason and priority.
_Avoid_: pipeline (ambiguous), scoring, ranking

**Targeting profile**:
The user's stated audience and intent (persona, goals, style, exclusions) that the AI layer judges candidates against. Also submitted externally via `POST /api/targeting` (e.g., by a Hermes Agent plugin).
_Avoid_: criteria, prompt

**Draft**:
A generated reply/quote written to D1 before execution, reviewable in the inbox. Nothing posts without first being a Draft.
_Avoid_: message, post

**Queue-and-catch-up**:
The design where commands queue in D1 while the Relay is offline and execute on reconnect, so no work is lost and timing degrades gracefully.
_Avoid_: offline mode, sync

**Conversation**:
A multi-turn exchange started by inbound replies to the user's own tweets. Terminated by user-configurable deterministic caps plus semantic AI judgment (continue | close_with_message | close_silent, each close logged with reason).
_Avoid_: thread, chat

**Inbox**:
The review surface for Drafts and AI decisions; one of three execution modes (manual, auto, hybrid).
_Avoid_: queue, feed
