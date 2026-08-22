import { describe, expect, it } from "vitest";
import { Miniflare } from "miniflare";
import { TICK_CRON, runScheduled } from "../src/scheduled";
import { startOfDayInZone } from "../src/lib/time";
import { createAndPair, makeWorker, nowSeconds, pollCommands, userHeaders } from "./harness";

const SEARCH_CRITERIA = { keywords: ["openai"], min_faves: 5, lang: "en" };

async function createAutomation(
  mf: Miniflare,
  relayId: string,
  overrides: Record<string, unknown> = {},
): Promise<{ automation_id: string }> {
  const res = await mf.dispatchFetch("http://localhost/api/automations", {
    method: "POST",
    headers: userHeaders(),
    body: JSON.stringify({ relay_id: relayId, search_criteria: SEARCH_CRITERIA, ...overrides }),
  });
  expect(res.status).toBe(201);
  return (await res.json()) as { automation_id: string };
}

function tweet(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    author: "bob",
    text: "hello " + id,
    created_at: "Mon Aug 03 09:00:00 +0000 2026",
    favorite_count: 3,
    retweet_count: 1,
    reply_count: 0,
    lang: "en",
    ...overrides,
  };
}

// Tick the automation so its search command is enqueued, then report its
// results so the tweets land in the candidate pool.
async function ingestCandidates(
  mf: Miniflare,
  relayId: string,
  token: string,
  automationId: string,
  tweets: ReturnType<typeof tweet>[],
): Promise<void> {
  const db = await mf.getD1Database("DB");
  await db.prepare("UPDATE automations SET next_run_at = ? WHERE id = ?").bind(0, automationId).run();
  await runScheduled({ cron: TICK_CRON }, { DB: db });
  const queued = await pollCommands(mf, relayId, token);
  const search = queued.find((c) => c.type === "search")!;
  const res = await mf.dispatchFetch(`http://localhost/api/relays/${relayId}/results`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ results: [{ command_id: search.id, ok: true, output: { tweets } }] }),
  });
  expect(res.status).toBe(200);
}

async function runFilter(
  mf: Miniflare,
  body: Record<string, unknown> = {},
): Promise<{
  automations: Array<{
    automation_id: string;
    candidates: number;
    kept: number;
    rejected: number;
    blocked: number;
    actionable: number;
  }>;
}> {
  const res = await mf.dispatchFetch("http://localhost/api/funnel/filter", {
    method: "POST",
    headers: userHeaders(),
    body: JSON.stringify(body),
  });
  expect(res.status).toBe(200);
  return (await res.json()) as {
    automations: Array<{
      automation_id: string;
      candidates: number;
      kept: number;
      rejected: number;
      blocked: number;
      actionable: number;
    }>;
  };
}

async function listDecisions(
  mf: Miniflare,
  email = "alice@example.com",
): Promise<{
  decisions: Array<{ stage: string; decision: string; rule: string; reason: string; score: number }>;
}> {
  const res = await mf.dispatchFetch("http://localhost/api/funnel/decisions", {
    headers: userHeaders(email, false),
  });
  expect(res.status).toBe(200);
  return (await res.json()) as {
    decisions: Array<{ stage: string; decision: string; rule: string; reason: string; score: number }>;
  };
}

describe("funnel filter (Stage 2)", () => {
  it("filters the pool to target size and records the audit trail", async () => {
    const mf = await makeWorker();
    try {
      const { relay_id, token } = await createAndPair(mf, "alice-relay", "alice@example.com");
      const { automation_id } = await createAutomation(mf, relay_id, {
        rules: { target_size: 2 },
        interval_minutes: 60,
      });
      await ingestCandidates(mf, relay_id, token, automation_id, [
        tweet("t1"),
        tweet("t2"),
        tweet("t3"),
        tweet("t4"),
        tweet("t5"),
      ]);

      const summary = (await runFilter(mf, { automation_id })).automations[0];
      expect(summary).toEqual({
        automation_id,
        candidates: 5,
        kept: 2,
        rejected: 3,
        blocked: 0,
        actionable: 2,
      });

      const { decisions } = await listDecisions(mf);
      expect(decisions.filter((d) => d.stage === "filter" && d.decision === "keep")).toHaveLength(2);
      const targetCuts = decisions.filter((d) => d.rule === "target_size");
      expect(targetCuts).toHaveLength(3);
      expect(decisions.every((d) => d.score >= 0)).toBe(true);
    } finally {
      await mf.dispose();
    }
  });

  it("rejects blocklisted authors and keeps everyone else", async () => {
    const mf = await makeWorker();
    try {
      const { relay_id, token } = await createAndPair(mf, "alice-relay", "alice@example.com");
      const { automation_id } = await createAutomation(mf, relay_id, {
        rules: { blocklist: ["bob"] },
        interval_minutes: 60,
      });
      await ingestCandidates(mf, relay_id, token, automation_id, [tweet("t1"), tweet("t2", { author: "carol" })]);

      const summary = (await runFilter(mf, { automation_id })).automations[0];
      expect(summary.kept).toBe(1);
      expect(summary.rejected).toBe(1);
      expect(summary.actionable).toBe(1);
      const { decisions } = await listDecisions(mf);
      expect(decisions.find((d) => d.rule === "blocklist")?.reason).toContain("bob");
    } finally {
      await mf.dispose();
    }
  });

  it("requires a matching automation and auth", async () => {
    const mf = await makeWorker();
    try {
      const noAuth = await mf.dispatchFetch("http://localhost/api/funnel/filter", { method: "POST" });
      expect(noAuth.status).toBe(401);

      const { relay_id } = await createAndPair(mf, "alice-relay", "alice@example.com");
      const { automation_id } = await createAutomation(mf, relay_id, { interval_minutes: 60 });
      const res = await mf.dispatchFetch("http://localhost/api/funnel/filter", {
        method: "POST",
        headers: userHeaders("bob@example.com"),
        body: JSON.stringify({ automation_id }),
      });
      expect(res.status).toBe(404);
    } finally {
      await mf.dispose();
    }
  });
});

