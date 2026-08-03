// Funnel rules engine (ticket 09): Stage 2 heuristic filter + Stage 4
// guardrails. Pure and deterministic — no DB — so it is unit-testable and
// reusable by later stages (ticket 10 runs AI verdicts on the survivors).
//
// Every decision a candidate earns (keep/reject/block) is surfaced to the
// caller, which records it in the decisions audit trail.

import { HHMM, inQuietHours } from "./time";

export type RuleName =
  | "score"
  | "engagement"
  | "freshness"
  | "language"
  | "target_size"
  | "diversity"
  | "budget"
  | "quiet_hours"
  | "dedupe"
  | "allowlist"
  | "blocklist"
  | "kill_switch";

export const RULE_NAMES: readonly RuleName[] = [
  "score",
  "engagement",
  "freshness",
  "language",
  "target_size",
  "diversity",
  "budget",
  "quiet_hours",
  "dedupe",
  "allowlist",
  "blocklist",
  "kill_switch",
];

const MS_PER_DAY = 24 * 60 * 60_000;

export type FunnelRules = {
  // Keep at most this many candidates per filter run (spec Stage 2: ~50).
  target_size: number;
  weights: {
    engagement: number; // multiplier on log-scaled engagement
    freshness: number; // multiplier on age decay
    lang_bonus: number; // flat bonus when the candidate lang matches `lang`
  };
  lang?: string; // bonus language (exact match, case-insensitive)
  min_engagement: number; // raw weighted engagement floor (0 disables)
  max_age_days: number; // reject tweets older than this
  allowlist: string[]; // non-empty → only these authors may proceed
  blocklist: string[]; // these authors are always rejected
  max_per_author: number; // diversity cap per author per filter run
};

export type FunnelBudgets = {
  max_posts_per_day: number; // posts + quotes bucket
  max_replies_per_day: number; // replies bucket
  quiet_hours: { start: string; end: string } | null; // HH:MM in the automation's timezone
};

export const DEFAULT_RULES: FunnelRules = {
  target_size: 50,
  weights: { engagement: 1, freshness: 1, lang_bonus: 1 },
  min_engagement: 0,
  max_age_days: 30,
  allowlist: [],
  blocklist: [],
  max_per_author: 10,
};

export const DEFAULT_BUDGETS: FunnelBudgets = {
  max_posts_per_day: 10,
  max_replies_per_day: 20,
  quiet_hours: null,
};

function posInt(v: unknown, fallback: number): number {
  return typeof v === "number" && Number.isFinite(v) && v >= 1 ? Math.floor(v) : fallback;
}

function nonNeg(v: unknown, fallback: number): number {
  return typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : fallback;
}

function strList(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.filter((s): s is string => typeof s === "string").map((s) => s.toLowerCase());
}

// Merge a stored rules JSON (possibly {} or malformed) over the defaults.
export function parseRules(raw: unknown): FunnelRules {
  const r = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>;
  const weights = (typeof r.weights === "object" && r.weights !== null ? r.weights : {}) as Record<string, unknown>;
  const lang = typeof r.lang === "string" && r.lang.length > 0 ? r.lang.toLowerCase() : undefined;
  return {
    target_size: posInt(r.target_size, DEFAULT_RULES.target_size),
    weights: {
      engagement: nonNeg(weights.engagement, DEFAULT_RULES.weights.engagement),
      freshness: nonNeg(weights.freshness, DEFAULT_RULES.weights.freshness),
      lang_bonus: nonNeg(weights.lang_bonus, DEFAULT_RULES.weights.lang_bonus),
    },
    lang,
    min_engagement: nonNeg(r.min_engagement, DEFAULT_RULES.min_engagement),
    max_age_days: nonNeg(r.max_age_days, DEFAULT_RULES.max_age_days),
    allowlist: strList(r.allowlist),
    blocklist: strList(r.blocklist),
    max_per_author: posInt(r.max_per_author, DEFAULT_RULES.max_per_author),
  };
}

