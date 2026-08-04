// Ticket 10: Funnel Stage 3 — AI targeting API. A local OpenAI-compatible stub
// plays the provider (per spec: "AI provider mocked as an OpenAI-compatible
// stub at the Worker boundary"), so verdict flow, idempotency, retry of
// failures, and provider configuration are exercised end to end.

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Miniflare } from "miniflare";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { TICK_CRON, runScheduled } from "../src/scheduled";
import { createAndPair, makeWorker, userHeaders } from "./harness";

const SEARCH_CRITERIA = { keywords: ["openai"], min_faves: 5, lang: "en" };

type StubMode = "reply" | "quote" | "skip" | "rate_limit" | "garbage";

let stubServer: Server;
let stubBaseUrl = "";
let stubCalls = 0;
let lastBody: Record<string, unknown> = {};
let mode: StubMode = "reply";

function verdictBody(v: Record<string, unknown>) {
  return { choices: [{ message: { content: JSON.stringify(v) } }] };
}

beforeAll(async () => {
  stubServer = createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      stubCalls += 1;
      lastBody = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
      res.setHeader("content-type", "application/json");
      switch (mode) {
        case "reply":
          res.end(JSON.stringify(verdictBody({ action: "reply", reason: "on-topic", priority: 3 })));
          break;
        case "quote":
          res.end(JSON.stringify(verdictBody({ action: "quote", reason: "amplify", priority: 4 })));
          break;
        case "skip":
          res.end(JSON.stringify(verdictBody({ action: "skip", reason: "not relevant", priority: 1 })));
          break;
        case "rate_limit":
          res.statusCode = 429;
          res.end(JSON.stringify({ error: { message: "rate limited" } }));
          break;
        case "garbage":
          res.end(JSON.stringify({ choices: [{ message: { content: "definitely not json" } }] }));
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
  stubCalls = 0;
  lastBody = {};
});

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

function tweet(id: string) {
  return {
    id,
    author: "bob",
    text: "hello " + id,
    created_at: "Mon Aug 03 09:00:00 +0000 2026",
    favorite_count: 3,
    retweet_count: 1,
    reply_count: 0,
    lang: "en",
  };
}

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
  const queued = await pollCommandsFor(mf, relayId, token);
  const search = queued.find((c) => c.type === "search")!;
  const res = await mf.dispatchFetch(`http://localhost/api/relays/${relayId}/results`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ results: [{ command_id: search.id, ok: true, output: { tweets } }] }),
  });
  expect(res.status).toBe(200);
}

async function pollCommandsFor(
  mf: Miniflare,
  relayId: string,
  token: string,
): Promise<{ id: string; type: string; payload: unknown }[]> {
  const res = await mf.dispatchFetch(`http://localhost/api/relays/${relayId}/commands`, {
    headers: { authorization: `Bearer ${token}` },
  });
  expect(res.status).toBe(200);
  return ((await res.json()) as { commands: { id: string; type: string; payload: unknown }[] }).commands;
}

async function runTarget(
  mf: Miniflare,
  body: Record<string, unknown> = {},
): Promise<{ status: number; automations?: Array<Record<string, number>>; error?: string }> {
  const res = await mf.dispatchFetch("http://localhost/api/funnel/target", {
    method: "POST",
    headers: userHeaders(),
    body: JSON.stringify(body),
  });
  return res.status === 200
    ? { status: res.status, automations: ((await res.json()) as { automations: Array<Record<string, number>> }).automations }
    : { status: res.status, error: ((await res.json()) as { error: string }).error };
}

async function listDrafts(
  mf: Miniflare,
  email = "alice@example.com",
): Promise<{
  drafts: Array<{ action: string; reason: string; priority: number; author: string; text: string; automation_name: string }>;
}> {
  const res = await mf.dispatchFetch("http://localhost/api/drafts", { headers: userHeaders(email, false) });
  expect(res.status).toBe(200);
  return (await res.json()) as {
    drafts: Array<{ action: string; reason: string; priority: number; author: string; text: string; automation_name: string }>;
  };
}

