import { describe, expect, it } from "vitest";
import { Miniflare } from "miniflare";
import { createAndPair, makeWorker, nowSeconds, userHeaders } from "./harness";

const SEARCH_CRITERIA = {
  keywords: ["openai"],
  hashtags: ["remit"],
  mentions: ["bob"],
  min_faves: 5,
  min_retweets: 2,
  min_replies: 1,
  lang: "en",
  since: "2026-08-01",
  until: "2026-08-03",
};

const TARGETING = {
  profile: { keywords: ["founder"], min_followers: 1000, verified: true, location: "London" },
  persona: "friendly recruiter",
  goals: "find hiring posts",
};

async function createAutomation(
  mf: Miniflare,
  relayId: string,
  overrides: Record<string, unknown> = {},
  email = "alice@example.com",
): Promise<{ automation_id: string; next_run_at: number }> {
  const res = await mf.dispatchFetch("http://localhost/api/automations", {
    method: "POST",
    headers: userHeaders(email),
    body: JSON.stringify({ relay_id: relayId, search_criteria: SEARCH_CRITERIA, targeting: TARGETING, ...overrides }),
  });
  expect(res.status).toBe(201);
  return (await res.json()) as { automation_id: string; next_run_at: number };
}

describe("automation API", () => {
  it("requires authentication", async () => {
    const mf = await makeWorker();
    try {
      const res = await mf.dispatchFetch("http://localhost/api/automations", { method: "POST" });
      expect(res.status).toBe(401);
    } finally {
      await mf.dispose();
    }
  });

  it("rejects an automation for another user's relay", async () => {
    const mf = await makeWorker();
    try {
      const { relay_id } = await createAndPair(mf, "alice-relay", "alice@example.com");
      const res = await mf.dispatchFetch("http://localhost/api/automations", {
        method: "POST",
        headers: userHeaders("bob@example.com"),
        body: JSON.stringify({ relay_id, search_criteria: SEARCH_CRITERIA }),
      });
      expect(res.status).toBe(404);
    } finally {
      await mf.dispose();
    }
  });

  it("rejects search criteria without keywords", async () => {
    const mf = await makeWorker();
    try {
      const { relay_id } = await createAndPair(mf, "alice-relay", "alice@example.com");
      const res = await mf.dispatchFetch("http://localhost/api/automations", {
        method: "POST",
        headers: userHeaders(),
        body: JSON.stringify({ relay_id, search_criteria: { min_faves: 5 } }),
      });
      expect(res.status).toBe(400);
    } finally {
      await mf.dispose();
    }
  });

  it("rejects negative engagement thresholds", async () => {
    const mf = await makeWorker();
    try {
      const { relay_id } = await createAndPair(mf, "alice-relay", "alice@example.com");
      const res = await mf.dispatchFetch("http://localhost/api/automations", {
        method: "POST",
        headers: userHeaders(),
        body: JSON.stringify({ relay_id, search_criteria: { keywords: ["x"], min_faves: -1 } }),
      });
      expect(res.status).toBe(400);
    } finally {
      await mf.dispose();
    }
  });

  it("rejects an invalid timezone", async () => {
    const mf = await makeWorker();
    try {
      const { relay_id } = await createAndPair(mf, "alice-relay", "alice@example.com");
      const res = await mf.dispatchFetch("http://localhost/api/automations", {
        method: "POST",
        headers: userHeaders(),
        body: JSON.stringify({ relay_id, search_criteria: SEARCH_CRITERIA, timezone: "Mars/Olympus" }),
      });
      expect(res.status).toBe(400);
    } finally {
      await mf.dispose();
    }
  });

  it("rejects a targeting profile with stringified or negative fields", async () => {
    const mf = await makeWorker();
    try {
      const { relay_id } = await createAndPair(mf, "alice-relay", "alice@example.com");
      for (const targeting of [
        { profile: { verified: "false" } },
        { profile: { min_followers: -10 } },
        { profile: { keywords: "founder" } },
        { profile: "founder" },
      ]) {
        const res = await mf.dispatchFetch("http://localhost/api/automations", {
          method: "POST",
          headers: userHeaders(),
          body: JSON.stringify({ relay_id, search_criteria: SEARCH_CRITERIA, targeting }),
        });
        expect(res.status, JSON.stringify(targeting)).toBe(400);
      }
    } finally {
      await mf.dispose();
    }
  });

  it("creates an automation with criteria and targeting, and lists it back", async () => {
    const mf = await makeWorker();
    try {
      const { relay_id } = await createAndPair(mf, "alice-relay", "alice@example.com");
      const { automation_id, next_run_at } = await createAutomation(mf, relay_id, {
        name: "hiring remit",
        interval_minutes: 60,
        timezone: "America/New_York",
      });
      expect(automation_id).toMatch(/^[0-9a-f-]{36}$/);
      expect(next_run_at).toBeGreaterThan(nowSeconds());

      const list = await mf.dispatchFetch("http://localhost/api/automations", {
        headers: userHeaders("alice@example.com", false),
      });
      expect(list.status).toBe(200);
      const body = (await list.json()) as {
        automations: Array<{
          id: string;
          name: string;
          status: string;
          interval_minutes: number;
          timezone: string;
          search_criteria: { keywords: string[]; min_faves: number };
          targeting: { persona: string; profile: { min_followers: number } };
        }>;
      };
      expect(body.automations).toHaveLength(1);
      const a = body.automations[0];
      expect(a.id).toBe(automation_id);
      expect(a.name).toBe("hiring remit");
      expect(a.status).toBe("active");
      expect(a.interval_minutes).toBe(60);
      expect(a.timezone).toBe("America/New_York");
      expect(a.search_criteria.keywords).toEqual(["openai"]);
      expect(a.search_criteria.min_faves).toBe(5);
      expect(a.targeting.persona).toBe("friendly recruiter");
      expect(a.targeting.profile.min_followers).toBe(1000);
    } finally {
      await mf.dispose();
    }
  });

  it("scopes automation lists per user", async () => {
    const mf = await makeWorker();
    try {
      const { relay_id } = await createAndPair(mf, "alice-relay", "alice@example.com");
      await createAutomation(mf, relay_id, { name: "alice's" });

      const list = await mf.dispatchFetch("http://localhost/api/automations", {
        headers: userHeaders("bob@example.com", false),
      });
      const body = (await list.json()) as { automations: unknown[] };
      expect(body.automations).toHaveLength(0);
    } finally {
      await mf.dispose();
    }
  });
});