// Merge a stored budgets JSON over the defaults; malformed quiet hours drop.
export function parseBudgets(raw: unknown): FunnelBudgets {
  const b = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>;
  const q = b.quiet_hours;
  const quiet_hours =
    typeof q === "object" && q !== null
      ? (q as Record<string, unknown>)
      : null;
  const window =
    quiet_hours &&
    typeof quiet_hours.start === "string" &&
    typeof quiet_hours.end === "string" &&
    HHMM.test(quiet_hours.start) &&
    HHMM.test(quiet_hours.end)
      ? { start: quiet_hours.start, end: quiet_hours.end }
      : null;
  return {
    max_posts_per_day: nonNeg(b.max_posts_per_day, DEFAULT_BUDGETS.max_posts_per_day),
    max_replies_per_day: nonNeg(b.max_replies_per_day, DEFAULT_BUDGETS.max_replies_per_day),
    quiet_hours: window,
  };
}

// The candidate view the heuristic stage needs.
export type FilterableCandidate = {
  id: string;
  tweet_id: string;
  author: string;
  created_at: string;
  favorite_count: number;
  retweet_count: number;
  reply_count: number;
  lang: string;
};

export type FilterDecision = {
  candidateId: string;
  tweetId: string;
  author: string; // screen name, lowercased — carried for the diversity cap and audit reasons
  decision: "keep" | "reject";
  rule: RuleName;
  reason: string;
  score: number;
};

// Raw weighted engagement (faves, retweets ~2x, replies ~1.5x) — the threshold
// input for `min_engagement` and the log base for the engagement score.
export function weightedEngagement(c: FilterableCandidate): number {
  return c.favorite_count + 2 * c.retweet_count + 1.5 * c.reply_count;
}

// Log scale keeps a viral outlier from drowning the rest of the pool.
function engagementScore(c: FilterableCandidate): number {
  return Math.log1p(weightedEngagement(c));
}

// Exponential decay by age: 1.0 at time zero, ~1/e after three days.
function freshnessScore(c: FilterableCandidate, nowMs: number): number {
  const createdAtMs = Date.parse(c.created_at) || nowMs;
  const ageHours = Math.max(0, (nowMs - createdAtMs) / (60 * 60 * 1000));
  return Math.exp(-ageHours / 72);
}

// Run Stage 2 over a candidate pool: reject by blocklist/allowlist, language,
// freshness and engagement thresholds, then score the survivors, cap the pool
// at target_size and enforce the per-author diversity cap.
export function filterCandidates(
  candidates: FilterableCandidate[],
  rules: FunnelRules,
  nowMs: number,
): { kept: FilterDecision[]; rejected: FilterDecision[] } {
  const rejected: FilterDecision[] = [];
  const scored: FilterDecision[] = [];
  const blocklist = new Set(rules.blocklist);
  const allowlist = new Set(rules.allowlist);
  const maxAgeMs = rules.max_age_days * MS_PER_DAY;

  for (const c of candidates) {
    const author = c.author.toLowerCase();
    const lang = c.lang.toLowerCase();
    if (blocklist.has(author)) {
      rejected.push(reject(c, "blocklist", `author @${c.author} is blocklisted`));
      continue;
    }
    if (allowlist.size > 0 && !allowlist.has(author)) {
      rejected.push(reject(c, "allowlist", `author @${c.author} is not on the allowlist`));
      continue;
    }
    // A configured language is a filter, not just a bonus: non-matching tweets
    // (with a known lang) are cut before scoring. Unknown lang is left alone.
    if (rules.lang && lang.length > 0 && lang !== rules.lang) {
      rejected.push(reject(c, "language", `tweet is ${c.lang || "no language"}, expected ${rules.lang}`));
      continue;
    }
    const createdAtMs = Date.parse(c.created_at) || nowMs;
    if (createdAtMs < nowMs - maxAgeMs) {
      rejected.push(reject(c, "freshness", `tweet is older than ${rules.max_age_days} days`));
      continue;
    }
    const engagement = weightedEngagement(c);
    if (engagement < rules.min_engagement) {
      rejected.push(reject(c, "engagement", `weighted engagement ${engagement.toFixed(1)} below ${rules.min_engagement}`));
      continue;
    }
    const langBonus = rules.lang && lang === rules.lang ? rules.weights.lang_bonus : 0;
    const score =
      rules.weights.engagement * engagementScore(c) + rules.weights.freshness * freshnessScore(c, nowMs) + langBonus;
    scored.push({ candidateId: c.id, tweetId: c.tweet_id, author, decision: "keep", rule: "score", reason: "", score });
  }

  scored.sort((a, b) => b.score - a.score);
  const kept: FilterDecision[] = [];
  const authorCounts = new Map<string, number>();
  for (const d of scored) {
    const seen = authorCounts.get(d.author) ?? 0;
    if (seen >= rules.max_per_author) {
      rejected.push({ ...d, decision: "reject", rule: "diversity", reason: `author @${d.author} already has ${seen} shortlisted tweets`, score: 0 });
      continue;
    }
    if (kept.length >= rules.target_size) {
      rejected.push({ ...d, decision: "reject", rule: "target_size", reason: `pool capped at ${rules.target_size}`, score: 0 });
      continue;
    }
    authorCounts.set(d.author, seen + 1);
    kept.push(d);
  }
  return { kept, rejected };
}

