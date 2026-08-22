import { Hono } from "hono";
import type { Env, ScheduleRow } from "../types";
import { nowSeconds } from "../lib/crypto";
import { addIntervalInZone, coerceIntervalMinutes, isValidTimeZone } from "../lib/time";
import { safeParse } from "../lib/json";
import { relayOwnedBy } from "../lib/ownership";
import { getUser } from "../auth";

export const scheduleRoutes = new Hono<{ Bindings: Env }>();

scheduleRoutes.post("/", async (c) => {
  const user = await getUser(c);
  if (!user) return c.json({ error: "unauthorized" }, 401);
  const body = (await c.req.json().catch(() => ({}))) as {
    relay_id?: string;
    name?: string;
    type?: string;
    payload?: unknown;
    mode?: string;
    interval_minutes?: number;
    scheduled_at?: number;
    timezone?: string;
  };
  if (!body.relay_id) return c.json({ error: "relay_id required" }, 400);
  if (!(await relayOwnedBy(c.env.DB, body.relay_id, user.id))) {
    return c.json({ error: "not found" }, 404);
  }
  const mode = body.mode === "one_off" ? "one_off" : "recurring";
  const timezone = body.timezone ?? "UTC";
  if (!isValidTimeZone(timezone)) return c.json({ error: "invalid timezone" }, 400);

  const nowSec = nowSeconds();
  let intervalMinutes: number;
  let nextRunAt: number;

  if (mode === "one_off") {
    if (!body.scheduled_at || body.scheduled_at <= nowSec) {
      return c.json({ error: "scheduled_at must be a future epoch seconds" }, 400);
    }
    intervalMinutes = 1; // tick checks next_run_at, so interval is irrelevant for one-off
    nextRunAt = body.scheduled_at;
  } else {
    const interval = coerceIntervalMinutes(body.interval_minutes);
    if (!interval.ok) return c.json({ error: "interval_minutes must be at least 1" }, 400);
    intervalMinutes = interval.minutes;
    nextRunAt = Math.floor(addIntervalInZone(Date.now(), interval.minutes, timezone) / 1000);
  }

  const id = crypto.randomUUID();
  await c.env.DB.prepare(
    `INSERT INTO schedules (id, user_id, relay_id, name, type, payload, status, mode, interval_minutes, timezone, next_run_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, ?)`,
  )
    .bind(
      id,
      user.id,
      body.relay_id,
      body.name ?? "schedule",
      body.type ?? "echo",
      JSON.stringify(body.payload ?? {}),
      mode,
      intervalMinutes,
      timezone,
      nextRunAt,
      nowSec,
    )
    .run();
  return c.json({ schedule_id: id, next_run_at: nextRunAt, mode }, 201);
});

scheduleRoutes.get("/", async (c) => {
  const user = await getUser(c);
  if (!user) return c.json({ error: "unauthorized" }, 401);
  const rows = await c.env.DB.prepare(
    "SELECT * FROM schedules WHERE user_id = ? ORDER BY created_at DESC",
  )
    .bind(user.id)
    .all() as unknown as { results: ScheduleRow[] };
  return c.json({
    schedules: rows.results.map((r) => ({
      id: r.id,
      relay_id: r.relay_id,
      name: r.name,
      type: r.type,
      payload: safeParse(r.payload),
      status: r.status,
      mode: (r as ScheduleRow & { mode?: string }).mode ?? "recurring",
      interval_minutes: r.interval_minutes,
      timezone: r.timezone,
      next_run_at: r.next_run_at,
      last_run_at: r.last_run_at,
      created_at: r.created_at,
    })),
  });
});

scheduleRoutes.delete("/:id", async (c) => {
  const user = await getUser(c);
  if (!user) return c.json({ error: "unauthorized" }, 401);
  const id = c.req.param("id");
  const result = await c.env.DB.prepare(
    "UPDATE schedules SET status = 'cancelled' WHERE id = ? AND user_id = ? AND status = 'active'",
  )
    .bind(id, user.id)
    .run();
  if (result.meta.changes === 0) return c.json({ error: "not found or already cancelled" }, 404);
  return c.json({ ok: true });
});