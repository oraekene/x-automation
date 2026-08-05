import type { ConversationRow, ConversationSettingsRow, Env } from "../types";
import { commandInsert } from "./command";
import { nowSeconds } from "./crypto";
import { draftInsert } from "./drafts";
import { draftTurn } from "./ai";
import { zoneOffsetMs } from "./time";

// Centralized defaults — single source for code, routes, and tests.
export const CONVERSATION_DEFAULTS = {
  max_turns: 5,
  max_turns_cap: 8,
  inactivity_minutes: 1440,
  daily_new_cap: 10,
  timezone: "UTC",
} as const;

type InboundTweet = {
  id: string;
  author: string;
  text: string;
  in_reply_to_tweet_id: string | null;
};

type ResolvedSettings = {
  max_turns: number;
  inactivity_minutes: number;
  daily_new_cap: number;
  quiet_hours: { start: string; end: string } | null;
  timezone: string;
};

function resolveSettings(row: ConversationSettingsRow | undefined): ResolvedSettings {
  return {
    max_turns: Math.min(CONVERSATION_DEFAULTS.max_turns_cap, row?.max_turns ?? CONVERSATION_DEFAULTS.max_turns),
    inactivity_minutes: row?.inactivity_minutes ?? CONVERSATION_DEFAULTS.inactivity_minutes,
    daily_new_cap: row?.daily_new_cap ?? CONVERSATION_DEFAULTS.daily_new_cap,
    quiet_hours: row?.quiet_hours ? JSON.parse(row.quiet_hours) : null,
    timezone: row?.timezone ?? CONVERSATION_DEFAULTS.timezone,
  };
}

function isInQuietHours(nowSec: number, quietHours: { start: string; end: string }, timezone: string): boolean {
  const nowMs = nowSec * 1000;
  const localMs = nowMs + zoneOffsetMs(timezone, nowMs);
  const MS_PER_DAY = 86_400_000;
  const minuteOfDay = Math.floor((localMs % MS_PER_DAY) / 60_000);
  const toMin = (hhmm: string) => { const [h, m] = hhmm.split(":").map(Number); return h * 60 + m; };
  const start = toMin(quietHours.start);
  const end = toMin(quietHours.end);
  return start <= end
    ? minuteOfDay >= start && minuteOfDay < end
    : minuteOfDay >= start || minuteOfDay < end;
}

async function findOrCreateConversation(
  db: D1Database,
  userId: string,
  relayId: string,
  tweet: InboundTweet,
  nowSec: number,
): Promise<{ conv: ConversationRow; isNew: boolean } | null> {
  if (!tweet.in_reply_to_tweet_id) return null;

  const parentMsg = (await db.prepare(
    "SELECT conversation_id FROM messages WHERE user_id = ? AND tweet_id = ?",
  )
    .bind(userId, tweet.in_reply_to_tweet_id)
    .first()) as { conversation_id: string } | undefined;

  if (parentMsg) {
    const conv = (await db.prepare("SELECT * FROM conversations WHERE id = ?")
      .bind(parentMsg.conversation_id)
      .first()) as ConversationRow;
    return conv.status === "open" ? { conv, isNew: false } : null;
  }

  const convId = crypto.randomUUID();
  await db.prepare(
    "INSERT INTO conversations (id, user_id, relay_id, peer, root_tweet_id, last_turn_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
  )
    .bind(convId, userId, relayId, tweet.author, tweet.in_reply_to_tweet_id, nowSec, nowSec)
    .run();
  const conv = (await db.prepare("SELECT * FROM conversations WHERE id = ?")
    .bind(convId)
    .first()) as ConversationRow;
  return { conv, isNew: true };
}

