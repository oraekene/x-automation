import type { ConversationRow, ConversationSettingsRow, Env } from "../types";
import { commandInsert } from "./command";
import { nowSeconds } from "./crypto";
import { draftInsert } from "./drafts";
import { draftTurn } from "./ai";
import { safeParse } from "./json";
import { zoneOffsetMs } from "./time";

const DEFAULT_MAX_TURNS = 5;
const MAX_TURNS_CAP = 8;
const DEFAULT_DAILY_NEW_CAP = 10;
const DEFAULT_INACTIVITY_MINUTES = 1440;

type InboundTweet = {
  id: string;
  author: string;
  text: string;
  in_reply_to_tweet_id: string | null;
};

function getSettings(row: ConversationSettingsRow | undefined): {
  max_turns: number;
  inactivity_minutes: number;
  daily_new_cap: number;
  quiet_hours: { start: string; end: string } | null;
  timezone: string;
} {
  return {
    max_turns: Math.min(MAX_TURNS_CAP, row?.max_turns ?? DEFAULT_MAX_TURNS),
    inactivity_minutes: row?.inactivity_minutes ?? DEFAULT_INACTIVITY_MINUTES,
    daily_new_cap: row?.daily_new_cap ?? DEFAULT_DAILY_NEW_CAP,
    quiet_hours: row?.quiet_hours ? JSON.parse(row.quiet_hours) : null,
    timezone: row?.timezone ?? "UTC",
  };
}

// Enqueue an inbound_scan command for each relay that has open conversations.
// Relays without open conversations are only scanned on user-initiated request
// (POST /api/conversations/scan), not every tick.
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

