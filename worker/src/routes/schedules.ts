import { Hono, type Context } from "hono";
import type { Env, ScheduleRow } from "../types";
import { nowSeconds } from "../lib/crypto";
import { DEFAULT_INTERVAL_MINUTES, addIntervalInZone, isValidTimeZone } from "../lib/time";
import { relayOwnedBy } from "../lib/ownership";
import { getUser } from "../auth";

type AppContext = Context<{ Bindings: Env }>;

export const scheduleRoutes = new Hono<{ Bindings: Env }>();

function safeParse(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return {};
  }
}

scheduleRoutes.post("/", async (c) => {
  const user = await getUser(c);
  if (!user) return c.json({ error: "unauthorized" }, 401);
  const body = (await c.req.json().catch(() => ({}))) as {
    relay_id?: string;
    name?: string;
    type?: string;
    payload?: unknown;
    interval_minutes?: number;
    timezone?: string;
  };
  if (!body.relay_id) return c.json({ error: "relay_id required" }, 400);
  if (!(await relayOwnedBy(c.env.DB, body.relay_id, user.id))) {
    return c.json({ error: "not found" }, 404);
  }
  const interval =
    typeof body.interval_minutes === "number" ? Math.floor(body.interval_minutes) : DEFAULT_INTERVAL_MINUTES;
  if (!(interval >= 1)) return c.json({ error: "interval_minutes must be at least 1" }, 400);
  const timezone = body.timezone ?? "UTC";
  if (!isValidTimeZone(timezone)) return c.json({ error: "invalid timezone" }, 400);

  const nowSec = nowSeconds();
  const nextRunAt = Math.floor(addIntervalInZone(Date.now(), interval, timezone) / 1000);
  const id = crypto.randomUUID();
  await c.env.DB.prepare(
    `INSERT INTO schedules (id, user_id, relay_id, name, type, payload, status, interval_minutes, timezone, next_run_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?)`,
  )
    .bind(
      id,
      user.id,
      body.relay_id,
      body.name ?? "schedule",
      body.type ?? "echo",
      JSON.stringify(body.payload ?? {}),
      interval,
      timezone,
      nextRunAt,
      nowSec,
    )
    .run();
  return c.json({ schedule_id: id, next_run_at: nextRunAt }, 201);
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
      interval_minutes: r.interval_minutes,
      timezone: r.timezone,
      next_run_at: r.next_run_at,
      last_run_at: r.last_run_at,
      created_at: r.created_at,
    })),
  });
});