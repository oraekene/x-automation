// Ticket 10+11: the drafts surface. GET lists the inbox (verdict, text, status);
// POST approve/reject decide a draft from the inbox. Approving executes the
// draft immediately through the relay write path (reply/quote) — the only
// execution path in manual mode — honouring the two hard safety checks (kill
// switch, dedupe). Rejection is terminal: the draft is marked rejected, no
// command is enqueued, no dedupe row is written, and the targeting pass never
// re-judges it (its ai decision stays 'draft').

import { Hono } from "hono";
import type { DraftRow, DraftStatus, Env, RelayRow } from "../types";
import { getUser } from "../auth";
import { MAX_DRAFT_LENGTH } from "../lib/ai";
import { enqueueDraftStatements, executionBlockReason } from "../lib/execution";
import { nowSeconds } from "../lib/crypto";

export const draftRoutes = new Hono<{ Bindings: Env }>();

const DECIDABLE = new Set<DraftStatus>(["ready", "content_failed"]);

draftRoutes.get("/", async (c) => {
  const user = await getUser(c);
  if (!user) return c.json({ error: "unauthorized" }, 401);
  const rows = (await c.env.DB.prepare(
    `SELECT d.id, d.automation_id, d.candidate_id, d.action, d.reason, d.priority, d.provider, d.model,
            d.status, d.text, d.command_id, d.result_tweet_id, d.executed_at, d.decided_at, d.created_at,
            c.author, c.text AS candidate_text, c.tweet_id, a.name AS automation_name
     FROM drafts d
     JOIN candidates c ON c.id = d.candidate_id
     JOIN automations a ON a.id = d.automation_id
     WHERE d.user_id = ?
     ORDER BY d.created_at DESC, d.id DESC
     LIMIT 200`,
  )
    .bind(user.id)
    .all()) as unknown as {
    results: Array<{
      id: number;
      automation_id: string;
      candidate_id: string;
      action: string;
      reason: string;
      priority: number;
      provider: string;
      model: string;
      status: string;
      text: string;
      command_id: string | null;
      result_tweet_id: string | null;
      executed_at: number | null;
      decided_at: number | null;
      created_at: number;
      author: string;
      candidate_text: string;
      tweet_id: string;
      automation_name: string;
    }>;
  };

  return c.json({
    drafts: rows.results.map((d) => ({
      id: d.id,
      automation_id: d.automation_id,
      automation_name: d.automation_name,
      candidate_id: d.candidate_id,
      tweet_id: d.tweet_id,
      author: d.author,
      candidate_text: d.candidate_text,
      action: d.action,
      reason: d.reason,
      priority: d.priority,
      provider: d.provider,
      model: d.model,
      status: d.status,
      text: d.text,
      command_id: d.command_id,
      result_tweet_id: d.result_tweet_id,
      executed_at: d.executed_at,
      decided_at: d.decided_at,
      created_at: d.created_at,
    })),
  });
});

// POST /api/drafts/:id/approve {text?} — execute the draft now. An optional
// text overrides the AI content (the review step of the inbox). Returns 404
// for another user's draft and 409 when it is not decidable (already
// executing/done/rejected/failed) or blocked by the hard safety checks.
draftRoutes.post("/:id/approve", async (c) => {
  const user = await getUser(c);
  if (!user) return c.json({ error: "unauthorized" }, 401);
  const draft = (await c.env.DB.prepare("SELECT * FROM drafts WHERE id = ? AND user_id = ?")
    .bind(c.req.param("id"), user.id)
    .first()) as DraftRow | undefined;
  if (!draft) return c.json({ error: "not found" }, 404);
  if (!DECIDABLE.has(draft.status)) return c.json({ error: "draft is not decidable" }, 409);

  const body = (await c.req.json().catch(() => ({}))) as { text?: string };
  const text = body.text?.trim() || draft.text.trim();
  if (!text) return c.json({ error: "draft has no text — provide one" }, 400);
  if (text.length > MAX_DRAFT_LENGTH) return c.json({ error: "text exceeds 280 characters" }, 400);

  const relay = (await c.env.DB.prepare("SELECT * FROM relays WHERE id = ? AND user_id = ?")
    .bind(draft.relay_id, user.id)
    .first()) as RelayRow | undefined;
  if (!relay) return c.json({ error: "relay not found" }, 404);
  const candidate = (await c.env.DB.prepare("SELECT tweet_id, author FROM candidates WHERE id = ? AND user_id = ?")
    .bind(draft.candidate_id, user.id)
    .first()) as { tweet_id: string; author: string } | undefined;
  if (!candidate) return c.json({ error: "candidate not found" }, 404);

  const blockReason = await executionBlockReason(c.env, relay, candidate.tweet_id);
  if (blockReason) return c.json({ error: blockReason }, 409);

  const nowSec = nowSeconds();
  const commandId = crypto.randomUUID();

  // Claim the tweet in dedupe first, atomically: two concurrent approves race
  // here and only the first wins (INSERT OR IGNORE reports 0 changes for the
  // loser), so a tweet can never be double-engaged.
  const claim = await c.env.DB.prepare("INSERT OR IGNORE INTO dedup (user_id, relay_id, tweet_id, action, acted_at) VALUES (?, ?, ?, ?, ?)")
    .bind(user.id, draft.relay_id, candidate.tweet_id, draft.action === "reply" ? "reply" : "quote", nowSec)
    .run();
  if ((claim.meta?.changes ?? 0) === 0) return c.json({ error: "tweet already engaged elsewhere" }, 409);

  await c.env.DB.batch(enqueueDraftStatements(c.env, draft, candidate, text, commandId, nowSec, true));

  return c.json({ draft_id: draft.id, status: "executing", command_id: commandId });
});

// POST /api/drafts/:id/reject — mark the draft rejected. No command, no dedupe
// row, no retry: rejection is terminal and the targeting pass's idempotency
// keeps the candidate out of future judgment.
draftRoutes.post("/:id/reject", async (c) => {
  const user = await getUser(c);
  if (!user) return c.json({ error: "unauthorized" }, 401);
  const draft = (await c.env.DB.prepare("SELECT id, status FROM drafts WHERE id = ? AND user_id = ?")
    .bind(c.req.param("id"), user.id)
    .first()) as { id: number; status: DraftStatus } | undefined;
  if (!draft) return c.json({ error: "not found" }, 404);
  if (!DECIDABLE.has(draft.status)) return c.json({ error: "draft is not decidable" }, 409);

  await c.env.DB.prepare("UPDATE drafts SET status = 'rejected', decided_at = ? WHERE id = ? AND user_id = ?")
    .bind(nowSeconds(), draft.id, user.id)
    .run();
  return c.json({ draft_id: draft.id, status: "rejected" });
});