import type { DueAutomationRow, DueScheduleRow, Env, SearchCriteria, TargetingProfile } from "./types";
import { nowSeconds } from "./lib/crypto";
import { commandInsert } from "./lib/command";
import { safeParse } from "./lib/json";
import { addIntervalInZone } from "./lib/time";
import { runTargeting } from "./lib/target";

export const TICK_CRON = "* * * * *";
export const MAINT_CRON = "0 * * * *";

const MAX_TICK_BATCH = 40; // 40 jobs x 2 statements stays under D1's 100-statement batch limit
const MAX_AUTOMATION_BATCH = 20; // 20 automations x 3 statements per batch
const STALE_CLAIM_MS = 2 * 60 * 60 * 1000;
const MAX_AI_RETRY = 50; // bound the hourly AI sweep so free endpoints aren't hammered

// Funnel pass caps: search walks up to 3 pages; the profile pass pulls recent
// tweets from up to 3 matched profiles, one page each. Kept small so a single
// tick stays well within free-tier request budgets.
const MAX_SEARCH_PAGES = 3;
const MAX_PROFILES = 3;

type DueJob = {
  id: string;
  interval_minutes: number;
  timezone: string;
  next_run_at: number;
};

// Address the next slot to the job's own cadence; if several intervals were
// missed, fall back to the next slot after now rather than storming through.
function nextSlotMs(nextRunAtMs: number, intervalMinutes: number, timezone: string, nowMs: number): number {
  let nextMs = addIntervalInZone(nextRunAtMs, intervalMinutes, timezone);
  if (nextMs < nowMs) nextMs = addIntervalInZone(nowMs, intervalMinutes, timezone);
  return nextMs;
}

// Shared due-job fan-out: update each job's next_run_at/last_run_at and batch
// whatever commands the job's producer enqueues, in one D1 batch per table.
async function fanOutDue<T extends DueJob>(
  env: Env,
  table: "schedules" | "automations",
  jobs: T[],
  makeCommands: (job: T, nextRunAt: number, nowSec: number) => D1PreparedStatement[],
): Promise<number> {
  const nowMs = Date.now();
  const nowSec = Math.floor(nowMs / 1000);
  const statements: D1PreparedStatement[] = [];
  for (const job of jobs) {
    const nextMs = nextSlotMs(job.next_run_at * 1000, job.interval_minutes, job.timezone, nowMs);
    statements.push(
      env.DB.prepare(`UPDATE ${table} SET next_run_at = ?, last_run_at = ? WHERE id = ?`).bind(
        Math.floor(nextMs / 1000),
        nowSec,
        job.id,
      ),
      ...makeCommands(job, Math.floor(nextMs / 1000), nowSec),
    );
  }
  if (statements.length > 0) await env.DB.batch(statements);
  return jobs.length;
}

// Fan out every due job inline: enqueue one command per due schedule and
// recompute the schedule's next_run_at in the user's timezone.
export async function tick(env: Env): Promise<number> {
  const nowSec = Math.floor(Date.now() / 1000);
  const due = (await env.DB.prepare(
    "SELECT id, relay_id, type, payload, interval_minutes, timezone, next_run_at FROM schedules WHERE status = 'active' AND next_run_at <= ? ORDER BY next_run_at ASC LIMIT ?",
  )
    .bind(nowSec, MAX_TICK_BATCH)
    .all()) as unknown as { results: DueScheduleRow[] };

  return fanOutDue(env, "schedules", due.results, (job, _next, now) => [
    commandInsert(env.DB, crypto.randomUUID(), job.relay_id, job.type, job.payload, now),
  ]);
}

// Fan out every due automation (Funnel Stage 1): one deterministic search
// command plus one profile-driven pass per automation. The relay executes
// both passes and reports results, which the results endpoint ingests into
// the candidate pool.
export async function tickAutomations(env: Env): Promise<number> {
  const nowSec = Math.floor(Date.now() / 1000);
  const due = (await env.DB.prepare(
    "SELECT id, relay_id, search_criteria, targeting, interval_minutes, timezone, next_run_at FROM automations WHERE status = 'active' AND next_run_at <= ? ORDER BY next_run_at ASC LIMIT ?",
  )
    .bind(nowSec, MAX_AUTOMATION_BATCH)
    .all()) as unknown as { results: DueAutomationRow[] };

  return fanOutDue(env, "automations", due.results, (job, _next, now) => {
    const criteria = safeParse(job.search_criteria) as SearchCriteria;
    const targeting = safeParse(job.targeting) as TargetingProfile;
    return [
      commandInsert(
        env.DB,
        crypto.randomUUID(),
        job.relay_id,
        "search",
        JSON.stringify({ automation_id: job.id, ...criteria, max_pages: MAX_SEARCH_PAGES }),
        now,
      ),
      commandInsert(
        env.DB,
        crypto.randomUUID(),
        job.relay_id,
        "profile_pass",
        JSON.stringify({
          automation_id: job.id,
          profile: targeting.profile ?? {},
          max_profiles: MAX_PROFILES,
          max_pages: 1,
        }),
        now,
      ),
    ];
  });
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

// Hourly AI targeting retry: re-run Funnel Stage 3 for every user with an
// active automation and a configured provider. Idempotent by construction —
// already-judged candidates are skipped — so this only retries failures. The
// cap is per user: one broken provider must not starve every other user's
// retries for the hour.
export async function retryAiTargeting(env: Env): Promise<number> {
  const users = (await env.DB.prepare(
    "SELECT DISTINCT user_id FROM automations WHERE status = 'active' ORDER BY user_id",
  ).all()) as unknown as { results: Array<{ user_id: string }> };

  let judged = 0;
  for (const u of users.results) {
    const result = await runTargeting(env, u.user_id, undefined, MAX_AI_RETRY);
    for (const s of result.summaries) judged += s.judged;
  }
  return judged;
}

// Entry point for the Worker's scheduled handler; routes each cron slot.
export async function runScheduled(controller: { cron: string | null }, env: Env): Promise<void> {
  switch (controller.cron) {
    case TICK_CRON:
      await tick(env);
      await tickAutomations(env);
      break;
    case MAINT_CRON:
      await maintenance(env);
      await retryAiTargeting(env);
      break;
  }
}