async function checkDeterministicCaps(
  env: Env,
  userId: string,
  conv: ConversationRow,
  isNew: boolean,
  settings: ResolvedSettings,
  nowSec: number,
  newConversationsThisBatch: number,
): Promise<boolean> {
  const turnCount = isNew ? conv.turn_count : conv.turn_count + 1;
  if (turnCount >= settings.max_turns) return false;

  const todayStart = Math.floor(new Date(nowSec * 1000).setUTCHours(0, 0, 0, 0) / 1000);
  const dailyCount = (await env.DB.prepare(
    "SELECT COUNT(*) as cnt FROM conversations WHERE user_id = ? AND created_at >= ?",
  )
    .bind(userId, todayStart)
    .first()) as { cnt: number };
  if (dailyCount.cnt >= settings.daily_new_cap && newConversationsThisBatch === 0) return false;

  if (settings.quiet_hours && isInQuietHours(nowSec, settings.quiet_hours, settings.timezone)) return false;

  return true;
}

// Enqueue an inbound_scan command for each relay that has open conversations.
export async function tickConversations(env: Env): Promise<number> {
  const nowSec = nowSeconds();

  const openRelays = (await env.DB.prepare(
    "SELECT DISTINCT relay_id FROM conversations WHERE status = 'open'",
  ).all()) as unknown as { results: Array<{ relay_id: string }> };

  if (openRelays.results.length === 0) return 0;

  const statements: D1PreparedStatement[] = [];
  for (const r of openRelays.results) {
    const commandId = crypto.randomUUID();
    statements.push(
      commandInsert(env.DB, commandId, r.relay_id, "inbound_scan", "{}", nowSec),
    );
  }

  await env.DB.batch(statements);
  return statements.length;
}

// Process inbound tweets from an inbound_scan result.
export async function processInboundTweets(
  env: Env,
  relayId: string,
  userId: string,
  tweets: InboundTweet[],
): Promise<{ conversations: number; turns: number; skipped: number }> {
  const nowSec = nowSeconds();
  let conversations = 0;
  let turns = 0;
  let skipped = 0;

  await env.DB.prepare("UPDATE relays SET last_inbound_scan_at = ? WHERE id = ?")
    .bind(nowSec, relayId)
    .run();

  const settingsRow = (await env.DB.prepare("SELECT * FROM conversation_settings WHERE user_id = ?")
    .bind(userId)
    .first()) as ConversationSettingsRow | undefined;
  const settings = resolveSettings(settingsRow);

  for (const tweet of tweets) {
    const existing = await env.DB.prepare("SELECT 1 FROM messages WHERE user_id = ? AND tweet_id = ?")
      .bind(userId, tweet.id)
      .first();
    if (existing) { skipped++; continue; }

    const result = await findOrCreateConversation(env.DB, userId, relayId, tweet, nowSec);
    if (!result) { skipped++; continue; }
    const { conv, isNew } = result;
    if (isNew) conversations++;

    if (!(await checkDeterministicCaps(env, userId, conv, isNew, settings, nowSec, conversations))) continue;

    const turnCount = isNew ? conv.turn_count : conv.turn_count + 1;

    const history = (await env.DB.prepare(
      "SELECT role, text FROM messages WHERE conversation_id = ? ORDER BY created_at ASC",
    )
      .bind(conv.id)
      .all()) as unknown as { results: Array<{ role: string; text: string }> };

    const provider = (await env.DB.prepare(
      "SELECT base_url, api_key, model FROM provider_configs WHERE user_id = ?",
    )
      .bind(userId)
      .first()) as { base_url: string; api_key: string; model: string } | undefined;
    if (!provider) continue;

    const turn = await draftTurn({
      baseUrl: provider.base_url,
      apiKey: provider.api_key,
      model: provider.model,
      conversationHistory: history.results.map((m) => ({ role: m.role as "inbound" | "outbound", text: m.text })),
      inboundText: tweet.text,
      inboundAuthor: tweet.author,
    });
    if (!turn.ok) continue;

    const batch = await buildTurnBatch(env, {
      userId, relayId, conv, turn, tweet, turnCount, nowSec,
    });
    await env.DB.batch(batch);
    turns++;
  }

  return { conversations, turns, skipped };
}

