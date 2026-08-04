// Ticket 10: the Funnel Stage 3 targeting pass, shared by the on-demand
// POST /api/funnel/target route and the hourly retry sweep in scheduled.ts.
//
// For each automation the caller asks for, re-derive the actionable survivors
// (Stage 2 + Stage 4, shared with /filter via lib/funnel-run) and ask the AI
// for a verdict on each one that has no verdict yet. Verdicts land in `drafts`
// (reply | quote) or the decisions audit trail (skip | fail). Candidates whose
// latest ai decision is draft|skip are never re-queried — only failures are
// retried — so repeated runs are idempotent and never spend a user's AI quota
// twice.

import type { AutomationRow, Env, ProviderRow } from "../types";
import { nowSeconds } from "./crypto";
import { aiTargetingVerdict } from "./ai";
import { decisionInsert } from "./decisions";
import { draftInsert } from "./drafts";
import { deriveActionable } from "./funnel-run";
import { safeParse } from "./json";

export type AutomationTargetSummary = {
  automation_id: string;
  actionable: number;
  judged: number;
  drafts: number;
  skips: number;
  failures: number;
};

export type TargetRunResult = {
  summaries: AutomationTargetSummary[];
  error?: "not_found" | "no_provider";
};

type AiVerdictRow = { candidate_id: string; decision: string; acted_at: number };

// Latest ai decision per candidate for one automation; verdicts are appended
// over time, so a draft|skip supersedes an earlier fail and must not re-judge.
function latestAiDecisions(rows: AiVerdictRow[]): Map<string, string> {
  const latest = new Map<string, { decision: string; acted_at: number }>();
  for (const r of rows) {
    const cur = latest.get(r.candidate_id);
    if (!cur || r.acted_at > cur.acted_at) latest.set(r.candidate_id, { decision: r.decision, acted_at: r.acted_at });
  }
  return new Map([...latest.entries()].map(([id, v]) => [id, v.decision]));
}

// Run the targeting pass for one user, optionally scoped to one automation.
// `judgedCap` bounds the number of AI calls across the run (the hourly sweep);
// the on-demand route leaves it unlimited.
export async function runTargeting(
  env: Env,
  userId: string,
  automationId?: string,
  judgedCap?: number,
): Promise<TargetRunResult> {
  const rows = automationId
    ? ((await env.DB.prepare("SELECT * FROM automations WHERE user_id = ? AND id = ?")
        .bind(userId, automationId)
        .all()) as unknown as { results: AutomationRow[] })
    : ((await env.DB.prepare("SELECT * FROM automations WHERE user_id = ? AND status = 'active'")
        .bind(userId)
        .all()) as unknown as { results: AutomationRow[] });
  if (automationId && rows.results.length === 0) return { summaries: [], error: "not_found" };

  const provider = (await env.DB.prepare("SELECT * FROM provider_configs WHERE user_id = ?")
    .bind(userId)
    .first()) as ProviderRow | undefined;
  if (!provider) return { summaries: [], error: "no_provider" };

  const nowSec = nowSeconds();
  const statements: D1PreparedStatement[] = [];
  const summaries: AutomationTargetSummary[] = [];
  let judged = 0;

  for (const a of rows.results) {
    const derive = await deriveActionable(env, userId, a);
    if (!derive) continue;
    const blockedIds = derive.blockedIds;
    const survivors = derive.kept.filter((k) => !blockedIds.has(k.candidateId));
    const profile = JSON.stringify(safeParse(a.targeting));

    const aiRows = (await env.DB.prepare(
      "SELECT candidate_id, decision, acted_at FROM decisions WHERE user_id = ? AND automation_id = ? AND stage = 'ai'",
    )
      .bind(userId, a.id)
      .all()) as unknown as { results: AiVerdictRow[] };
    const latestVerdict = latestAiDecisions(aiRows.results);

    let drafts = 0;
    let skips = 0;
    let failures = 0;
    let judgedHere = 0;

    for (const k of survivors) {
      const verdict = latestVerdict.get(k.candidateId);
      if (verdict && verdict !== "fail") continue; // already judged: draft or skip
      if (judgedCap !== undefined && judged >= judgedCap) break;
      judged += 1;
      judgedHere += 1;

      const cand = derive.byId.get(k.candidateId);
      const outcome = await aiTargetingVerdict({
        baseUrl: provider.base_url,
        apiKey: provider.api_key,
        model: provider.model,
        candidate: {
          author: cand?.author ?? "",
          text: cand?.text ?? "",
          score: k.score,
          automationName: a.name,
          profile,
        },
      });

      if (!outcome.ok) {
        failures += 1;
        statements.push(
          decisionInsert(env.DB, {
            userId,
            relayId: a.relay_id,
            automationId: a.id,
            candidateId: k.candidateId,
            stage: "ai",
            decision: "fail",
            rule: "ai_fail",
            reason: outcome.error,
            score: 0,
            actedAt: nowSec,
          }),
        );
        continue;
      }

      const v = outcome.verdict;
      if (v.action === "skip") {
        skips += 1;
        statements.push(
          decisionInsert(env.DB, {
            userId,
            relayId: a.relay_id,
            automationId: a.id,
            candidateId: k.candidateId,
            stage: "ai",
            decision: "skip",
            rule: "ai_target",
            reason: v.reason,
            score: v.priority,
            actedAt: nowSec,
          }),
        );
      } else {
        drafts += 1;
        statements.push(
          draftInsert(env.DB, {
            userId,
            relayId: a.relay_id,
            automationId: a.id,
            candidateId: k.candidateId,
            action: v.action,
            reason: v.reason,
            priority: v.priority,
            provider: provider.base_url,
            model: provider.model,
            createdAt: nowSec,
          }),
          decisionInsert(env.DB, {
            userId,
            relayId: a.relay_id,
            automationId: a.id,
            candidateId: k.candidateId,
            stage: "ai",
            decision: "draft",
            rule: "ai_target",
            reason: v.reason,
            score: v.priority,
            actedAt: nowSec,
          }),
        );
      }
    }

    summaries.push({
      automation_id: a.id,
      actionable: survivors.length,
      judged: judgedHere,
      drafts,
      skips,
      failures,
    });
  }

  if (statements.length > 0) await env.DB.batch(statements);
  return { summaries };
}