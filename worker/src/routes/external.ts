// Ticket 14: external API routes. Token-authenticated endpoints for tools like
// the Hermes Agent job-hunting plugin. POST /api/targeting submits a targeting
// profile; POST /api/content supplies content for posting; POST /api/results
// receives results from external tools.

import { Hono } from "hono";
import type { Env, ApiTokenRow, RelayRow } from "../types";
import { hashToken, nowSeconds } from "../lib/crypto";
import { draftInsert } from "../lib/drafts";
import { commandInsert } from "../lib/command";
import { runTargeting } from "../lib/target";

type ExternalEnv = { Bindings: Env; Variables: { token: ApiTokenRow } };
export const externalRoutes = new Hono<ExternalEnv>();

// Token-auth middleware: resolves the Bearer token to an ApiTokenRow and
// stores it on `c.set("token", ...)`. All downstream handlers read from there.
externalRoutes.use("*", async (c, next) => {
  const auth = c.req.header("Authorization");
  if (!auth?.startsWith("Bearer ")) return c.json({ error: "unauthorized" }, 401);
  const token = auth.slice("Bearer ".length);
  const hash = await hashToken(token);
  const row = (await c.env.DB.prepare(
    "SELECT * FROM api_tokens WHERE token_hash = ? AND revoked_at IS NULL",
  )
    .bind(hash)
    .first()) as ApiTokenRow | undefined;
  if (!row) return c.json({ error: "unauthorized" }, 401);
  c.set("token", row);
  return next();
});

// POST /api/targeting — submit a targeting profile that drives the funnel for
// the user's first relay. Creates the automation, runs the targeting pass
// synchronously, and returns the results so the caller (e.g. Hermes Agent
// plugin) can act on them immediately.
externalRoutes.post("/targeting", async (c) => {
  const token = c.get("token");
  const body = (await c.req.json().catch(() => ({}))) as {
    relay_id?: string;
    search_criteria?: Record<string, unknown>;
    targeting?: Record<string, unknown>;
    name?: string;
  };
  const relayId = body.relay_id;
  if (!relayId) return c.json({ error: "relay_id required" }, 400);

  // Verify relay ownership.
  const relay = (await c.env.DB.prepare("SELECT id FROM relays WHERE id = ? AND user_id = ?")
    .bind(relayId, token.user_id)
    .first()) as { id: string } | undefined;
  if (!relay) return c.json({ error: "relay not found" }, 404);

  const nowSec = nowSeconds();
  const id = crypto.randomUUID();
  await c.env.DB.prepare(
    `INSERT INTO automations (id, user_id, relay_id, name, status, search_criteria, targeting, rules, budgets, mode, auto_threshold, interval_minutes, timezone, next_run_at, created_at)
     VALUES (?, ?, ?, ?, 'active', ?, ?, '{}', '{}', 'manual', 3, 60, 'UTC', ?, ?)`,
  )
    .bind(
      id,
      token.user_id,
      relayId,
      body.name ?? "external-targeting",
      JSON.stringify(body.search_criteria ?? {}),
      JSON.stringify(body.targeting ?? {}),
      nowSec + 3600,
      nowSec,
    )
    .run();

  // Run the targeting pass synchronously so the caller gets results back.
  const result = await runTargeting(c.env, token.user_id, id);

  return c.json({
    automation_id: id,
    targeting: result.summaries[0] ?? { automation_id: id, actionable: 0, judged: 0, drafts: 0, skips: 0, failures: 0 },
    error: result.error ?? null,
  }, 201);
});

// POST /api/content — webhook content source. Accepts text and optionally a
// target tweet, creates a draft ready for approval or auto-execution.
externalRoutes.post("/content", async (c) => {
  const token = c.get("token");
  const body = (await c.req.json().catch(() => ({}))) as {
    relay_id?: string;
    text?: string;
    target_tweet_id?: string;
    target_author?: string;
    action?: string;
  };
  if (!body.relay_id) return c.json({ error: "relay_id required" }, 400);
  if (!body.text?.trim()) return c.json({ error: "text required" }, 400);

  const relay = (await c.env.DB.prepare("SELECT id FROM relays WHERE id = ? AND user_id = ?")
    .bind(body.relay_id, token.user_id)
    .first()) as { id: string } | undefined;
  if (!relay) return c.json({ error: "relay not found" }, 404);

  const nowSec = nowSeconds();
  // Determine action: explicit action > inferred from target
  let action: "reply" | "post" | "quote" = "post";
  if (body.action === "quote" && body.target_tweet_id) {
    action = "quote";
  } else if (body.target_tweet_id) {
    action = "reply";
  }

  const result = await draftInsert(c.env.DB, {
    userId: token.user_id,
    relayId: body.relay_id,
    targetTweetId: body.target_tweet_id ?? undefined,
    action,
    reason: "external content",
    priority: 3,
    status: "ready",
    text: body.text.trim(),
    createdAt: nowSec,
  }).run();
  return c.json({ draft_id: result.meta.last_row_id, action }, 201);
});

// POST /api/results — receive results from external tools into the audit trail.
externalRoutes.post("/results", async (c) => {
  const token = c.get("token");
  const body = (await c.req.json().catch(() => ({}))) as {
    relay_id?: string;
    draft_id?: number;
    tweet_id?: string;
    status?: string;
    reason?: string;
  };
  const nowSec = nowSeconds();
  const db = c.env.DB;

  if (body.draft_id) {
    const status = body.status === "done" ? "done" : body.status === "failed" ? "failed" : "done";
    const stmts: D1PreparedStatement[] = [
      db.prepare("UPDATE drafts SET status = ?, result_tweet_id = ?, executed_at = ? WHERE id = ? AND user_id = ?")
        .bind(status, body.tweet_id ?? null, nowSec, body.draft_id, token.user_id),
    ];
    if (body.tweet_id) {
      stmts.push(
        db.prepare("UPDATE messages SET tweet_id = ? WHERE draft_id = ? AND role = 'outbound'")
          .bind(body.tweet_id, body.draft_id),
      );
    }
    await db.batch(stmts);
  }

  return c.json({ ok: true });
});
