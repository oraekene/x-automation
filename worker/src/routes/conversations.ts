// Ticket 12: conversation routes. GET/PUT conversation settings; list
// conversations and view individual conversation threads.

import { Hono } from "hono";
import type { Env, ConversationRow, ConversationSettingsRow, MessageRow } from "../types";
import { getUser } from "../auth";
import { nowSeconds } from "../lib/crypto";
import { isValidTimeZone } from "../lib/time";

export const conversationRoutes = new Hono<{ Bindings: Env }>();

const MAX_TURNS_CAP = 8;
const MAX_INACTIVITY = 10080; // 7 days
const MAX_DAILY_NEW_CAP = 50;

conversationRoutes.get("/", async (c) => {
  const user = await getUser(c);
  if (!user) return c.json({ error: "unauthorized" }, 401);
  const rows = (await c.env.DB.prepare(
    `SELECT c.*, r.name AS relay_name
     FROM conversations c
     LEFT JOIN relays r ON r.id = c.relay_id
     WHERE c.user_id = ?
     ORDER BY c.created_at DESC
     LIMIT 100`,
  )
    .bind(user.id)
    .all()) as unknown as { results: Array<ConversationRow & { relay_name: string }> };
  return c.json({
    conversations: rows.results.map((r) => ({
      id: r.id,
      relay_id: r.relay_id,
      relay_name: r.relay_name,
      peer: r.peer,
      root_tweet_id: r.root_tweet_id,
      status: r.status,
      turn_count: r.turn_count,
      closed_reason: r.closed_reason,
      closed_at: r.closed_at,
      last_turn_at: r.last_turn_at,
      created_at: r.created_at,
    })),
  });
});

conversationRoutes.get("/:id", async (c) => {
  const user = await getUser(c);
  if (!user) return c.json({ error: "unauthorized" }, 401);
  const conv = (await c.env.DB.prepare(
    "SELECT * FROM conversations WHERE id = ? AND user_id = ?",
  )
    .bind(c.req.param("id"), user.id)
    .first()) as ConversationRow | undefined;
  if (!conv) return c.json({ error: "not found" }, 404);

  const messages = (await c.env.DB.prepare(
    "SELECT * FROM messages WHERE conversation_id = ? ORDER BY created_at ASC",
  )
    .bind(conv.id)
    .all()) as unknown as { results: MessageRow[] };

  return c.json({
    conversation: {
      id: conv.id,
      peer: conv.peer,
      root_tweet_id: conv.root_tweet_id,
      status: conv.status,
      turn_count: conv.turn_count,
      closed_reason: conv.closed_reason,
      closed_at: conv.closed_at,
      last_turn_at: conv.last_turn_at,
      created_at: conv.created_at,
    },
    messages: messages.results.map((m) => ({
      id: m.id,
      role: m.role,
      tweet_id: m.tweet_id,
      author: m.author,
      text: m.text,
      draft_id: m.draft_id,
      created_at: m.created_at,
    })),
  });
});

conversationRoutes.get("/settings/meta", async (c) => {
  const user = await getUser(c);
  if (!user) return c.json({ error: "unauthorized" }, 401);
  const row = (await c.env.DB.prepare("SELECT * FROM conversation_settings WHERE user_id = ?")
    .bind(user.id)
    .first()) as ConversationSettingsRow | undefined;
  return c.json({
    settings: {
      max_turns: row?.max_turns ?? 5,
      inactivity_minutes: row?.inactivity_minutes ?? 1440,
      daily_new_cap: row?.daily_new_cap ?? 10,
      quiet_hours: row?.quiet_hours ? JSON.parse(row.quiet_hours) : null,
      timezone: row?.timezone ?? "UTC",
    },
  });
});

conversationRoutes.put("/settings", async (c) => {
  const user = await getUser(c);
  if (!user) return c.json({ error: "unauthorized" }, 401);
  const body = (await c.req.json().catch(() => ({}))) as {
    max_turns?: number;
    inactivity_minutes?: number;
    daily_new_cap?: number;
    quiet_hours?: { start: string; end: string } | null;
    timezone?: string;
  };

  const maxTurns = typeof body.max_turns === "number"
    ? Math.min(MAX_TURNS_CAP, Math.max(1, Math.round(body.max_turns)))
    : undefined;
  const inactivityMinutes = typeof body.inactivity_minutes === "number"
    ? Math.min(MAX_INACTIVITY, Math.max(1, Math.round(body.inactivity_minutes)))
    : undefined;
  const dailyNewCap = typeof body.daily_new_cap === "number"
    ? Math.min(MAX_DAILY_NEW_CAP, Math.max(1, Math.round(body.daily_new_cap)))
    : undefined;
  const timezone = typeof body.timezone === "string" && isValidTimeZone(body.timezone)
    ? body.timezone
    : undefined;

  let quietHours: string | undefined;
  if (body.quiet_hours === null) {
    quietHours = null as unknown as string;
  } else if (body.quiet_hours && typeof body.quiet_hours.start === "string" && typeof body.quiet_hours.end === "string") {
    quietHours = JSON.stringify(body.quiet_hours);
  }

  const existing = (await c.env.DB.prepare("SELECT * FROM conversation_settings WHERE user_id = ?")
    .bind(user.id)
    .first()) as ConversationSettingsRow | undefined;

  const nowSec = nowSeconds();
  if (!existing) {
    await c.env.DB.prepare(
      `INSERT INTO conversation_settings (user_id, max_turns, inactivity_minutes, daily_new_cap, quiet_hours, timezone, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(
        user.id,
        maxTurns ?? 5,
        inactivityMinutes ?? 1440,
        dailyNewCap ?? 10,
        quietHours ?? null,
        timezone ?? "UTC",
        nowSec,
      )
      .run();
  } else {
    await c.env.DB.prepare(
      `UPDATE conversation_settings
       SET max_turns = ?, inactivity_minutes = ?, daily_new_cap = ?, quiet_hours = ?, timezone = ?, updated_at = ?
       WHERE user_id = ?`,
    )
      .bind(
        maxTurns ?? existing.max_turns,
        inactivityMinutes ?? existing.inactivity_minutes,
        dailyNewCap ?? existing.daily_new_cap,
        quietHours !== undefined ? quietHours : existing.quiet_hours,
        timezone ?? existing.timezone,
        nowSec,
        user.id,
      )
      .run();
  }

  return c.json({ ok: true });
});
