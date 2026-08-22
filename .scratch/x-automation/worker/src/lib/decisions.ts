// The funnel audit trail (ticket 09): one shared INSERT shape for every rule
// decision, so filter, guardrail and AI-targeting runs all write identically.

import type { RuleName } from "./funnel";

export type AiStageName = "ai_target" | "ai_fail";

export type DecisionInput = {
  userId: string;
  relayId: string;
  automationId: string;
  candidateId: string;
  stage: "filter" | "guardrail" | "ai";
  decision: "keep" | "reject" | "block" | "draft" | "skip" | "fail";
  rule: RuleName | AiStageName;
  reason: string;
  score: number;
  actedAt: number;
};

export function decisionInsert(db: D1Database, d: DecisionInput): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO decisions
         (id, user_id, relay_id, automation_id, candidate_id, stage, decision, rule, reason, score, acted_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      crypto.randomUUID(),
      d.userId,
      d.relayId,
      d.automationId,
      d.candidateId,
      d.stage,
      d.decision,
      d.rule,
      d.reason,
      d.score,
      d.actedAt,
    );
}