function reject(c: FilterableCandidate, rule: RuleName, reason: string): FilterDecision {
  return { candidateId: c.id, tweetId: c.tweet_id, author: c.author.toLowerCase(), decision: "reject", rule, reason, score: 0 };
}

export type GuardrailDecision = {
  candidateId: string;
  decision: "block";
  rule: RuleName;
  reason: string;
  score: number; // the score the candidate carried from the filter stage
};

export type GuardrailContext = {
  budgets: FunnelBudgets;
  relayEnabled: boolean; // per-account kill switch
  timezone: string;
  nowMs: number;
  dedupTweetIds: Set<string>; // acted-on tweets across all the user's automations/accounts
  usage: { posts: number; replies: number }; // today's acted counts for this account
};

// Run Stage 4 over the survivors: kill switch, cross-account dedupe, quiet
// hours, then daily budgets (posts bucket first — a full post budget blocks
// everything until actions are assigned per candidate in later stages).
export function applyGuardrails(
  kept: Array<{ candidateId: string; tweetId: string; score: number }>,
  ctx: GuardrailContext,
): GuardrailDecision[] {
  const { budgets, relayEnabled, timezone, nowMs, dedupTweetIds, usage } = ctx;
  const blocked: GuardrailDecision[] = [];
  for (const k of kept) {
    const block = (rule: RuleName, reason: string): GuardrailDecision => ({
      candidateId: k.candidateId,
      decision: "block",
      rule,
      reason,
      score: k.score,
    });
    if (!relayEnabled) {
      blocked.push(block("kill_switch", "account is kill-switched off"));
    } else if (dedupTweetIds.has(k.tweetId)) {
      blocked.push(block("dedupe", `tweet ${k.tweetId} already engaged elsewhere`));
    } else if (inQuietHours(nowMs, budgets.quiet_hours, timezone)) {
      blocked.push(block("quiet_hours", `within quiet hours ${budgets.quiet_hours!.start}-${budgets.quiet_hours!.end}`));
    } else if (usage.posts >= budgets.max_posts_per_day) {
      blocked.push(block("budget", `daily post budget (${usage.posts}/${budgets.max_posts_per_day}) exhausted`));
    } else if (usage.replies >= budgets.max_replies_per_day) {
      blocked.push(block("budget", `daily reply budget (${usage.replies}/${budgets.max_replies_per_day}) exhausted`));
    }
  }
  return blocked;
}
