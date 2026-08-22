import { describe, expect, it } from "vitest";
import { Miniflare } from "miniflare";
import { MAINT_CRON, TICK_CRON, runScheduled } from "../src/scheduled";
import {
  bearerHeaders,
  createAndPair,
  makeWorker,
  nowSeconds,
  pollCommands,
  userHeaders,
} from "./harness";

async function createSchedule(
  mf: Miniflare,
  relayId: string,
  overrides: Record<string, unknown> = {},
  email = "alice@example.com",
): Promise<{ schedule_id: string; next_run_at: number }> {
  const res = await mf.dispatchFetch("http://localhost/api/schedules", {
    method: "POST",
    headers: userHeaders(email),
    body: JSON.stringify({ relay_id: relayId, ...overrides }),
  });
  expect(res.status).toBe(201);
  return (await res.json()) as { schedule_id: string; next_run_at: number };
}

async function poll(mf: Miniflare, relayId: string, token: string): Promise<unknown[]> {
  return (await pollCommands(mf, relayId, token)) as unknown[];
}

describe("schedule API", () => {
  it("requires authentication", async () => {
    const mf = await makeWorker();
    try {
      const res = await mf.dispatchFetch("http://localhost/api/schedules", { method: "POST" });
      expect(res.status).toBe(401);
    } finally {
      await mf.dispose();
    }
  });

  it("rejects a schedule for another user's relay", async () => {
    const mf = await makeWorker();
    try {
      const { relay_id } = await createAndPair(mf, "alice-relay", "alice@example.com");
      const res = await mf.dispatchFetch("http://localhost/api/schedules", {
        method: "POST",
        headers: userHeaders("bob@example.com"),
        body: JSON.stringify({ relay_id }),
      });
      expect(res.status).toBe(404);
    } finally {
      await mf.dispose();
    }
  });

  it("creates a schedule with a future next_run_at and lists it", async () => {
    const mf = await makeWorker();
    try {
      const { relay_id } = await createAndPair(mf, "alice-relay", "alice@example.com");
      const { schedule_id, next_run_at } = await createSchedule(mf, relay_id, {
        name: "daily echo",
        interval_minutes: 1440,
        timezone: "America/New_York",
        payload: { message: "good morning" },
      });
      expect(schedule_id).toMatch(/^[0-9a-f-]{36}$/);
      expect(next_run_at).toBeGreaterThan(nowSeconds());

      const list = await mf.dispatchFetch("http://localhost/api/schedules", {
        headers: userHeaders("alice@example.com", false),
      });
      expect(list.status).toBe(200);
      const body = (await list.json()) as {
        schedules: Array<{ id: string; status: string; interval_minutes: number; timezone: string }>;
      };
      expect(body.schedules).toHaveLength(1);
      expect(body.schedules[0].id).toBe(schedule_id);
      expect(body.schedules[0].status).toBe("active");
      expect(body.schedules[0].interval_minutes).toBe(1440);
      expect(body.schedules[0].timezone).toBe("America/New_York");
    } finally {
      await mf.dispose();
    }
  });

  it("rejects an invalid timezone", async () => {
    const mf = await makeWorker();
    try {
      const { relay_id } = await createAndPair(mf, "alice-relay", "alice@example.com");
      const res = await mf.dispatchFetch("http://localhost/api/schedules", {
        method: "POST",
        headers: userHeaders(),
        body: JSON.stringify({ relay_id, timezone: "Mars/Olympus" }),
      });
      expect(res.status).toBe(400);
    } finally {
      await mf.dispose();
    }
  });
});

