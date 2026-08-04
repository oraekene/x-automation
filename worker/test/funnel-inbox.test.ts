// Ticket 11: inbox execution modes. Exercises the drafts inbox end to end —
// approve/reject through the relay write path, manual/auto/hybrid execution on
// the tick, guardrail re-checks at execution time, and the hourly content
// retry for drafts whose AI text generation failed at targeting time.

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Miniflare } from "miniflare";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { MAINT_CRON, TICK_CRON, runScheduled } from "../src/scheduled";
import { createAndPair, makeWorker, userHeaders } from "./harness";

const SEARCH_CRITERIA = { keywords: ["openai"], min_faves: 5, lang: "en" };

type VerdictMode = "reply" | "quote" | "skip" | "garbage";
type ContentMode = "ok" | "garbage" | "rate_limit";

let stubServer: Server;
let stubBaseUrl = "";
let stubCalls = 0;
let verdictMode: VerdictMode = "reply";
let contentMode: ContentMode = "ok";
let verdictPriority = 3;

function verdictBody(v: Record<string, unknown>) {
  return { choices: [{ message: { content: JSON.stringify(v) } }] };
}

beforeAll(async () => {
  stubServer = createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      stubCalls += 1;
      res.setHeader("content-type", "application/json");
      const body = raw ? (JSON.parse(raw) as { messages?: Array<{ role: string; content: string }> }) : {};
      const system = body.messages?.[0]?.content ?? "";
      if (system.includes("draft X")) {
        if (contentMode === "rate_limit") {
          res.statusCode = 429;
          res.end(JSON.stringify({ error: { message: "rate limited" } }));
        } else if (contentMode === "garbage") {
          res.end(JSON.stringify({ choices: [{ message: { content: "" } }] }));
        } else {
          res.end(JSON.stringify(verdictBody({ text: "generated reply text" })));
        }
        return;
      }
      switch (verdictMode) {
        case "reply":
          res.end(JSON.stringify(verdictBody({ action: "reply", reason: "on-topic", priority: verdictPriority })));
          break;
        case "quote":
          res.end(JSON.stringify(verdictBody({ action: "quote", reason: "amplify", priority: verdictPriority })));
          break;
        case "skip":
          res.end(JSON.stringify(verdictBody({ action: "skip", reason: "not relevant", priority: 1 })));
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
  verdictMode = "reply";
  contentMode = "ok";
  verdictPriority = 3;
  stubCalls = 0;
});

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

async function createAutomation(mf: Miniflare, relayId: string, overrides: Record<string, unknown> = {}): Promise<{ automation_id: string }> {
  const res = await mf.dispatchFetch("http://localhost/api/automations", {
    method: "POST",
    headers: userHeaders(),
    body: JSON.stringify({ relay_id: relayId, search_criteria: SEARCH_CRITERIA, interval_minutes: 60, ...overrides }),
  });
  expect(res.status).toBe(201);
  return (await res.json()) as { automation_id: string };
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
  const search = (await pollCommandsFor(mf, relayId, token)).find((c) => c.type === "search")!;
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
): Promise<{ id: string; type: string; payload: Record<string, string> }[]> {
  const res = await mf.dispatchFetch(`http://localhost/api/relays/${relayId}/commands`, {
    headers: { authorization: `Bearer ${token}` },
  });
  expect(res.status).toBe(200);
  return ((await res.json()) as { commands: { id: string; type: string; payload: Record<string, string> }[] }).commands;
}

async function writeCommands(mf: Miniflare, relayId: string, token: string) {
  return (await pollCommandsFor(mf, relayId, token)).filter((c) => c.type !== "search");
}

async function runTarget(mf: Miniflare, automationId: string): Promise<{ status: number }> {
  const res = await mf.dispatchFetch("http://localhost/api/funnel/target", {
    method: "POST",
    headers: userHeaders(),
    body: JSON.stringify({ automation_id: automationId }),
  });
  expect(res.status).toBe(200);
  return { status: res.status };
}

type DraftRow = {
  id: number;
  tweet_id: string;
  author: string;
  action: string;
  reason: string;
  priority: number;
  status: string;
  text: string;
  command_id: string | null;
  result_tweet_id: string | null;
  executed_at: number | null;
  decided_at: number | null;
  automation_name: string;
};

async function listDrafts(mf: Miniflare, email = "alice@example.com"): Promise<{ drafts: DraftRow[] }> {
  const res = await mf.dispatchFetch("http://localhost/api/drafts", { headers: userHeaders(email, false) });
  expect(res.status).toBe(200);
  return (await res.json()) as { drafts: DraftRow[] };
}

async function setup(
  mf: Miniflare,
  tweetCount = 3,
  overrides: Record<string, unknown> = {},
): Promise<{ relay_id: string; token: string; automation_id: string }> {
  const { relay_id, token } = await createAndPair(mf, "alice-relay", "alice@example.com");
  const { automation_id } = await createAutomation(mf, relay_id, overrides);
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

async function reportResult(mf: Miniflare, relayId: string, token: string, commandId: string, ok: boolean, output: Record<string, unknown> = {}): Promise<void> {
  const res = await mf.dispatchFetch(`http://localhost/api/relays/${relayId}/results`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ results: [{ command_id: commandId, ok, output }] }),
  });
  expect(res.status).toBe(200);
}