describe("funnel guardrails (Stage 4)", () => {
  async function setup(mf: Miniflare, overrides: Record<string, unknown>) {
    const { relay_id, token } = await createAndPair(mf, "alice-relay", "alice@example.com");
    const { automation_id } = await createAutomation(mf, relay_id, {
      ...overrides,
      interval_minutes: 60,
    });
    await ingestCandidates(mf, relay_id, token, automation_id, [tweet("t1"), tweet("t2"), tweet("t3")]);
    return { relay_id, token, automation_id };
  }

  it("blocks everything when the daily post budget is exceeded", async () => {
    const mf = await makeWorker();
    try {
      const { relay_id, automation_id } = await setup(mf, { budgets: { max_posts_per_day: 1 } });
      const db = await mf.getD1Database("DB");
      const todaySec = Math.floor(startOfDayInZone(Date.now(), "UTC") / 1000);
      await db
        .prepare("INSERT INTO dedup (user_id, relay_id, tweet_id, action, acted_at) VALUES (?, ?, ?, ?, ?)")
        .bind("alice@example.com", relay_id, "already-posted", "post", todaySec + 1)
        .run();

      const summary = (await runFilter(mf, { automation_id })).automations[0];
      expect(summary.kept).toBe(3);
      expect(summary.blocked).toBe(3);
      expect(summary.actionable).toBe(0);

      const { decisions } = await listDecisions(mf);
      const budgetBlocks = decisions.filter((d) => d.stage === "guardrail" && d.rule === "budget");
      expect(budgetBlocks).toHaveLength(3);
      expect(budgetBlocks[0].reason).toContain("post");
    } finally {
      await mf.dispose();
    }
  });

  it("blocks everything when the daily reply budget is exceeded", async () => {
    const mf = await makeWorker();
    try {
      const { relay_id, automation_id } = await setup(mf, { budgets: { max_replies_per_day: 1 } });
      const db = await mf.getD1Database("DB");
      const todaySec = Math.floor(startOfDayInZone(Date.now(), "UTC") / 1000);
      await db
        .prepare("INSERT INTO dedup (user_id, relay_id, tweet_id, action, acted_at) VALUES (?, ?, ?, ?, ?)")
        .bind("alice@example.com", relay_id, "already-replied", "reply", todaySec + 1)
        .run();

      const summary = (await runFilter(mf, { automation_id })).automations[0];
      expect(summary.actionable).toBe(0);
      const { decisions } = await listDecisions(mf);
      expect(decisions.find((d) => d.rule === "budget")?.reason).toContain("reply");
    } finally {
      await mf.dispose();
    }
  });

  it("blocks everything during quiet hours", async () => {
    const mf = await makeWorker();
    try {
      const nowMs = Date.now();
      const hh = (ms: number) => new Date(ms).toISOString().slice(11, 16);
      const { automation_id } = await setup(mf, {
        budgets: { quiet_hours: { start: hh(nowMs - 3600_000), end: hh(nowMs + 3600_000) } },
      });

      const summary = (await runFilter(mf, { automation_id })).automations[0];
      expect(summary.actionable).toBe(0);
      const { decisions } = await listDecisions(mf);
      expect(decisions.filter((d) => d.rule === "quiet_hours")).toHaveLength(3);
    } finally {
      await mf.dispose();
    }
  });

  it("blocks tweets already engaged elsewhere (dedupe across automations/accounts)", async () => {
    const mf = await makeWorker();
    try {
      const { relay_id, automation_id } = await setup(mf, {});
      const db = await mf.getD1Database("DB");
      await db
        .prepare("INSERT INTO dedup (user_id, relay_id, tweet_id, action, acted_at) VALUES (?, ?, ?, ?, ?)")
        .bind("alice@example.com", relay_id, "t2", "reply", nowSeconds())
        .run();

      const summary = (await runFilter(mf, { automation_id })).automations[0];
      expect(summary.blocked).toBe(1);
      expect(summary.actionable).toBe(2);
      const { decisions } = await listDecisions(mf);
      expect(decisions.find((d) => d.rule === "dedupe")?.reason).toContain("t2");
    } finally {
      await mf.dispose();
    }
  });

  it("kill switch stops all actions; re-enabling restores them", async () => {
    const mf = await makeWorker();
    try {
      const { relay_id, automation_id } = await setup(mf, {});
      const off = await mf.dispatchFetch(`http://localhost/api/relays/${relay_id}/enabled`, {
        method: "POST",
        headers: userHeaders(),
        body: JSON.stringify({ enabled: false }),
      });
      expect(off.status).toBe(200);

      const offSummary = (await runFilter(mf, { automation_id })).automations[0];
      expect(offSummary.blocked).toBe(3);
      expect(offSummary.actionable).toBe(0);
      const { decisions } = await listDecisions(mf);
      expect(decisions.filter((d) => d.rule === "kill_switch")).toHaveLength(3);

      await mf.dispatchFetch(`http://localhost/api/relays/${relay_id}/enabled`, {
        method: "POST",
        headers: userHeaders(),
        body: JSON.stringify({ enabled: true }),
      });
      const onSummary = (await runFilter(mf, { automation_id })).automations[0];
      expect(onSummary.actionable).toBe(3);
    } finally {
      await mf.dispose();
    }
  });

  it("rejects kill-switch changes for another user's relay and non-booleans", async () => {
    const mf = await makeWorker();
    try {
      const { relay_id } = await createAndPair(mf, "alice-relay", "alice@example.com");
      const foreign = await mf.dispatchFetch(`http://localhost/api/relays/${relay_id}/enabled`, {
        method: "POST",
        headers: userHeaders("bob@example.com"),
        body: JSON.stringify({ enabled: false }),
      });
      expect(foreign.status).toBe(404);
      const invalid = await mf.dispatchFetch(`http://localhost/api/relays/${relay_id}/enabled`, {
        method: "POST",
        headers: userHeaders(),
        body: JSON.stringify({ enabled: "no" }),
      });
      expect(invalid.status).toBe(400);
    } finally {
      await mf.dispose();
    }
  });
});

