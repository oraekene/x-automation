// Ticket 10+11: draft inserts. One shared INSERT shape so the targeting pass,
// the content retry pass, and future stages all write the same rows. OR IGNORE
// keeps one draft per (user, candidate) even if two passes race.

import type { DraftStatus } from "../types";

export type DraftInput = {
  userId: string;
  relayId: string;
  automationId?: string | null;
  candidateId?: string | null;
  conversationId?: string | null;
  targetTweetId?: string | null;
  action: "reply" | "quote" | "post";
  reason: string;
  priority: number;
  provider?: string;
  model?: string;
  status: DraftStatus;
  text: string;
  createdAt: number;
};

export function draftInsert(db: D1Database, d: DraftInput): D1PreparedStatement {
  return db
    .prepare(
      `INSERT OR IGNORE INTO drafts
         (user_id, relay_id, automation_id, candidate_id, conversation_id, target_tweet_id, action, reason, priority, provider, model, status, text, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      d.userId,
      d.relayId,
      d.automationId ?? null,
      d.candidateId ?? null,
      d.conversationId ?? null,
      d.targetTweetId ?? null,
      d.action,
      d.reason,
      d.priority,
      d.provider ?? "",
      d.model ?? "",
      d.status,
      d.text,
      d.createdAt,
    );
}