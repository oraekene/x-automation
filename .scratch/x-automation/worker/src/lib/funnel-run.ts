// DB-backed funnel runs: the shared derivation of a funnel-automation run.
// /filter (routes) and /target (ticket 10) both drive Stage 2 + Stage 4 over
// one automation's pool, so the derivation lives here once instead of being
// copy-pasted between the two consumers.

import type { AutomationRow, CandidateRow, Env, RelayRow } from "../types";
import {
  applyGuardrails,
  filterCandidates,
  parseBudgets,
  parseRules,
  type FilterDecision,
  type GuardrailDecision,
} from "./funnel";
import { safeParse } from "./json";
import { startOfDayInZone } from "./time";

export const MAX_POOL = 500;

export type DeriveResult = {
  relay: RelayRow;
  pool: CandidateRow[];
  kept: FilterDecision[];
  rejected: FilterDecision[];
  blocked: GuardrailDecision[];
  blockedIds: Set<string>;
  byId: Map<string, CandidateRow>;
};

// How many of today's acted actions each bucket has used, per account (relay).
// `post` and `quote` count as posts; `reply` counts as replies.
export async function dailyUsage(
  env: Env,
  relayId: string,
  startOfDaySec: number,
): Promise<{ posts: number; replies: number }> {
  const rows = (await env.DB.prepare(
    "SELECT action, COUNT(*) AS n FROM dedup WHERE relay_id = ? AND acted_at >= ? GROUP BY action",
  )
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

// Stage 2 filter + Stage 4 guardrails over one automation's current pool.
// Returns null when the automation's relay is absent. `kept` minus `blockedIds`
// are the survivors later stages consume.
export async function deriveActionable(
  env: Env,
  userId: string,
  a: AutomationRow,
): Promise<DeriveResult | null> {
  const relay = (await env.DB.prepare("SELECT * FROM relays WHERE id = ? AND user_id = ?")
    .bind(a.relay_id, userId)
    .first()) as RelayRow | undefined;
  if (!relay) return null;

  const pool = (await env.DB.prepare(
    "SELECT * FROM candidates WHERE automation_id = ? ORDER BY found_at DESC, tweet_id DESC LIMIT ?",
  )
    .bind(a.id, MAX_POOL)
    .all()) as unknown as { results: CandidateRow[] };
  const byId = new Map(pool.results.map((r) => [r.id, r]));

  const nowMs = Date.now();
  const { kept, rejected } = filterCandidates(pool.results, parseRules(safeParse(a.rules)), nowMs);

  const dedupRows = (await env.DB.prepare("SELECT tweet_id FROM dedup WHERE user_id = ?")
    .bind(userId)
    .all()) as unknown as { results: Array<{ tweet_id: string }> };
  const dedupTweetIds = new Set(dedupRows.results.map((r) => r.tweet_id));
  // Budgets are per account/day: count against one shared day boundary (UTC)
  // so automations on the same account in different timezones agree on the
  // day. Quiet hours below still use the automation's own timezone.
  const usage = await dailyUsage(env, a.relay_id, Math.floor(startOfDayInZone(nowMs, "UTC") / 1000));

  const blocked = applyGuardrails(kept, {
    budgets: parseBudgets(safeParse(a.budgets)),
    relayEnabled: relay.enabled !== 0,
    timezone: a.timezone,
    nowMs,
    dedupTweetIds,
    usage,
  });
  const blockedIds = new Set(blocked.map((b) => b.candidateId));

  return { relay, pool: pool.results, kept, rejected, blocked, blockedIds, byId };
}