async function listDecisions(
  mf: Miniflare,
): Promise<{ decisions: Array<{ stage: string; decision: string; rule: string; reason: string }> }> {
  const res = await mf.dispatchFetch("http://localhost/api/funnel/decisions", { headers: userHeaders("alice@example.com", false) });
  expect(res.status).toBe(200);
  return (await res.json()) as { decisions: Array<{ stage: string; decision: string; rule: string; reason: string }> };
}

async function setup(
  mf: Miniflare,
  tweetCount = 3,
  overrides: Record<string, unknown> = {},
): Promise<{ relay_id: string; token: string; automation_id: string }> {
  const { relay_id, token } = await createAndPair(mf, "alice-relay", "alice@example.com");
  const { automation_id } = await createAutomation(mf, relay_id, { interval_minutes: 60, ...overrides });
  await ingestCandidates(
    mf,
    relay_id,
    token,
    automation_id,
    Array.from({ length: tweetCount }, (_, i) => tweet(`t${i + 1}`)),
  );
  const put = await mf.dispatchFetch("http://localhost/api/provider", {
    method: "PUT",
    headers: userHeaders(),
    body: JSON.stringify({ base_url: stubBaseUrl, api_key: "sk-test", model: "test-model" }),
  });
  expect(put.status).toBe(200);
  return { relay_id, token, automation_id };
}