function hh(ms: number): string {
  const d = new Date(ms);
  return `${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}`;
}

describe("inbox approve/reject (manual mode)", () => {
  it("approve executes through the relay and the write result marks the draft done", async () => {
    const mf = await makeWorker();
    try {
      const { relay_id, token, automation_id } = await setup(mf, 1);
      await runTarget(mf, automation_id);
      const { drafts } = await listDrafts(mf);
      expect(drafts).toHaveLength(1);
      expect(drafts[0]).toMatchObject({ status: "ready", action: "reply", text: "generated reply text" });

      const approve = await mf.dispatchFetch(`http://localhost/api/drafts/${drafts[0].id}/approve`, {
        method: "POST",
        headers: userHeaders(),
        body: "{}",
      });
      expect(approve.status).toBe(200);
      const approval = (await approve.json()) as { status: string; command_id: string };
      expect(approval).toMatchObject({ status: "executing" });

      const writes = await writeCommands(mf, relay_id, token);
      expect(writes).toHaveLength(1);
      expect(writes[0].type).toBe("reply");
      expect(writes[0].payload).toMatchObject({
        draft_id: String(drafts[0].id),
        text: "generated reply text",
        in_reply_to_tweet_id: "t1",
      });

      const db = await mf.getD1Database("DB");
      const dup = (await db.prepare("SELECT tweet_id, action FROM dedup WHERE user_id = ? AND tweet_id = ?")
        .bind("alice@example.com", "t1")
        .first()) as { tweet_id: string; action: string };
      expect(dup).toEqual({ tweet_id: "t1", action: "reply" });

      const afterApprove = await listDrafts(mf);
      expect(afterApprove.drafts[0]).toMatchObject({ status: "executing", command_id: writes[0].id, decided_at: expect.any(Number) });

      await reportResult(mf, relay_id, token, writes[0].id, true, { tweet_id: "999" });
      const done = await listDrafts(mf);
      expect(done.drafts[0]).toMatchObject({ status: "done", result_tweet_id: "999", executed_at: expect.any(Number) });
    } finally {
      await mf.dispose();
    }
  });

  it("approve honors a text override, and a quote builds the permalink payload", async () => {
    const mf = await makeWorker();
    try {
      verdictMode = "quote";
      const { relay_id, token, automation_id } = await setup(mf, 1);
      await runTarget(mf, automation_id);
      const { drafts } = await listDrafts(mf);

      const approve = await mf.dispatchFetch(`http://localhost/api/drafts/${drafts[0].id}/approve`, {
        method: "POST",
        headers: userHeaders(),
        body: JSON.stringify({ text: "my override text" }),
      });
      expect(approve.status).toBe(200);

      const writes = await writeCommands(mf, relay_id, token);
      expect(writes[0].type).toBe("quote");
      expect(writes[0].payload).toMatchObject({
        text: "my override text",
        attachment_url: "https://x.com/bob/status/t1",
      });
      const { drafts: after } = await listDrafts(mf);
      expect(after[0].text).toBe("my override text");
    } finally {
      await mf.dispose();
    }
  });

  it("a rejected draft is never re-judged by a later targeting run", async () => {
    const mf = await makeWorker();
    try {
      const { automation_id } = await setup(mf, 2);
      await runTarget(mf, automation_id);
      const callsAfterFirst = stubCalls;
      expect(callsAfterFirst).toBe(4); // 2 verdicts + 2 content calls

      const { drafts } = await listDrafts(mf);
      await mf.dispatchFetch(`http://localhost/api/drafts/${drafts[0].id}/reject`, {
        method: "POST",
        headers: userHeaders(),
        body: "{}",
      });

      const again = await mf.dispatchFetch("http://localhost/api/funnel/target", {
        method: "POST",
        headers: userHeaders(),
        body: JSON.stringify({ automation_id }),
      });
      expect(again.status).toBe(200);
      const body = (await again.json()) as { automations: Array<{ judged: number }> };
      expect(body.automations[0].judged).toBe(0);
      expect(stubCalls).toBe(callsAfterFirst);
    } finally {
      await mf.dispose();
    }
  });

  it("reject enqueues nothing, writes no dedupe row, and is terminal", async () => {
    const mf = await makeWorker();
    try {
      const { relay_id, token, automation_id } = await setup(mf, 2);
      await runTarget(mf, automation_id);
      const { drafts } = await listDrafts(mf);
      expect(drafts).toHaveLength(2);

      const reject = await mf.dispatchFetch(`http://localhost/api/drafts/${drafts[0].id}/reject`, {
        method: "POST",
        headers: userHeaders(),
        body: "{}",
      });
      expect(reject.status).toBe(200);
      expect(await reject.json()).toMatchObject({ status: "rejected" });

      expect(await writeCommands(mf, relay_id, token)).toHaveLength(0);
      const db = await mf.getD1Database("DB");
      const dup = await db.prepare("SELECT tweet_id FROM dedup WHERE user_id = ? AND tweet_id = ?")
        .bind("alice@example.com", "t1")
        .first();
      expect(dup).toBeNull();

      const { drafts: after } = await listDrafts(mf);
      expect(after.find((d) => d.id === drafts[0].id)).toMatchObject({ status: "rejected", decided_at: expect.any(Number) });

      const reapprove = await mf.dispatchFetch(`http://localhost/api/drafts/${drafts[0].id}/approve`, {
        method: "POST",
        headers: userHeaders(),
        body: "{}",
      });
      expect(reapprove.status).toBe(409);
      expect((await reapprove.json())).toMatchObject({ error: "draft is not decidable" });
    } finally {
      await mf.dispose();
    }
  });

  it("validates approve: 404 for other users, 400 for empty text, 409 when safety-blocked", async () => {
    const mf = await makeWorker();
    try {
      const { relay_id, automation_id } = await setup(mf, 1);
      await runTarget(mf, automation_id);
      const { drafts } = await listDrafts(mf);

      const foreign = await mf.dispatchFetch(`http://localhost/api/drafts/${drafts[0].id}/approve`, {
        method: "POST",
        headers: userHeaders("bob@example.com"),
        body: "{}",
      });
      expect(foreign.status).toBe(404);

      const tooLong = await mf.dispatchFetch(`http://localhost/api/drafts/${drafts[0].id}/approve`, {
        method: "POST",
        headers: userHeaders(),
        body: JSON.stringify({ text: "x".repeat(300) }),
      });
      expect(tooLong.status).toBe(400);

      const db = await mf.getD1Database("DB");
      await db.prepare("INSERT INTO dedup (user_id, relay_id, tweet_id, action, acted_at) VALUES (?, ?, ?, ?, ?)")
        .bind("alice@example.com", relay_id, "t1", "reply", Math.floor(Date.now() / 1000))
        .run();
      const blocked = await mf.dispatchFetch(`http://localhost/api/drafts/${drafts[0].id}/approve`, {
        method: "POST",
        headers: userHeaders(),
        body: JSON.stringify({ text: "fine text" }),
      });
      expect(blocked.status).toBe(409);
      expect((await blocked.json())).toMatchObject({ error: "tweet already engaged elsewhere" });
    } finally {
      await mf.dispose();
    }
  });

  it("approve is blocked by the kill switch even with a valid override", async () => {
    const mf = await makeWorker();
    try {
      const { relay_id, automation_id } = await setup(mf, 1);
      await runTarget(mf, automation_id);
      const { drafts } = await listDrafts(mf);

      await mf.dispatchFetch(`http://localhost/api/relays/${relay_id}/enabled`, {
        method: "POST",
        headers: userHeaders(),
        body: JSON.stringify({ enabled: false }),
      });
      const approve = await mf.dispatchFetch(`http://localhost/api/drafts/${drafts[0].id}/approve`, {
        method: "POST",
        headers: userHeaders(),
        body: "{}",
      });
      expect(approve.status).toBe(409);
      expect((await approve.json())).toMatchObject({ error: "account is kill-switched off" });
    } finally {
      await mf.dispose();
    }
  });

  it("a failed relay write marks the draft failed, and the tick does not retry it", async () => {
    const mf = await makeWorker();
    try {
      const { relay_id, token, automation_id } = await setup(mf, 1);
      await runTarget(mf, automation_id);
      const { drafts } = await listDrafts(mf);
      await mf.dispatchFetch(`http://localhost/api/drafts/${drafts[0].id}/approve`, {
        method: "POST",
        headers: userHeaders(),
        body: "{}",
      });

      const writes = await writeCommands(mf, relay_id, token);
      await reportResult(mf, relay_id, token, writes[0].id, false);

      const { drafts: after } = await listDrafts(mf);
      expect(after[0].status).toBe("failed");

      const db = await mf.getD1Database("DB");
      await runScheduled({ cron: TICK_CRON }, { DB: db });
      expect(await writeCommands(mf, relay_id, token)).toHaveLength(0);
      expect((await listDrafts(mf)).drafts[0].status).toBe("failed");
    } finally {
      await mf.dispose();
    }
  });

  it("a successful write without a tweet id marks the draft failed, never hanging", async () => {
    const mf = await makeWorker();
    try {
      const { relay_id, token, automation_id } = await setup(mf, 1);
      await runTarget(mf, automation_id);
      const { drafts } = await listDrafts(mf);
      await mf.dispatchFetch(`http://localhost/api/drafts/${drafts[0].id}/approve`, {
        method: "POST",
        headers: userHeaders(),
        body: "{}",
      });
      const writes = await writeCommands(mf, relay_id, token);
      await reportResult(mf, relay_id, token, writes[0].id, true, {});

      expect((await listDrafts(mf)).drafts[0].status).toBe("failed");
    } finally {
      await mf.dispose();
    }
  });
});

