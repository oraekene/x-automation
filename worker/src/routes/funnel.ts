import { Hono } from "hono";
import type { AutomationRow, DecisionRow, Env } from "../types";
import { getUser } from "../auth";
import { nowSeconds } from "../lib/crypto";
import { decisionInsert } from "../lib/decisions";
import { deriveActionable } from "../lib/funnel-run";
import { runTargeting } from "../lib/target";

export const funnelRoutes = new Hono<{ Bindings: Env }>();

// POST /api/funnel/filter — run the Stage 2 heuristic filter and Stage 4
// guardrails over one automation's candidate pool (or all the user's active
// automations when no automation_id is given). Deterministic and idempotent:
// every decision is appended to the audit trail, and `actionable` (survivors
// that clear the guardrails) is what later stages consume. Budget exceeded or
// quiet hours → actionable is empty → nothing acts.
funnelRoutes.post("/filter", async (c) => {
  const user = await getUser(c);
  if (!user) return c.json({ error: "unauthorized" }, 401);
  const body = (await c.req.json().catch(() => ({}))) as { automation_id?: string };

  const rows = body.automation_id
    ? ((await c.env.DB.prepare("SELECT * FROM automations WHERE user_id = ? AND id = ?")
        .bind(user.id, body.automation_id)
        .all()) as unknown as { results: AutomationRow[] })
    : ((await c.env.DB.prepare("SELECT * FROM automations WHERE user_id = ? AND status = 'active'")
        .bind(user.id)
        .all()) as unknown as { results: AutomationRow[] });
  if (body.automation_id && rows.results.length === 0) return c.json({ error: "not found" }, 404);

  const nowSec = nowSeconds();
  const audits: D1PreparedStatement[] = [];
  const summaries: Array<Record<string, unknown>> = [];

  for (const a of rows.results) {
    const derived = await deriveActionable(c.env, user.id, a);
    if (!derived) continue;

    for (const d of [...derived.rejected, ...derived.kept]) {
      audits.push(
        decisionInsert(c.env.DB, {
          userId: user.id,
          relayId: a.relay_id,
          automationId: a.id,
          candidateId: d.candidateId,
          stage: "filter",
          decision: d.decision,
          rule: d.rule,
          reason: d.reason,
          score: d.score,
          actedAt: nowSec,
        }),
      );
    }
    for (const b of derived.blocked) {
      audits.push(
        decisionInsert(c.env.DB, {
          userId: user.id,
          relayId: a.relay_id,
          automationId: a.id,
          candidateId: b.candidateId,
          stage: "guardrail",
          decision: "block",
          rule: b.rule,
          reason: b.reason,
          score: b.score,
          actedAt: nowSec,
        }),
      );
    }

    summaries.push({
      automation_id: a.id,
      candidates: derived.pool.length,
      kept: derived.kept.length,
      rejected: derived.rejected.length,
      blocked: derived.blocked.length,
      actionable: derived.kept.length - derived.blocked.length,
    });
  }

  if (audits.length > 0) await c.env.DB.batch(audits);
  return c.json({ automations: summaries });
});

// GET /api/funnel/decisions — the funnel audit trail, newest first.
funnelRoutes.get("/decisions", async (c) => {
  const user = await getUser(c);
  if (!user) return c.json({ error: "unauthorized" }, 401);
  const automationId = c.req.query("automation_id");
  const rows = automationId
    ? ((await c.env.DB.prepare(
        "SELECT * FROM decisions WHERE user_id = ? AND automation_id = ? ORDER BY acted_at DESC, id DESC LIMIT 200",
      )
        .bind(user.id, automationId)
        .all()) as unknown as { results: DecisionRow[] })
    : ((await c.env.DB.prepare("SELECT * FROM decisions WHERE user_id = ? ORDER BY acted_at DESC, id DESC LIMIT 200")
        .bind(user.id)
        .all()) as unknown as { results: DecisionRow[] });
  return c.json({
    decisions: rows.results.map((r) => ({
      id: r.id,
      automation_id: r.automation_id,
      candidate_id: r.candidate_id,
      stage: r.stage,
      decision: r.decision,
      rule: r.rule,
      reason: r.reason,
      score: r.score,
      acted_at: r.acted_at,
    })),
  });
});

// POST /api/funnel/target — Funnel Stage 3: AI targeting. Same automation
// selection as /filter (shared derivation in lib/funnel-run): ask the
// configured provider for a verdict on each actionable candidate that has no
// verdict yet. Reply/quote verdicts become drafts; skips and failures land in
// the audit trail (stage 'ai'). Idempotent: candidates already judged are
// never re-called, so re-running only retries failures.
funnelRoutes.post("/target", async (c) => {
  const user = await getUser(c);
  if (!user) return c.json({ error: "unauthorized" }, 401);
  const body = (await c.req.json().catch(() => ({}))) as { automation_id?: string };

  const result = await runTargeting(c.env, user.id, body.automation_id);
  if (result.error === "not_found") return c.json({ error: "not found" }, 404);
  if (result.error === "no_provider") return c.json({ error: "no provider configured" }, 409);
  return c.json({ automations: result.summaries });
});