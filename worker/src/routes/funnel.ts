import { Hono } from "hono";
import type { AutomationRow, CandidateRow, DecisionRow, Env, RelayRow } from "../types";
import { getUser } from "../auth";
import { nowSeconds } from "../lib/crypto";
import { decisionInsert } from "../lib/decisions";
import { applyGuardrails, filterCandidates, parseBudgets, parseRules } from "../lib/funnel";
import { startOfDayInZone } from "../lib/time";
import { safeParse } from "../lib/json";

export const funnelRoutes = new Hono<{ Bindings: Env }>();

const MAX_POOL = 500;

// How many of today's acted actions each bucket has used, per account (relay).
// `post` and `quote` count as posts; `reply` counts as replies.
export async function dailyUsage(
  db: D1Database,
  relayId: string,
  startOfDaySec: number,
): Promise<{ posts: number; replies: number }> {
  const rows = (await db
    .prepare("SELECT action, COUNT(*) AS n FROM dedup WHERE relay_id = ? AND acted_at >= ? GROUP BY action")
    .bind(relayId, startOfDaySec)
    .all()) as unknown as { results: Array<{ action: string; n: number }> };
  let posts = 0;
  let replies = 0;
  for (const r of rows.results) {
    if (r.action === "reply") replies += r.n;
    else posts += r.n;
  }
  return { posts, replies };
}

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

  const nowMs = Date.now();
  const nowSec = nowSeconds();
  const audits: D1PreparedStatement[] = [];
  const summaries: Array<Record<string, unknown>> = [];

  for (const a of rows.results) {
    const rules = parseRules(safeParse(a.rules));
    const budgets = parseBudgets(safeParse(a.budgets));
    const relay = (await c.env.DB.prepare("SELECT * FROM relays WHERE id = ? AND user_id = ?")
      .bind(a.relay_id, user.id)
      .first()) as RelayRow | undefined;
    if (!relay) continue;

    const pool = (await c.env.DB.prepare(
      "SELECT * FROM candidates WHERE automation_id = ? ORDER BY found_at DESC, tweet_id DESC LIMIT ?",
    )
      .bind(a.id, MAX_POOL)
      .all()) as unknown as { results: CandidateRow[] };

    const { kept, rejected } = filterCandidates(pool.results, rules, nowMs);

    const dedupRows = (await c.env.DB.prepare("SELECT tweet_id FROM dedup WHERE user_id = ?")
      .bind(user.id)
      .all()) as unknown as { results: Array<{ tweet_id: string }> };
    const dedupTweetIds = new Set(dedupRows.results.map((r) => r.tweet_id));
    // Budgets are per account/day: count against one shared day boundary (UTC)
    // so automations on the same account in different timezones agree on the
    // day. Quiet hours below still use the automation's own timezone.
    const usage = await dailyUsage(c.env.DB, a.relay_id, Math.floor(startOfDayInZone(nowMs, "UTC") / 1000));

    const blocked = applyGuardrails(kept, {
      budgets,
      relayEnabled: relay.enabled !== 0,
      timezone: a.timezone,
      nowMs,
      dedupTweetIds,
      usage,
    });

    for (const d of [...rejected, ...kept]) {
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
    for (const b of blocked) {
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
      candidates: pool.results.length,
      kept: kept.length,
      rejected: rejected.length,
      blocked: blocked.length,
      actionable: kept.length - blocked.length,
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