// Process inbound tweets from an inbound_scan result. Dedup, find/create
// conversation, check deterministic caps, call AI for semantic verdict, write
// inbound + outbound messages + draft + reply command.
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

  // Update last_inbound_scan_at so hourly scan gating works.
  await env.DB.prepare("UPDATE relays SET last_inbound_scan_at = ? WHERE id = ?")
    .bind(nowSec, relayId)
    .run();

  for (const tweet of tweets) {
    // Dedup: skip if this tweet was already processed.
    const existing = await env.DB.prepare("SELECT 1 FROM messages WHERE user_id = ? AND tweet_id = ?")
      .bind(userId, tweet.id)
      .first();
    if (existing) { skipped++; continue; }

    // Only handle replies (threads where the user is involved).
    if (!tweet.in_reply_to_tweet_id) { skipped++; continue; }

    // Find existing conversation by tracing to root: check if the replied-to
    // tweet_id is already in our messages table (meaning we have a conversation
    // for this thread).
    const parentMsg = (await env.DB.prepare(
      "SELECT conversation_id FROM messages WHERE user_id = ? AND tweet_id = ?",
    )
      .bind(userId, tweet.in_reply_to_tweet_id)
      .first()) as { conversation_id: string } | undefined;

    let conv: ConversationRow;
    if (parentMsg) {
      conv = (await env.DB.prepare("SELECT * FROM conversations WHERE id = ?")
        .bind(parentMsg.conversation_id)
        .first()) as ConversationRow;
      if (conv.status !== "open") { skipped++; continue; }
    } else {
      // New conversation.
      const convId = crypto.randomUUID();
      await env.DB.prepare(
        "INSERT INTO conversations (id, user_id, relay_id, peer, root_tweet_id, last_turn_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
        .bind(convId, userId, relayId, tweet.author, tweet.in_reply_to_tweet_id, nowSec, nowSec)
        .run();
      conv = (await env.DB.prepare("SELECT * FROM conversations WHERE id = ?")
        .bind(convId)
        .first()) as ConversationRow;
      conversations++;
    }

    // Deterministic checks.
    const settings = (await env.DB.prepare("SELECT * FROM conversation_settings WHERE user_id = ?")
      .bind(userId)
      .first()) as ConversationSettingsRow | undefined;
    const s = getSettings(settings);

    // Increment turn_count for existing conversations before checking caps.
    const isNewConversation = !parentMsg;
    if (!isNewConversation) {
      conv.turn_count += 1;
    }

    if (conv.turn_count >= s.max_turns) continue;

    const todayStart = Math.floor(new Date(nowSec * 1000).setUTCHours(0, 0, 0, 0) / 1000);
    const dailyCount = (await env.DB.prepare(
      "SELECT COUNT(*) as cnt FROM conversations WHERE user_id = ? AND created_at >= ?",
    )
      .bind(userId, todayStart)
      .first()) as { cnt: number };
    if (dailyCount.cnt >= s.daily_new_cap && conversations === 0) continue;

    if (s.quiet_hours) {
      const nowMs = nowSec * 1000;
      const localMs = nowMs + zoneOffsetMs(s.timezone, nowMs);
      const MS_PER_DAY = 86_400_000;
      const minuteOfDay = Math.floor((localMs % MS_PER_DAY) / 60_000);
      const toMin = (hhmm: string) => { const [h, m] = hhmm.split(":").map(Number); return h * 60 + m; };
      const start = toMin(s.quiet_hours.start);
      const end = toMin(s.quiet_hours.end);
      const inQH = start <= end
        ? minuteOfDay >= start && minuteOfDay < end
        : minuteOfDay >= start || minuteOfDay < end;
      if (inQH) continue;
    }

    // Fetch conversation context for the AI call.
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

    const inboundMsgId = crypto.randomUUID();
    const commandId = crypto.randomUUID();
    const targetTweetId = tweet.id;

    const batch: D1PreparedStatement[] = [
      env.DB.prepare(
        "INSERT INTO messages (id, conversation_id, user_id, role, tweet_id, author, text, created_at) VALUES (?, ?, ?, 'inbound', ?, ?, ?, ?)",
      ).bind(inboundMsgId, conv.id, userId, tweet.id, tweet.author, tweet.text, nowSec),
      env.DB.prepare("INSERT OR IGNORE INTO dedup (user_id, relay_id, tweet_id, action, acted_at) VALUES (?, ?, ?, 'reply', ?)")
        .bind(userId, relayId, tweet.id, nowSec),
    ];

    // Only reply if the verdict is not close_silent.
    if (turn.verdict !== "close_silent") {
      const outboundMsgId = crypto.randomUUID();

      // Insert the draft first to get its autoincrement id.
      const draftResult = await draftInsert(env.DB, {
        userId,
        relayId,
        conversationId: conv.id,
        targetTweetId,
        action: "reply",
        reason: turn.reason,
        priority: turn.verdict === "close_with_message" ? 5 : 3,
        status: "ready",
        text: turn.text,
        createdAt: nowSec,
      }).run();
      const draftRowId = draftResult.meta.last_row_id;

      batch.push(
        env.DB.prepare(
          "INSERT INTO messages (id, conversation_id, user_id, role, tweet_id, author, text, draft_id, created_at) VALUES (?, ?, ?, 'outbound', NULL, '', ?, ?, ?)",
        ).bind(outboundMsgId, conv.id, userId, String(draftRowId), draftRowId, nowSec),
        commandInsert(env.DB, commandId, relayId, "reply", JSON.stringify({
          draft_id: String(draftRowId),
          in_reply_to_tweet_id: tweet.id,
          text: turn.text,
        }), nowSec),
        env.DB.prepare("UPDATE drafts SET status = 'executing', command_id = ? WHERE id = ?")
          .bind(commandId, draftRowId),
      );
    }

    // Always update last_turn_at and persist turn_count for existing conversations.
    batch.push(
      env.DB.prepare(
        "UPDATE conversations SET turn_count = ?, last_turn_at = ? WHERE id = ?",
      ).bind(conv.turn_count, nowSec, conv.id),
    );

    if (turn.verdict === "close_with_message" || turn.verdict === "close_silent") {
      batch.push(
        env.DB.prepare(
          "UPDATE conversations SET status = 'closed', closed_reason = ?, closed_at = ? WHERE id = ?",
        ).bind(turn.reason, nowSec, conv.id),
      );
    }

    await env.DB.batch(batch);
    turns++;
  }

  return { conversations, turns, skipped };
}

// Close conversations that have been inactive longer than their timeout.
export async function conversationSweeper(env: Env): Promise<number> {
  const nowSec = nowSeconds();
  const open = (await env.DB.prepare(
    `SELECT c.id, c.last_turn_at, COALESCE(s.inactivity_minutes, ?) AS timeout
     FROM conversations c
     LEFT JOIN conversation_settings s ON s.user_id = c.user_id
     WHERE c.status = 'open'`,
  )
    .bind(DEFAULT_INACTIVITY_MINUTES)
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

// After a draft with a conversation_id completes, fill in the outbound
// message's tweet_id so the dashboard shows the posted reply.
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
