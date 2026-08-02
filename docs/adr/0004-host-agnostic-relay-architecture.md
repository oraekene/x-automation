# Cloudflare coordinates, a host-agnostic relay executes

All state, scheduling, and decisioning lives in Cloudflare (Workers + D1 + KV on the free tier); all X-side actions (search, read, reply, quote, post) execute in a single-file relay process the user runs. The relay is deliberately host-agnostic — identical code on laptop, NAS, Raspberry Pi, phone, or an always-free VM (Oracle Cloud ARM, Google e2-micro) — because every cloud data-center egress IP (including Cloudflare Workers themselves) shares bot-pool reputation; residential/mobile IPs do not. The relay polls the Worker for queued commands; if it is offline, commands queue in D1 and execute on reconnect (queue-and-catch-up), so no work is lost and precise timing is only as strict as the user's host availability. Pairing codes bind a relay to a user account.

Status: accepted