describe("POST /api/funnel/target", () => {
  it("requires a configured provider (409) and a matching automation (404)", async () => {
    const mf = await makeWorker();
    try {
      const noProvider = await runTarget(mf, {});
      expect(noProvider.status).toBe(409);
      expect(noProvider.error).toBe("no provider configured");

      const { relay_id } = await createAndPair(mf, "alice-relay", "alice@example.com");
      const { automation_id } = await createAutomation(mf, relay_id, { interval_minutes: 60 });
      await mf.dispatchFetch("http://localhost/api/provider", {
        method: "PUT",
        headers: userHeaders(),
        body: JSON.stringify({ base_url: stubBaseUrl, api_key: "sk-test", model: "test-model" }),
      });
      const notMine = await mf.dispatchFetch("http://localhost/api/funnel/target", {
        method: "POST",
        headers: userHeaders("bob@example.com"),
        body: JSON.stringify({ automation_id }),
      });
      expect(notMine.status).toBe(404);
      const unknown = await runTarget(mf, { automation_id: "nope" });
      expect(unknown.status).toBe(404);
    } finally {
      await mf.dispose();
    }
  });

  it("creates drafts for reply verdicts and audits the ai stage", async () => {
    const mf = await makeWorker();
    try {
      const { automation_id } = await setup(mf, 3);

      const result = await runTarget(mf, { automation_id });
      expect(result.status).toBe(200);
      expect(result.automations![0]).toMatchObject({ actionable: 3, judged: 3, drafts: 3, skips: 0, failures: 0 });

      const { drafts } = await listDrafts(mf);
      expect(drafts).toHaveLength(3);
      expect(drafts[0]).toMatchObject({
        action: "reply",
        reason: "on-topic",
        priority: 3,
        author: "bob",
        automation_name: "automation",
      });

      const { decisions } = await listDecisions(mf);
      const aiDrafts = decisions.filter((d) => d.stage === "ai" && d.decision === "draft");
      expect(aiDrafts).toHaveLength(3);
      expect(aiDrafts.every((d) => d.rule === "ai_target" && d.reason === "on-topic")).toBe(true);

      const userMessage = ((lastBody.messages as Array<{ role: string; content: string }>).find((m) => m.role === "user") ?? { content: "" }).content;
      expect(userMessage).toContain("Targeting profile:");
      expect(userMessage).toContain("automation");
    } finally {
      await mf.dispose();
    }
  });

  it("is idempotent: already-judged candidates are never re-called", async () => {
    const mf = await makeWorker();
    try {
      const { automation_id } = await setup(mf, 3);

      await runTarget(mf, { automation_id });
      expect(stubCalls).toBe(3);

      const again = await runTarget(mf, { automation_id });
      expect(again.automations![0]).toMatchObject({ judged: 0, drafts: 0 });
      expect(stubCalls).toBe(3);
      expect((await listDrafts(mf)).drafts).toHaveLength(3);
    } finally {
      await mf.dispose();
    }
  });

  it("skip verdicts leave no draft but are audited and never re-called", async () => {
    const mf = await makeWorker();
    try {
      mode = "skip";
      const { automation_id } = await setup(mf, 2);

      const result = await runTarget(mf, { automation_id });
      expect(result.automations![0]).toMatchObject({ judged: 2, drafts: 0, skips: 2, failures: 0 });
      expect((await listDrafts(mf)).drafts).toHaveLength(0);

      const { decisions } = await listDecisions(mf);
      expect(decisions.filter((d) => d.stage === "ai" && d.decision === "skip")).toHaveLength(2);
      expect(stubCalls).toBe(2);

      const again = await runTarget(mf, { automation_id });
      expect(again.automations![0].judged).toBe(0);
      expect(stubCalls).toBe(2);
    } finally {
      await mf.dispose();
    }
  });

  it("failures are audited as ai_fail and retried on the next run", async () => {
    const mf = await makeWorker();
    try {
      mode = "rate_limit";
      const { automation_id } = await setup(mf, 2);

      const result = await runTarget(mf, { automation_id });
      expect(result.automations![0]).toMatchObject({ judged: 2, drafts: 0, failures: 2 });

      let { decisions } = await listDecisions(mf);
      expect(decisions.filter((d) => d.stage === "ai" && d.decision === "fail")).toHaveLength(2);
      expect(decisions.every((d) => d.rule === "ai_fail")).toBe(true);

      mode = "reply";
      const retry = await runTarget(mf, { automation_id });
      expect(retry.automations![0]).toMatchObject({ judged: 2, drafts: 2, failures: 0 });
      expect((await listDrafts(mf)).drafts).toHaveLength(2);

      decisions = (await listDecisions(mf)).decisions;
      expect(decisions.filter((d) => d.decision === "fail")).toHaveLength(2);
      expect(decisions.filter((d) => d.decision === "draft")).toHaveLength(2);
    } finally {
      await mf.dispose();
    }
  });

  it("garbage 200s fail cleanly with the parse error in the audit reason", async () => {
    const mf = await makeWorker();
    try {
      mode = "garbage";
      const { automation_id } = await setup(mf, 1);

      const result = await runTarget(mf, { automation_id });
      expect(result.automations![0]).toMatchObject({ judged: 1, drafts: 0, failures: 1 });
      const { decisions } = await listDecisions(mf);
      expect(decisions.find((d) => d.decision === "fail")?.reason).toBe("parse");
    } finally {
      await mf.dispose();
    }
  });

  it("respects the guardrails: budget-blocked candidates never reach the AI", async () => {
    const mf = await makeWorker();
    try {
      const { relay_id, automation_id } = await setup(mf, 3);
      const db = await mf.getD1Database("DB");
      await db
        .prepare("INSERT INTO dedup (user_id, relay_id, tweet_id, action, acted_at) VALUES (?, ?, ?, ?, ?)")
        .bind("alice@example.com", relay_id, "t2", "reply", Math.floor(Date.now() / 1000))
        .run();

      const result = await runTarget(mf, { automation_id });
      expect(result.automations![0]).toMatchObject({ actionable: 2, judged: 2, drafts: 2 });
      expect(stubCalls).toBe(2);
    } finally {
      await mf.dispose();
    }
  });
});