describe("execution modes", () => {
  it("manual mode: the tick never executes ready drafts", async () => {
    const mf = await makeWorker();
    try {
      const { relay_id, token, automation_id } = await setup(mf, 2);
      await runTarget(mf, automation_id);
      expect((await listDrafts(mf)).drafts.filter((d) => d.status === "ready")).toHaveLength(2);

      const db = await mf.getD1Database("DB");
      await runScheduled({ cron: TICK_CRON }, { DB: db });

      expect(await writeCommands(mf, relay_id, token)).toHaveLength(0);
      expect((await listDrafts(mf)).drafts.every((d) => d.status === "ready")).toBe(true);
    } finally {
      await mf.dispose();
    }
  });

  it("auto mode: the tick executes ready drafts, dedupes, and marks them executing", async () => {
    const mf = await makeWorker();
    try {
      const { relay_id, token, automation_id } = await setup(mf, 3, { mode: { mode: "auto", auto_threshold: 4 } });
      await runTarget(mf, automation_id);
      expect((await listDrafts(mf)).drafts).toHaveLength(3);

      const db = await mf.getD1Database("DB");
      await runScheduled({ cron: TICK_CRON }, { DB: db });

      const writes = await writeCommands(mf, relay_id, token);
      expect(writes).toHaveLength(3);
      expect(writes.every((w) => w.type === "reply" && w.payload.in_reply_to_tweet_id)).toBe(true);
      const { drafts } = await listDrafts(mf);
      expect(drafts.every((d) => d.status === "executing" && d.command_id)).toBe(true);
      const dupes = (await db.prepare("SELECT COUNT(*) AS n FROM dedup WHERE user_id = ?").bind("alice@example.com").first()) as { n: number };
      expect(dupes.n).toBe(3);
    } finally {
      await mf.dispose();
    }
  });

  it("hybrid mode: below-threshold drafts auto-execute, at/above-threshold stay in the inbox", async () => {
    const mf = await makeWorker();
    try {
      const { relay_id, token, automation_id } = await setup(mf, 1, { mode: { mode: "hybrid", auto_threshold: 4 } });

      verdictPriority = 5;
      await runTarget(mf, automation_id);
      expect((await listDrafts(mf)).drafts[0]).toMatchObject({ priority: 5, status: "ready" });

      const db = await mf.getD1Database("DB");
      await runScheduled({ cron: TICK_CRON }, { DB: db });
      expect(await writeCommands(mf, relay_id, token)).toHaveLength(0);
      expect((await listDrafts(mf)).drafts[0].status).toBe("ready");

      verdictPriority = 3;
      await ingestCandidates(mf, relay_id, token, automation_id, [tweet("t9")]);
      await runTarget(mf, automation_id);
      await runScheduled({ cron: TICK_CRON }, { DB: db });

      const writes = await writeCommands(mf, relay_id, token);
      expect(writes).toHaveLength(1);
      const { drafts } = await listDrafts(mf);
      expect(drafts.find((d) => d.tweet_id === "t9")).toMatchObject({ priority: 3, status: "executing" });
      expect(drafts.find((d) => d.tweet_id === "t1")).toMatchObject({ priority: 5, status: "ready" });
    } finally {
      await mf.dispose();
    }
  });

  it("auto execution honours budgets and quiet hours, leaving drafts ready", async () => {
    const mf = await makeWorker();
    try {
      const now = Date.now();
      const { relay_id, token, automation_id } = await setup(mf, 2, {
        mode: { mode: "auto", auto_threshold: 4 },
        budgets: {
          max_posts_per_day: 10,
          max_replies_per_day: 0,
          quiet_hours: { start: hh(now - 3600_000), end: hh(now + 3600_000) },
        },
      });
      await runTarget(mf, automation_id);

      const db = await mf.getD1Database("DB");
      await runScheduled({ cron: TICK_CRON }, { DB: db });

      expect(await writeCommands(mf, relay_id, token)).toHaveLength(0);
      expect((await listDrafts(mf)).drafts.every((d) => d.status === "ready")).toBe(true);
    } finally {
      await mf.dispose();
    }
  });

  it("auto execution respects the kill switch and cross-account dedupe", async () => {
    const mf = await makeWorker();
    try {
      const { relay_id, token, automation_id } = await setup(mf, 3, { mode: { mode: "auto", auto_threshold: 4 } });
      const db = await mf.getD1Database("DB");
      await db.prepare("INSERT INTO dedup (user_id, relay_id, tweet_id, action, acted_at) VALUES (?, ?, ?, ?, ?)")
        .bind("alice@example.com", relay_id, "t1", "reply", Math.floor(Date.now() / 1000))
        .run();
      await runTarget(mf, automation_id);

      await runScheduled({ cron: TICK_CRON }, { DB: db });
      const writes = await writeCommands(mf, relay_id, token);
      expect(writes).toHaveLength(2);
      expect(writes.every((w) => w.payload.in_reply_to_tweet_id !== "t1")).toBe(true);

      await mf.dispatchFetch(`http://localhost/api/relays/${relay_id}/enabled`, {
        method: "POST",
        headers: userHeaders(),
        body: JSON.stringify({ enabled: false }),
      });
      await ingestCandidates(mf, relay_id, token, automation_id, [tweet("t9")]);
      await runTarget(mf, automation_id);
      await runScheduled({ cron: TICK_CRON }, { DB: db });
      expect(await writeCommands(mf, relay_id, token)).toHaveLength(0);
      // Kill switch blocks the target pass too: t9 is never judged, so no draft.
      expect((await listDrafts(mf)).drafts.some((d) => d.tweet_id === "t9")).toBe(false);
    } finally {
      await mf.dispose();
    }
  });
});

