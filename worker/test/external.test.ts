// Ticket 14: external API routes. Tests token auth, POST /api/targeting
// (with synchronous funnel results), POST /api/content, POST /api/results.

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Miniflare } from "miniflare";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createAndPair, makeWorker, userHeaders, bearerHeaders } from "./harness";
import { hashToken } from "../src/lib/crypto";

type StubMode = "reply" | "skip";

let stubServer: Server;
let stubBaseUrl = "";
let mode: StubMode = "reply";

function verdictBody(v: Record<string, unknown>) {
  return { choices: [{ message: { content: JSON.stringify(v) } }] };
}

beforeAll(async () => {
  stubServer = createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      res.setHeader("content-type", "application/json");
      switch (mode) {
        case "reply":
          res.end(JSON.stringify(verdictBody({ action: "reply", reason: "on-topic", priority: 3 })));
          break;
        case "skip":
          res.end(JSON.stringify(verdictBody({ action: "skip", reason: "not relevant", priority: 1 })));
          break;
      }
    });
  });
  await new Promise<void>((resolve) => stubServer.listen(0, "127.0.0.1", resolve));
  stubBaseUrl = `http://127.0.0.1:${(stubServer.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => stubServer.close(() => resolve()));
});

beforeEach(() => {
  mode = "reply";
});

async function createToken(mf: Miniflare, userId = "alice@example.com"): Promise<{ token: string; token_id: string }> {
  const res = await mf.dispatchFetch("http://localhost/api/tokens", {
    method: "POST",
    headers: { ...userHeaders(userId), "content-type": "application/json" },
    body: JSON.stringify({ name: "test-token" }),
  });
  expect(res.status).toBe(201);
  return (await res.json()) as { token: string; token_id: string };
}

function externalHeaders(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}`, "content-type": "application/json" };
}

describe("external API", () => {
  it("rejects requests without a valid token", async () => {
    const mf = await makeWorker();
    try {
      const res = await mf.dispatchFetch("http://localhost/api/targeting", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ relay_id: "x" }),
      });
      expect(res.status).toBe(401);
    } finally {
      await mf.dispose();
    }
  });

  it("POST /api/targeting creates automation and returns funnel results", async () => {
    const mf = await makeWorker();
    try {
      const { relay_id } = await createAndPair(mf);
      const { token } = await createToken(mf);

      // Configure AI provider
      await mf.dispatchFetch("http://localhost/api/provider", {
        method: "PUT",
        headers: userHeaders(),
        body: JSON.stringify({ base_url: stubBaseUrl, api_key: "test-key", model: "gpt-4o-mini" }),
      });

      const res = await mf.dispatchFetch("http://localhost/api/targeting", {
        method: "POST",
        headers: externalHeaders(token),
        body: JSON.stringify({
          relay_id,
          search_criteria: { keywords: ["test"] },
          targeting: { profile: { interests: ["tech"] } },
        }),
      });
      expect(res.status).toBe(201);
      const body = (await res.json()) as {
        automation_id: string;
        targeting: { automation_id: string; actionable: number; judged: number; drafts: number; skips: number; failures: number };
        error: string | null;
      };
      expect(body.automation_id).toBeDefined();
      expect(body.targeting).toBeDefined();
      expect(body.targeting.automation_id).toBe(body.automation_id);
      expect(typeof body.targeting.actionable).toBe("number");
      expect(typeof body.targeting.judged).toBe("number");
      expect(body.error).toBeNull();
    } finally {
      await mf.dispose();
    }
  });

  it("POST /api/content creates a draft for posting", async () => {
    const mf = await makeWorker();
    try {
      const { relay_id } = await createAndPair(mf);
      const { token } = await createToken(mf);

      const res = await mf.dispatchFetch("http://localhost/api/content", {
        method: "POST",
        headers: externalHeaders(token),
        body: JSON.stringify({ relay_id, text: "Hello from external tool" }),
      });
      expect(res.status).toBe(201);
      const body = (await res.json()) as { draft_id: number; action: string };
      expect(body.draft_id).toBeDefined();
      expect(body.action).toBe("post");
    } finally {
      await mf.dispose();
    }
  });

  it("POST /api/content creates a reply draft when target_tweet_id is provided", async () => {
    const mf = await makeWorker();
    try {
      const { relay_id } = await createAndPair(mf);
      const { token } = await createToken(mf);

      const res = await mf.dispatchFetch("http://localhost/api/content", {
        method: "POST",
        headers: externalHeaders(token),
        body: JSON.stringify({ relay_id, text: "Great tweet!", target_tweet_id: "t-123", target_author: "bob" }),
      });
      expect(res.status).toBe(201);
      const body = (await res.json()) as { draft_id: number; action: string };
      expect(body.action).toBe("reply");
    } finally {
      await mf.dispose();
    }
  });

  it("POST /api/results updates draft status", async () => {
    const mf = await makeWorker();
    try {
      const { relay_id } = await createAndPair(mf);
      const { token } = await createToken(mf);

      // Create a draft first
      const contentRes = await mf.dispatchFetch("http://localhost/api/content", {
        method: "POST",
        headers: externalHeaders(token),
        body: JSON.stringify({ relay_id, text: "Test post" }),
      });
      const { draft_id } = (await contentRes.json()) as { draft_id: number };

      // Report result
      const res = await mf.dispatchFetch("http://localhost/api/results", {
        method: "POST",
        headers: externalHeaders(token),
        body: JSON.stringify({ relay_id, draft_id, tweet_id: "posted-tweet-1", status: "done" }),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { ok: boolean };
      expect(body.ok).toBe(true);

      // Verify draft was updated
      const db = await mf.getD1Database("DB");
      const draft = (await db.prepare("SELECT status, result_tweet_id FROM drafts WHERE id = ?").bind(draft_id).first()) as { status: string; result_tweet_id: string };
      expect(draft.status).toBe("done");
      expect(draft.result_tweet_id).toBe("posted-tweet-1");
    } finally {
      await mf.dispose();
    }
  });
});
