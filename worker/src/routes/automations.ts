import { Hono } from "hono";
import type { AutomationRow, Env, SearchCriteria, TargetingProfile } from "../types";
import { nowSeconds } from "../lib/crypto";
import { addIntervalInZone, coerceIntervalMinutes, isValidTimeZone } from "../lib/time";
import { safeParse } from "../lib/json";
import { relayOwnedBy } from "../lib/ownership";
import { getUser } from "../auth";

export const automationRoutes = new Hono<{ Bindings: Env }>();

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

// Validate the structured search criteria a deterministic pass runs on X.
function validSearchCriteria(raw: unknown): raw is SearchCriteria {
  if (typeof raw !== "object" || raw === null) return false;
  const c = raw as Record<string, unknown>;
  if (!Array.isArray(c.keywords) || c.keywords.length === 0 || c.keywords.some((k) => typeof k !== "string")) {
    return false;
  }
  for (const key of ["hashtags", "mentions"] as const) {
    if (c[key] !== undefined && (!Array.isArray(c[key]) || (c[key] as unknown[]).some((v) => typeof v !== "string"))) {
      return false;
    }
  }
  for (const key of ["min_faves", "min_retweets", "min_replies"] as const) {
    if (c[key] !== undefined && (typeof c[key] !== "number" || !(c[key] >= 0))) return false;
  }
  if (c.lang !== undefined && typeof c.lang !== "string") return false;
  for (const key of ["since", "until"] as const) {
    if (c[key] !== undefined && (typeof c[key] !== "string" || !DATE_ONLY.test(c[key]))) return false;
  }
  return true;
}

// Validate the targeting profile a profile pass runs on X: optional keywords
// (non-empty strings), a whole-number follower floor, and strict booleans.
function validTargetingProfile(raw: unknown): raw is TargetingProfile {
  if (typeof raw !== "object" || raw === null) return true;
  const t = raw as Record<string, unknown>;
  const profile = t.profile;
  if (profile === undefined || profile === null) return true;
  if (typeof profile !== "object") return false;
  const p = profile as Record<string, unknown>;
  if (p.keywords !== undefined && (!Array.isArray(p.keywords) || p.keywords.some((k) => typeof k !== "string"))) {
    return false;
  }
  if (
    p.min_followers !== undefined &&
    (typeof p.min_followers !== "number" || !Number.isFinite(p.min_followers) || p.min_followers < 0)
  ) {
    return false;
  }
  if (p.verified !== undefined && typeof p.verified !== "boolean") return false;
  if (p.location !== undefined && typeof p.location !== "string") return false;
  return true;
}

automationRoutes.post("/", async (c) => {
  const user = await getUser(c);
  if (!user) return c.json({ error: "unauthorized" }, 401);
  const body = (await c.req.json().catch(() => ({}))) as {
    relay_id?: string;
    name?: string;
    search_criteria?: unknown;
    targeting?: unknown;
    interval_minutes?: number;
    timezone?: string;
  };
  if (!body.relay_id) return c.json({ error: "relay_id required" }, 400);
  if (!(await relayOwnedBy(c.env.DB, body.relay_id, user.id))) {
    return c.json({ error: "not found" }, 404);
  }
  if (!validSearchCriteria(body.search_criteria)) {
    return c.json({ error: "search_criteria needs non-empty keywords and valid thresholds/time windows" }, 400);
  }
  if (body.targeting !== undefined && !validTargetingProfile(body.targeting)) {
    return c.json({ error: "targeting needs keywords, a whole-number follower floor, strict booleans and a string location" }, 400);
  }
  const interval = coerceIntervalMinutes(body.interval_minutes);
  if (!interval.ok) return c.json({ error: "interval_minutes must be at least 1" }, 400);
  const timezone = body.timezone ?? "UTC";
  if (!isValidTimeZone(timezone)) return c.json({ error: "invalid timezone" }, 400);

  const nowSec = nowSeconds();
  const nextRunAt = Math.floor(addIntervalInZone(Date.now(), interval.minutes, timezone) / 1000);
  const id = crypto.randomUUID();
  await c.env.DB.prepare(
    `INSERT INTO automations (id, user_id, relay_id, name, status, search_criteria, targeting, interval_minutes, timezone, next_run_at, created_at)
     VALUES (?, ?, ?, ?, 'active', ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      id,
      user.id,
      body.relay_id,
      body.name ?? "automation",
      JSON.stringify(body.search_criteria),
      JSON.stringify(body.targeting ?? {}),
      interval.minutes,
      timezone,
      nextRunAt,
      nowSec,
    )
    .run();
  return c.json({ automation_id: id, next_run_at: nextRunAt }, 201);
});

automationRoutes.get("/", async (c) => {
  const user = await getUser(c);
  if (!user) return c.json({ error: "unauthorized" }, 401);
  const rows = await c.env.DB.prepare(
    "SELECT * FROM automations WHERE user_id = ? ORDER BY created_at DESC",
  )
    .bind(user.id)
    .all() as unknown as { results: AutomationRow[] };
  return c.json({
    automations: rows.results.map((r) => ({
      id: r.id,
      relay_id: r.relay_id,
      name: r.name,
      status: r.status,
      search_criteria: safeParse(r.search_criteria),
      targeting: safeParse(r.targeting) as TargetingProfile,
      interval_minutes: r.interval_minutes,
      timezone: r.timezone,
      next_run_at: r.next_run_at,
      last_run_at: r.last_run_at,
      created_at: r.created_at,
    })),
  });
});