describe("automation rules and budgets", () => {
  it("accepts and lists rules and budgets", async () => {
    const mf = await makeWorker();
    try {
      const { relay_id } = await createAndPair(mf, "alice-relay", "alice@example.com");
      const rules = { target_size: 20, blocklist: ["spam"], max_per_author: 3 };
      const budgets = { max_posts_per_day: 5, quiet_hours: { start: "22:00", end: "07:00" } };
      const { automation_id } = await createAutomation(mf, relay_id, { rules, budgets, interval_minutes: 60 });

      const list = await mf.dispatchFetch("http://localhost/api/automations", {
        headers: userHeaders("alice@example.com", false),
      });
      const body = (await list.json()) as { automations: Array<{ id: string; rules: unknown; budgets: unknown }> };
      const a = body.automations.find((x) => x.id === automation_id)!;
      expect(a.rules).toEqual(rules);
      expect(a.budgets).toEqual(budgets);
    } finally {
      await mf.dispose();
    }
  });

  it("rejects malformed rules and budgets", async () => {
    const mf = await makeWorker();
    try {
      const { relay_id } = await createAndPair(mf, "alice-relay", "alice@example.com");
      for (const overrides of [
        { rules: { target_size: 0 } },
        { rules: { weights: { engagement: -1 } } },
        { budgets: { max_posts_per_day: -1 } },
        { budgets: { quiet_hours: { start: "22", end: "07:00" } } },
      ]) {
        const res = await mf.dispatchFetch("http://localhost/api/automations", {
          method: "POST",
          headers: userHeaders(),
          body: JSON.stringify({ relay_id, search_criteria: SEARCH_CRITERIA, ...overrides }),
        });
        expect(res.status, JSON.stringify(overrides)).toBe(400);
      }
    } finally {
      await mf.dispose();
    }
  });

  it("scopes the audit trail per user", async () => {
    const mf = await makeWorker();
    try {
      const { relay_id, token } = await createAndPair(mf, "alice-relay", "alice@example.com");
      const { automation_id } = await createAutomation(mf, relay_id, { interval_minutes: 60 });
      await ingestCandidates(mf, relay_id, token, automation_id, [tweet("t1")]);
      await runFilter(mf, { automation_id });

      const alice = await listDecisions(mf, "alice@example.com");
      expect(alice.decisions.length).toBeGreaterThan(0);
      const bob = await listDecisions(mf, "bob@example.com");
      expect(bob.decisions).toHaveLength(0);
    } finally {
      await mf.dispose();
    }
  });
});
