import type { Env } from "./types";
import { nowSeconds } from "./lib/crypto";
import { addIntervalInZone } from "./lib/time";

export const TICK_CRON = "* * * * *";
export const MAINT_CRON = "0 * * * *";

const MAX_TICK_BATCH = 40; // 40 jobs x 2 statements stays under D1's 100-statement batch limit
const STALE_CLAIM_MS = 2 * 60 * 60 * 1000;

type DueSchedule = {
  id: string;
  relay_id: string;
  type: string;
  payload: string;
  interval_minutes: number;
  timezone: string;
};

// Fan out every due job inline: enqueue one command per due schedule and
// recompute the schedule's next_run_at in the user's timezone.
export async function tick(env: Env): Promise<number> {
  const nowMs = Date.now();
  const nowSec = Math.floor(nowMs / 1000);
  const due = (await env.DB.prepare(
    "SELECT id, relay_id, type, payload, interval_minutes, timezone, next_run_at FROM schedules WHERE status = 'active' AND next_run_at <= ? ORDER BY next_run_at ASC LIMIT ?",
  )
    .bind(nowSec, MAX_TICK_BATCH)
    .all()) as unknown as { results: (DueSchedule & { next_run_at: number })[] };

  const statements: D1PreparedStatement[] = [];
  for (const s of due.results) {
    // Anchor the next slot to the job's own cadence; if several intervals were
    // missed, fall back to the next slot after now rather than storming through.
    let nextMs = addIntervalInZone(s.next_run_at * 1000, s.interval_minutes, s.timezone);
    if (nextMs < nowMs) nextMs = addIntervalInZone(nowMs, s.interval_minutes, s.timezone);
    statements.push(
      env.DB.prepare("UPDATE schedules SET next_run_at = ?, last_run_at = ? WHERE id = ?").bind(
        Math.floor(nextMs / 1000),
        nowSec,
        s.id,
      ),
      env.DB.prepare(
        "INSERT INTO commands (id, relay_id, type, payload, status, attempts, created_at) VALUES (?, ?, ?, ?, 'pending', 0, ?)",
      ).bind(crypto.randomUUID(), s.relay_id, s.type, s.payload, nowSec),
    );
  }
  if (statements.length > 0) await env.DB.batch(statements);
  return due.results.length;
}

// Hourly sweep: fail commands a relay claimed but never reported for hours.
// Pending commands are preserved (offline queue-and-catch-up). Conversation
// timeouts join here once the conversations table lands (ticket 11+).
export async function maintenance(env: Env): Promise<number> {
  const now = nowSeconds();
  const staleCutoff = Math.floor((Date.now() - STALE_CLAIM_MS) / 1000);
  const result = await env.DB.prepare(
    "UPDATE commands SET status = 'failed', result = ?, completed_at = ? WHERE status = 'in_flight' AND claimed_at < ?",
  )
    .bind(JSON.stringify({ error: "stale claim swept by maintenance" }), now, staleCutoff)
    .run();
  return result.meta.changes;
}

// Entry point for the Worker's scheduled handler; routes each cron slot.
export async function runScheduled(controller: { cron: string | null }, env: Env): Promise<void> {
  switch (controller.cron) {
    case TICK_CRON:
      await tick(env);
      break;
    case MAINT_CRON:
      await maintenance(env);
      break;
  }
}