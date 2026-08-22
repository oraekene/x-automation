// The Universe-stage candidate pool: one INSERT OR IGNORE shape, shared by
// every results ingestion so all funnel commands write candidates identically.
// Dedupe key is (user_id, tweet_id): the same tweet found by search and
// profile passes (or by several automations) lands once in the user's pool.

import { safeParse } from "./json";

export type IngestedTweet = {
  id?: unknown;
  author?: unknown;
  text?: unknown;
  created_at?: unknown;
  favorite_count?: unknown;
  retweet_count?: unknown;
  reply_count?: unknown;
  lang?: unknown;
};

export function candidateInsert(
  db: D1Database,
  fields: {
    userId: string;
    relayId: string;
    automationId: string;
    tweet: IngestedTweet;
    source: "search" | "profile";
    foundAt: number;
  },
): D1PreparedStatement {
  const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? Math.floor(v) : 0);
  const str = (v: unknown): string => (typeof v === "string" ? v : "");
  return db
    .prepare(
      `INSERT OR IGNORE INTO candidates
         (id, user_id, automation_id, relay_id, tweet_id, author, text, created_at,
          favorite_count, retweet_count, reply_count, lang, source, found_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      crypto.randomUUID(),
      fields.userId,
      fields.automationId,
      fields.relayId,
      str(fields.tweet.id),
      str(fields.tweet.author),
      str(fields.tweet.text),
      str(fields.tweet.created_at),
      num(fields.tweet.favorite_count),
      num(fields.tweet.retweet_count),
      num(fields.tweet.reply_count),
      str(fields.tweet.lang),
      fields.source,
      fields.foundAt,
    );
}

// Map a command type to its candidate source. Only funnel commands (Stage 1)
// feed the pool; ad-hoc commands never do.
export function funnelSource(type: string): "search" | "profile" | null {
  if (type === "search") return "search";
  if (type === "profile_pass") return "profile";
  return null;
}

// Derive the candidate inserts a successful funnel command's output produces.
// Returns an empty array when the command is not a funnel command, carries no
// automation_id, or reports no tweets array — so every caller ingests identically.
export function resultCandidates(
  db: D1Database,
  command: { type: string; payload: string },
  output: unknown,
  fields: { userId: string; relayId: string; foundAt: number },
): D1PreparedStatement[] {
  const source = funnelSource(command.type);
  if (!source) return [];
  const payload = safeParse(command.payload) as { automation_id?: string };
  if (!payload.automation_id) return [];
  const automationId = payload.automation_id;
  const tweets = (output as { tweets?: unknown[] } | null)?.tweets;
  if (!Array.isArray(tweets)) return [];
  return tweets.map((t) =>
    candidateInsert(db, {
      userId: fields.userId,
      relayId: fields.relayId,
      automationId,
      tweet: t as IngestedTweet,
      source,
      foundAt: fields.foundAt,
    }),
  );
}