describe("content lifecycle", () => {
  it("content failures land content_failed and the hourly maintenance retries them", async () => {
    const mf = await makeWorker();
    try {
      contentMode = "garbage";
      const { relay_id, token, automation_id } = await setup(mf, 2);
      await runTarget(mf, automation_id);

      let { drafts } = await listDrafts(mf);
      expect(drafts.every((d) => d.status === "content_failed" && d.text === "")).toBe(true);

      const db = await mf.getD1Database("DB");
      await runScheduled({ cron: TICK_CRON }, { DB: db });
      expect(await writeCommands(mf, relay_id, token)).toHaveLength(0);
      expect((await listDrafts(mf)).drafts.every((d) => d.status === "content_failed")).toBe(true);

      contentMode = "ok";
      await runScheduled({ cron: MAINT_CRON }, { DB: db });
      drafts = (await listDrafts(mf)).drafts;
      expect(drafts.every((d) => d.status === "ready" && d.text === "generated reply text")).toBe(true);
    } finally {
      await mf.dispose();
    }
  });

  it("approving a content_failed draft requires a text override", async () => {
    const mf = await makeWorker();
    try {
      contentMode = "garbage";
      const { relay_id, token, automation_id } = await setup(mf, 1);
      await runTarget(mf, automation_id);
      const { drafts } = await listDrafts(mf);
      expect(drafts[0].status).toBe("content_failed");

      const noText = await mf.dispatchFetch(`http://localhost/api/drafts/${drafts[0].id}/approve`, {
        method: "POST",
        headers: userHeaders(),
        body: "{}",
      });
      expect(noText.status).toBe(400);
      expect((await noText.json())).toMatchObject({ error: "draft has no text — provide one" });

      const withText = await mf.dispatchFetch(`http://localhost/api/drafts/${drafts[0].id}/approve`, {
        method: "POST",
        headers: userHeaders(),
        body: JSON.stringify({ text: "handwritten reply" }),
      });
      expect(withText.status).toBe(200);
      const writes = await writeCommands(mf, relay_id, token);
      expect(writes[0].payload.text).toBe("handwritten reply");
    } finally {
      await mf.dispose();
    }
  });
});