describe("tick scheduler", () => {
  it("does not fire a schedule that is not yet due", async () => {
    const mf = await makeWorker();
    try {
      const { relay_id, token } = await createAndPair(mf, "alice-relay", "alice@example.com");
      await createSchedule(mf, relay_id, { interval_minutes: 1440, timezone: "UTC" });

      await runScheduled({ cron: TICK_CRON }, { DB: await mf.getD1Database("DB") });

      expect(await poll(mf, relay_id, token)).toHaveLength(0);
    } finally {
      await mf.dispose();
    }
  });

  it("fans out due jobs, enqueues commands, and recomputes next_run_at", async () => {
    const mf = await makeWorker();
    try {
      const { relay_id, token } = await createAndPair(mf, "alice-relay", "alice@example.com");
      const { schedule_id } = await createSchedule(mf, relay_id, {
        interval_minutes: 60,
        timezone: "UTC",
        payload: { message: "from the tick" },
      });

      // Age the schedule so the next tick considers it due.
      const db = await mf.getD1Database("DB");
      await db.prepare("UPDATE schedules SET next_run_at = ? WHERE id = ?").bind(0, schedule_id).run();
      await runScheduled({ cron: TICK_CRON }, { DB: db });

      const queued = await poll(mf, relay_id, token);
      expect(queued).toHaveLength(1);
      expect((queued[0] as { type: string }).type).toBe("echo");
      expect((queued[0] as { payload: unknown }).payload).toEqual({ message: "from the tick" });

      const row = (await db.prepare("SELECT next_run_at FROM schedules WHERE id = ?").bind(schedule_id).first()) as {
        next_run_at: number;
      };
      expect(row.next_run_at).toBeGreaterThan(nowSeconds());
    } finally {
      await mf.dispose();
    }
  });

  it("skips paused schedules", async () => {
    const mf = await makeWorker();
    try {
      const { relay_id, token } = await createAndPair(mf, "alice-relay", "alice@example.com");
      const { schedule_id } = await createSchedule(mf, relay_id, { interval_minutes: 60, timezone: "UTC" });

      const db = await mf.getD1Database("DB");
      await db
        .prepare("UPDATE schedules SET status = 'paused', next_run_at = ? WHERE id = ?")
        .bind(0, schedule_id)
        .run();
      await runScheduled({ cron: TICK_CRON }, { DB: db });

      expect(await poll(mf, relay_id, token)).toHaveLength(0);
    } finally {
      await mf.dispose();
    }
  });

  it("runs the end-to-end demo", async () => {
    const mf = await makeWorker();
    try {
      const { relay_id, token } = await createAndPair(mf, "alice-relay", "alice@example.com");
      const { schedule_id } = await createSchedule(mf, relay_id, {
        interval_minutes: 60,
        timezone: "UTC",
        payload: { message: "hello from cron" },
      });

      const db = await mf.getD1Database("DB");
      await db.prepare("UPDATE schedules SET next_run_at = ? WHERE id = ?").bind(0, schedule_id).run();
      await runScheduled({ cron: TICK_CRON }, { DB: db });

      // 1. The tick enqueued a command. 2. The relay picks it up.
      const queued = await poll(mf, relay_id, token);
      expect(queued).toHaveLength(1);
      const commandId = (queued[0] as { id: string }).id;

      // 3. The relay executes (echo) and reports the result.
      const reported = await mf.dispatchFetch(`http://localhost/api/relays/${relay_id}/results`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({
          results: [{ command_id: commandId, ok: true, output: { echoed: "hello from cron" } }],
        }),
      });
      expect(reported.status).toBe(200);

      // 4. The dashboard reflects the recorded result.
      const dash = await mf.dispatchFetch("http://localhost/api/relays/dashboard", {
        headers: userHeaders("alice@example.com", false),
      });
      const body = (await dash.json()) as { relays: { queued: number; done: number; failed: number }[] };
      expect(body.relays[0].queued).toBe(0);
      expect(body.relays[0].done).toBe(1);
      expect(body.relays[0].failed).toBe(0);
    } finally {
      await mf.dispose();
    }
  });

  it("maintenance sweeps stale claims but leaves pending commands queued", async () => {
    const mf = await makeWorker();
    try {
      const db = await mf.getD1Database("DB");
      const stale = nowSeconds() - 3 * 3600;
      await db
        .prepare(
          "INSERT INTO commands (id, relay_id, type, payload, status, attempts, created_at, claimed_at) VALUES (?, ?, 'echo', '{}', 'in_flight', 1, ?, ?)",
        )
        .bind("stale-1", "relay-dead", stale, stale)
        .run();
      await db
        .prepare(
          "INSERT INTO commands (id, relay_id, type, payload, status, attempts, created_at) VALUES (?, ?, 'echo', '{}', 'pending', 0, ?)",
        )
        .bind("pending-1", "relay-offline", stale)
        .run();

      await runScheduled({ cron: MAINT_CRON }, { DB: db });

      const failed = (await db.prepare("SELECT status, completed_at FROM commands WHERE id = ?").bind("stale-1").first()) as {
        status: string;
        completed_at: number;
      };
      expect(failed.status).toBe("failed");
      expect(failed.completed_at).toBeGreaterThan(0);

      const pending = (await db.prepare("SELECT status FROM commands WHERE id = ?").bind("pending-1").first()) as {
        status: string;
      };
      expect(pending.status).toBe("pending");
    } finally {
      await mf.dispose();
    }
  });
});