describe("GET /api/provider", () => {
  it("round-trips config and never returns the full key", async () => {
    const mf = await makeWorker();
    try {
      const before = await mf.dispatchFetch("http://localhost/api/provider", { headers: userHeaders("alice@example.com", false) });
      expect((await before.json())).toEqual({ provider: null });

      const put = await mf.dispatchFetch("http://localhost/api/provider", {
        method: "PUT",
        headers: userHeaders(),
        body: JSON.stringify({ base_url: stubBaseUrl, api_key: "sk-test-1234", model: "m1" }),
      });
      expect(put.status).toBe(200);
      const saved = (await put.json()) as { provider: { key_masked: string } };
      expect(saved.provider.key_masked).toBe("••••••••1234");

      const after = await mf.dispatchFetch("http://localhost/api/provider", { headers: userHeaders("alice@example.com", false) });
      const body = (await after.json()) as { provider: { base_url: string; model: string; key_configured: boolean } };
      expect(body.provider).toMatchObject({ base_url: stubBaseUrl, model: "m1", key_configured: true });
      expect(JSON.stringify(body)).not.toContain("sk-test-1234");
    } finally {
      await mf.dispose();
    }
  });

  it("keeps the existing key when PUT omits api_key, and validates the body", async () => {
    const mf = await makeWorker();
    try {
      await mf.dispatchFetch("http://localhost/api/provider", {
        method: "PUT",
        headers: userHeaders(),
        body: JSON.stringify({ base_url: stubBaseUrl, api_key: "sk-original", model: "m1" }),
      });
      const update = await mf.dispatchFetch("http://localhost/api/provider", {
        method: "PUT",
        headers: userHeaders(),
        body: JSON.stringify({ base_url: "https://other.example/v1", model: "m2" }),
      });
      expect(update.status).toBe(200);

      const after = await mf.dispatchFetch("http://localhost/api/provider", { headers: userHeaders("alice@example.com", false) });
      const body = (await after.json()) as { provider: { base_url: string; model: string; key_masked: string } };
      expect(body.provider).toMatchObject({ base_url: "https://other.example/v1", model: "m2" });
      expect(body.provider.key_masked).toBe("••••••••inal");

      const missing = await mf.dispatchFetch("http://localhost/api/provider", {
        method: "PUT",
        headers: userHeaders(),
        body: JSON.stringify({ model: "m3" }),
      });
      expect(missing.status).toBe(400);
      const badUrl = await mf.dispatchFetch("http://localhost/api/provider", {
        method: "PUT",
        headers: userHeaders(),
        body: JSON.stringify({ base_url: "ftp://x", model: "m3", api_key: "k" }),
      });
      expect(badUrl.status).toBe(400);
    } finally {
      await mf.dispose();
    }
  });

  it("lists the free-endpoint presets", async () => {
    const mf = await makeWorker();
    try {
      const res = await mf.dispatchFetch("http://localhost/api/provider/presets", { headers: userHeaders("alice@example.com", false) });
      expect(res.status).toBe(200);
      const { presets } = (await res.json()) as { presets: Array<{ name: string; base_url: string }> };
      expect(presets.map((p) => p.name)).toEqual([
        "NVIDIA NIM",
        "OpenCode Zen",
        "Groq",
        "Gemini",
        "OpenRouter",
        "Cerebras",
        "Mistral",
        "GitHub Models",
        "Cloudflare Workers AI",
      ]);
    } finally {
      await mf.dispose();
    }
  });

  it("scopes drafts per user", async () => {
    const mf = await makeWorker();
    try {
      const { automation_id } = await setup(mf, 1);
      await runTarget(mf, { automation_id });

      expect((await listDrafts(mf, "alice@example.com")).drafts).toHaveLength(1);
      expect((await listDrafts(mf, "bob@example.com")).drafts).toHaveLength(0);
    } finally {
      await mf.dispose();
    }
  });
});
