// Ticket 11: the draft execution pass, run from the per-minute tick. Takes
// drafts that are ready (verdict + text) in auto or hybrid-below-threshold
// mode and enqueues the relay write command, marking the draft executing and
// inserting the dedupe row so no other funnel stage double-engages the tweet
// while the command sits in the queue.
//
// Guardrails are re-checked here against live state (relay kill switch,
// cross-account dedupe, quiet hours, daily budgets) — the targeting pass ran
// them, but budgets are consumed between then and execution. A blocked draft
// is skipped silently and stays ready for the next pass.

import type { AutomationRow, Env, RelayRow } from "../types";
import { commandInsert } from "./command";
import { nowSeconds } from "./crypto";
import { dailyUsage } from "./funnel-run";
import { parseBudgets } from "./funnel";
import { inQuietHours, startOfDayInZone } from "./time";
import { safeParse } from "./json";

export const MAX_DRAFT_BATCH = 20; // 20 drafts x 4 statements stays under D1's batch limit

type ExecutableDraftRow = {
  id: number;
  user_id: string;
  relay_id: string;
  automation_id: string;
  candidate_id: string;
  action: "reply" | "quote";
  reason: string;
  priority: number;
  tweet_id: string;
  author: string;
  text: string;
  mode: AutomationRow["mode"];
  auto_threshold: number;
  timezone: string;
  budgets: string;
  relay_enabled: number;
};

// Quote the candidate post via its permalink; replies target the tweet id.
// Shared by the tick pass and the inbox approve (one payload shape, one
// enqueue recipe, so both paths cannot drift).
export function writePayload(d: {
  id: number;
  action: "reply" | "quote";
  author: string;
  tweet_id: string;
  text: string;
}): { type: string; payload: Record<string, string> } {
  const base = { draft_id: String(d.id), text: d.text };
  if (d.action === "reply") {
    return { type: "reply", payload: { ...base, in_reply_to_tweet_id: d.tweet_id } };
  }
  return { type: "quote", payload: { ...base, attachment_url: `https://x.com/${d.author}/status/${d.tweet_id}` } };
}

// The atomic enqueue recipe: write command + dedupe claim + executing marker,
// one batch. `overrideText` also persists the approved text on the draft (the
// inbox review step); the tick path leaves the stored text as-is.
export function enqueueDraftStatements(
  env: Env,
  draft: { id: number; user_id: string; relay_id: string; action: "reply" | "quote" },
  candidate: { tweet_id: string; author: string },
  text: string,
  commandId: string,
  nowSec: number,
  overrideText?: boolean,
): D1PreparedStatement[] {
  const { type, payload } = writePayload({ id: draft.id, action: draft.action, author: candidate.author, tweet_id: candidate.tweet_id, text });
  const action = draft.action === "reply" ? "reply" : "quote";
  const update = overrideText
    ? env.DB.prepare(
        "UPDATE drafts SET status = 'executing', command_id = ?, text = ?, decided_at = ? WHERE id = ? AND user_id = ? AND status IN ('ready', 'content_failed')",
      ).bind(commandId, text, nowSec, draft.id, draft.user_id)
    : env.DB.prepare(
        "UPDATE drafts SET status = 'executing', command_id = ? WHERE id = ? AND user_id = ? AND status = 'ready'",
      ).bind(commandId, draft.id, draft.user_id);
  return [
    commandInsert(env.DB, commandId, draft.relay_id, type, JSON.stringify(payload), nowSec),
    env.DB.prepare("INSERT OR IGNORE INTO dedup (user_id, relay_id, tweet_id, action, acted_at) VALUES (?, ?, ?, ?, ?)").bind(
      draft.user_id,
      draft.relay_id,
      candidate.tweet_id,
      action,
      nowSec,
    ),
    update,
  ];
}

// Runs auto/hybrid execution for every user in one pass; returns the number of
// commands enqueued.
export async function executeReadyDrafts(env: Env): Promise<number> {
  const nowMs = Date.now();
  const nowSec = nowSeconds();
  const rows = (await env.DB.prepare(
    `SELECT d.id, d.user_id, d.relay_id, d.automation_id, d.candidate_id, d.action, d.reason, d.priority, d.text,
            c.tweet_id, c.author, a.mode, a.auto_threshold, a.timezone, a.budgets, r.enabled AS relay_enabled
     FROM drafts d
     JOIN candidates c ON c.id = d.candidate_id
     JOIN automations a ON a.id = d.automation_id
     JOIN relays r ON r.id = d.relay_id
     WHERE d.status = 'ready' AND d.text != ''
     ORDER BY d.priority DESC, d.created_at ASC
     LIMIT ?`,
  )
    .bind(MAX_DRAFT_BATCH)
    .all()) as unknown as { results: ExecutableDraftRow[] };

  // Live dedupe rows and budget usage are fetched once per user/relay in the
  // batch, not per draft.
  const users = [...new Set(rows.results.map((d) => d.user_id))];
  const dedupSets = new Map<string, Set<string>>();
  for (const u of users) {
    const res = (await env.DB.prepare("SELECT tweet_id FROM dedup WHERE user_id = ?")
      .bind(u)
      .all()) as unknown as { results: Array<{ tweet_id: string }> };
    dedupSets.set(u, new Set(res.results.map((r) => r.tweet_id)));
  }
  const relays = [...new Set(rows.results.map((d) => d.relay_id))];
  const usages = new Map<string, { posts: number; replies: number }>();
  for (const r of relays) {
    usages.set(r, await dailyUsage(env, r, Math.floor(startOfDayInZone(nowMs, "UTC") / 1000)));
  }

  const statements: D1PreparedStatement[] = [];
  let executed = 0;
  for (const d of rows.results) {
    if (d.mode === "manual") continue;
    if (d.mode === "hybrid" && d.priority >= d.auto_threshold) continue; // inbox review
    if (d.relay_enabled === 0) continue; // kill switch
    const dedup = dedupSets.get(d.user_id);
    if (dedup && dedup.has(d.tweet_id)) continue; // already engaged elsewhere
    const budgets = parseBudgets(safeParse(d.budgets));
    if (inQuietHours(nowMs, budgets.quiet_hours, d.timezone)) continue;
    const usage = usages.get(d.relay_id);
    if (!usage) continue;
    if (d.action === "reply" && usage.replies >= budgets.max_replies_per_day) continue;
    if (d.action === "quote" && usage.posts >= budgets.max_posts_per_day) continue;

    const commandId = crypto.randomUUID();
    statements.push(
      ...enqueueDraftStatements(env, d, { tweet_id: d.tweet_id, author: d.author }, d.text, commandId, nowSec),
    );
    executed += 1;
  }

  if (statements.length > 0) await env.DB.batch(statements);
  return executed;
}

// Whether a draft's execute attempt will be blocked for the given relay — the
// two hard safety checks the inbox approve also honours. Returns the reason.
export async function executionBlockReason(env: Env, relay: RelayRow, tweetId: string): Promise<string | null> {
  if (relay.enabled === 0) return "account is kill-switched off";
  const dup = (await env.DB.prepare("SELECT 1 FROM dedup WHERE user_id = ? AND tweet_id = ?")
    .bind(relay.user_id, tweetId)
    .first()) as { [key: string]: unknown } | undefined;
  if (dup) return "tweet already engaged elsewhere";
  return null;
}