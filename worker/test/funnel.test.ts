import { describe, expect, it } from "vitest";
import { Miniflare } from "miniflare";
import { TICK_CRON, runScheduled } from "../src/scheduled";
import { bearerHeaders, createAndPair, makeWorker, nowSeconds, pollCommands, userHeaders } from "./harness";

const SEARCH_CRITERIA = { keywords: ["openai"], min_faves: 5, lang: "en" };
const TARGETING = {
  profile: { keywords: ["founder"], min_followers: 1000, verified: true, location: "London" },
};

async function createAutomation(
  mf: Miniflare,
  relayId: string,
  overrides: Record<string, unknown> = {},
): Promise<{ automation_id: string }> {
  const res = await mf.dispatchFetch("http://localhost/api/automations", {
    method: "POST",
    headers: userHeaders(),
    body: JSON.stringify({ relay_id: relayId, search_criteria: SEARCH_CRITERIA, targeting: TARGETING, ...overrides }),
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

async function reportResults(
  mf: Miniflare,
  relayId: string,
  token: string,
  results: Array<{ command_id: string; ok: boolean; output: unknown }>,
): Promise<number> {
  const res = await mf.dispatchFetch(`http://localhost/api/relays/${relayId}/results`, {
    method: "POST",
    headers: bearerHeaders(token),
    body: JSON.stringify({ results }),
  });
  expect(res.status).toBe(200);
  return ((await res.json()) as { updated: number }).updated;
}

async function listCandidates(
  mf: Miniflare,
  email = "alice@example.com",
): Promise<{
  candidates: Array<{
    id: string;
    tweet_id: string;
    author: string;
    favorite_count: number;
    source: string;
    automation_id: string;
  }>;
}> {
  const res = await mf.dispatchFetch("http://localhost/api/candidates", {
    headers: userHeaders(email, false),
  });
  expect(res.status).toBe(200);
  return (await res.json()) as {
    candidates: Array<{
      id: string;
      tweet_id: string;
      author: string;
      favorite_count: number;
      source: string;
      automation_id: string;
    }>;
  };
}

describe("tick funnel fan-out", () => {
  it("enqueues search and profile_pass commands for a due automation", async () => {
    const mf = await makeWorker();
    try {
      const { relay_id, token } = await createAndPair(mf, "alice-relay", "alice@example.com");
      const { automation_id } = await createAutomation(mf, relay_id, {
        interval_minutes: 60,
        timezone: "UTC",
      });

      const db = await mf.getD1Database("DB");
      await db.prepare("UPDATE automations SET next_run_at = ? WHERE id = ?").bind(0, automation_id).run();
      await runScheduled({ cron: TICK_CRON }, { DB: db });

      const queued = await pollCommands(mf, relay_id, token);
      expect(queued).toHaveLength(2);
      const search = queued.find((c) => c.type === "search");
      const profile = queued.find((c) => c.type === "profile_pass");
      expect(search).toBeDefined();
      expect(profile).toBeDefined();
      expect(search!.payload).toEqual({
        automation_id,
        keywords: ["openai"],
        min_faves: 5,
        lang: "en",
        max_pages: 3,
      });
      expect(profile!.payload).toEqual({
        automation_id,
        profile: { keywords: ["founder"], min_followers: 1000, verified: true, location: "London" },
        max_profiles: 3,
        max_pages: 1,
      });

      const row = (await db.prepare("SELECT next_run_at FROM automations WHERE id = ?").bind(automation_id).first()) as {
        next_run_at: number;
      };
      expect(row.next_run_at).toBeGreaterThan(nowSeconds());
    } finally {
      await mf.dispose();
    }
  });

  it("skips paused automations", async () => {
    const mf = await makeWorker();
    try {
      const { relay_id, token } = await createAndPair(mf, "alice-relay", "alice@example.com");
      const { automation_id } = await createAutomation(mf, relay_id, { interval_minutes: 60 });

      const db = await mf.getD1Database("DB");
      await db
        .prepare("UPDATE automations SET status = 'paused', next_run_at = ? WHERE id = ?")
        .bind(0, automation_id)
        .run();
      await runScheduled({ cron: TICK_CRON }, { DB: db });

      expect(await pollCommands(mf, relay_id, token)).toHaveLength(0);
    } finally {
      await mf.dispose();
    }
  });
});

describe("candidate pool ingestion", () => {
  it("stores reported search tweets with metadata and dedupes per user", async () => {
    const mf = await makeWorker();
    try {
      const { relay_id, token } = await createAndPair(mf, "alice-relay", "alice@example.com");
      const { automation_id } = await createAutomation(mf, relay_id, { interval_minutes: 60 });
      const db = await mf.getD1Database("DB");
      await db.prepare("UPDATE automations SET next_run_at = ? WHERE id = ?").bind(0, automation_id).run();
      await runScheduled({ cron: TICK_CRON }, { DB: db });

      const queued = await pollCommands(mf, relay_id, token);
      const searchCommand = queued.find((c) => c.type === "search")!;

      await reportResults(mf, relay_id, token, [
        { command_id: searchCommand.id, ok: true, output: { tweets: [tweet("t1"), tweet("t2")] } },
      ]);

      let body = await listCandidates(mf);
      expect(body.candidates).toHaveLength(2);
      expect(body.candidates[0].tweet_id).toBe("t2");
      expect(body.candidates[0].author).toBe("bob");
      expect(body.candidates[0].favorite_count).toBe(3);
      expect(body.candidates[0].source).toBe("search");
      expect(body.candidates[0].automation_id).toBe(automation_id);

      // Same tweet reported again (second pass) must not duplicate the pool row.
      await reportResults(mf, relay_id, token, [
        { command_id: searchCommand.id, ok: true, output: { tweets: [tweet("t1"), tweet("t3")] } },
      ]);
      body = await listCandidates(mf);
      expect(body.candidates).toHaveLength(3);
    } finally {
      await mf.dispose();
    }
  });

  it("labels profile_pass results with source profile", async () => {
    const mf = await makeWorker();
    try {
      const { relay_id, token } = await createAndPair(mf, "alice-relay", "alice@example.com");
      const { automation_id } = await createAutomation(mf, relay_id, { interval_minutes: 60 });
      const db = await mf.getD1Database("DB");
      await db.prepare("UPDATE automations SET next_run_at = ? WHERE id = ?").bind(0, automation_id).run();
      await runScheduled({ cron: TICK_CRON }, { DB: db });

      const queued = await pollCommands(mf, relay_id, token);
      const profileCommand = queued.find((c) => c.type === "profile_pass")!;
      await reportResults(mf, relay_id, token, [
        {
          command_id: profileCommand.id,
          ok: true,
          output: { profiles_found: 1, tweets: [tweet("p1")] },
        },
      ]);

      const body = await listCandidates(mf);
      expect(body.candidates).toHaveLength(1);
      expect(body.candidates[0].tweet_id).toBe("p1");
      expect(body.candidates[0].source).toBe("profile");
    } finally {
      await mf.dispose();
    }
  });

  it("does not store candidates for non-funnel commands", async () => {
    const mf = await makeWorker();
    try {
      const { relay_id, token } = await createAndPair(mf, "alice-relay", "alice@example.com");
      const enqueued = await mf.dispatchFetch(`http://localhost/api/relays/${relay_id}/commands`, {
        method: "POST",
        headers: userHeaders(),
        body: JSON.stringify({ type: "echo", payload: { message: "ping" } }),
      });
      const { command_id } = (await enqueued.json()) as { command_id: string };
      await reportResults(mf, relay_id, token, [
        { command_id, ok: true, output: { echoed: "ping" } },
      ]);

      const body = await listCandidates(mf);
      expect(body.candidates).toHaveLength(0);
    } finally {
      await mf.dispose();
    }
  });

  it("requires authentication for the candidate pool", async () => {
    const mf = await makeWorker();
    try {
      const res = await mf.dispatchFetch("http://localhost/api/candidates");
      expect(res.status).toBe(401);
    } finally {
      await mf.dispose();
    }
  });

  it("dashboard shows automation and candidate pool sections", async () => {
    const mf = await makeWorker();
    try {
      const res = await mf.dispatchFetch("http://localhost/", {
        headers: userHeaders("alice@example.com", false),
      });
      expect(res.status).toBe(200);
      const html = await res.text();
      expect(html).toContain("Automations");
      expect(html).toContain("Candidate pool");
      expect(html).toContain("/api/automations");
      expect(html).toContain("/api/candidates");
      expect(html).toContain("Profile keywords");
      expect(html).toContain("Min followers");
    } finally {
      await mf.dispose();
    }
  });
});