async function buildTurnBatch(
  env: Env,
  opts: {
    userId: string;
    relayId: string;
    conv: ConversationRow;
    turn: { text: string; verdict: string; reason: string };
    tweet: InboundTweet;
    turnCount: number;
    nowSec: number;
  },
): Promise<D1PreparedStatement[]> {
  const { userId, relayId, conv, turn, tweet, turnCount, nowSec } = opts;
  const batch: D1PreparedStatement[] = [
    env.DB.prepare(
      "INSERT INTO messages (id, conversation_id, user_id, role, tweet_id, author, text, created_at) VALUES (?, ?, ?, 'inbound', ?, ?, ?, ?)",
    ).bind(crypto.randomUUID(), conv.id, userId, tweet.id, tweet.author, tweet.text, nowSec),
    env.DB.prepare("INSERT OR IGNORE INTO dedup (user_id, relay_id, tweet_id, action, acted_at) VALUES (?, ?, ?, 'reply', ?)")
      .bind(userId, relayId, tweet.id, nowSec),
  ];

  if (turn.verdict !== "close_silent") {
    const draftResult = await draftInsert(env.DB, {
      userId,
      relayId,
      conversationId: conv.id,
      targetTweetId: tweet.id,
      action: "reply",
      reason: turn.reason,
      priority: turn.verdict === "close_with_message" ? 5 : 3,
      status: "ready",
      text: turn.text,
      createdAt: nowSec,
    }).run();
    const draftRowId = draftResult.meta.last_row_id;
    const commandId = crypto.randomUUID();

    batch.push(
      env.DB.prepare(
        "INSERT INTO messages (id, conversation_id, user_id, role, tweet_id, author, text, draft_id, created_at) VALUES (?, ?, ?, 'outbound', NULL, '', ?, ?, ?)",
      ).bind(crypto.randomUUID(), conv.id, userId, String(draftRowId), draftRowId, nowSec),
      commandInsert(env.DB, commandId, relayId, "reply", JSON.stringify({
        draft_id: String(draftRowId),
        in_reply_to_tweet_id: tweet.id,
        text: turn.text,
      }), nowSec),
      env.DB.prepare("UPDATE drafts SET status = 'executing', command_id = ? WHERE id = ?")
        .bind(commandId, draftRowId),
    );
  }

  batch.push(
    env.DB.prepare("UPDATE conversations SET turn_count = ?, last_turn_at = ? WHERE id = ?")
      .bind(turnCount, nowSec, conv.id),
  );

  if (turn.verdict === "close_with_message" || turn.verdict === "close_silent") {
    batch.push(
      env.DB.prepare("UPDATE conversations SET status = 'closed', closed_reason = ?, closed_at = ? WHERE id = ?")
        .bind(turn.reason, nowSec, conv.id),
    );
  }

  return batch;
}

// Close conversations inactive beyond their timeout.
export async function conversationSweeper(env: Env): Promise<number> {
  const nowSec = nowSeconds();
  const open = (await env.DB.prepare(
    `SELECT c.id, c.last_turn_at, COALESCE(s.inactivity_minutes, ?) AS timeout
     FROM conversations c
     LEFT JOIN conversation_settings s ON s.user_id = c.user_id
     WHERE c.status = 'open'`,
  )
    .bind(CONVERSATION_DEFAULTS.inactivity_minutes)
    .all()) as unknown as { results: Array<{ id: string; last_turn_at: number; timeout: number }> };

  const stale = open.results.filter(
    (c) => nowSec - c.last_turn_at > c.timeout * 60,
  );
  if (stale.length === 0) return 0;

  const statements = stale.map((c) =>
    env.DB.prepare(
      "UPDATE conversations SET status = 'closed', closed_reason = 'inactivity', closed_at = ? WHERE id = ? AND status = 'open'",
    ).bind(nowSec, c.id),
  );
  await env.DB.batch(statements);
  return stale.length;
}

export async function updateConversationMessageTweetId(
  db: D1Database,
  draftId: string,
  tweetId: string,
): Promise<void> {
  await db
    .prepare("UPDATE messages SET tweet_id = ? WHERE draft_id = ? AND role = 'outbound'")
    .bind(tweetId, draftId)
    .run();
}
