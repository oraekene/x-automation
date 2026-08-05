// Ticket 12: conversations (inbound multi-turn). Tests inbound tweet processing,
// conversation creation, dedup, max turns cap, semantic verdict, conversation
// sweeper, and the conversations/settings API routes.

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Miniflare } from "miniflare";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { TICK_CRON, MAINT_CRON, runScheduled } from "../src/scheduled";
import { createAndPair, makeWorker, userHeaders } from "./harness";

type TurnMode = "continue" | "close_with_message" | "close_silent" | "error";

let stubServer: Server;
let stubBaseUrl = "";
let turnMode: TurnMode = "continue";

function turnBody(v: Record<string, unknown>) {
  return { choices: [{ message: { content: JSON.stringify(v) } }] };
}

beforeAll(async () => {
  stubServer = createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      res.setHeader("content-type", "application/json");
      const body = raw ? (JSON.parse(raw) as { messages?: Array<{ role: string; content: string }> }) : {};
      const system = body.messages?.[0]?.content ?? "";

      // Conversation turn generation
      if (system.includes("continuing a conversation")) {
        switch (turnMode) {
          case "continue":
            res.end(JSON.stringify(turnBody({ text: "Thanks for sharing!", verdict: "continue", reason: "conversation ongoing" })));
            break;
          case "close_with_message":
            res.end(JSON.stringify(turnBody({ text: "Great point, bye!", verdict: "close_with_message", reason: "goal met" })));
            break;
          case "close_silent":
            res.end(JSON.stringify(turnBody({ text: "", verdict: "close_silent", reason: "signal decay" })));
            break;
          case "error":
            res.statusCode = 500;
            res.end(JSON.stringify({ error: { message: "provider down" } }));
            break;
        }
        return;
      }

      // Targeting verdict (for funnel tests reused in setup)
      res.end(JSON.stringify(turnBody({ action: "reply", reason: "on-topic", priority: 3 })));
    });
  });
  await new Promise<void>((resolve) => stubServer.listen(0, "127.0.0.1", resolve));
  stubBaseUrl = `http://127.0.0.1:${(stubServer.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => stubServer.close(() => resolve()));
});

beforeEach(() => {
  turnMode = "continue";
});

async function setup(mf: Miniflare) {
  const { relay_id, token } = await createAndPair(mf);
  // Configure AI provider for alice
  await mf.dispatchFetch("http://localhost/api/provider", {
    method: "PUT",
    headers: userHeaders(),
    body: JSON.stringify({ base_url: stubBaseUrl, api_key: "test-key", model: "gpt-4o-mini" }),
  });
  return { relay_id, token };
}

async function scanInbound(mf: Miniflare, relayId: string, token: string, tweets: unknown[]) {
  // Create an inbound_scan command first so the results handler can find it
  const db = await mf.getD1Database("DB");
  const cmdId = crypto.randomUUID();
  const nowSec = Math.floor(Date.now() / 1000);
  await db.prepare(
    "INSERT INTO commands (id, relay_id, type, payload, status, attempts, created_at) VALUES (?, ?, 'inbound_scan', '{}', 'pending', 0, ?)",
  ).bind(cmdId, relayId, nowSec).run();

  const res = await mf.dispatchFetch(`http://localhost/api/relays/${relayId}/results`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({
      results: [{ command_id: cmdId, ok: true, output: { tweets } }],
    }),
  });
  return res;
}

async function listConversations(mf: Miniflare) {
  const res = await mf.dispatchFetch("http://localhost/api/conversations", { headers: userHeaders() });
  return (await res.json()) as { conversations: Array<{ id: string; status: string; turn_count: number }> };
}

describe("inbound tweet processing", () => {
  it("creates a conversation and reply draft from an inbound tweet", async () => {
    const mf = await makeWorker();
    try {
      const { relay_id, token } = await setup(mf);
      const inboundTweet = {
        id: "t1",
        author: "bob",
        text: "Hey, what do you think about this?",
        in_reply_to_tweet_id: "user-own-tweet-1",
      };

      await scanInbound(mf, relay_id, token, [inboundTweet]);

      const { conversations } = await listConversations(mf);
      expect(conversations).toHaveLength(1);
      expect(conversations[0].status).toBe("open");
      expect(conversations[0].turn_count).toBe(0);

      // Check that a reply draft was created via DB
      const db = await mf.getD1Database("DB");
      const convDraft = await db.prepare("SELECT id, action, conversation_id, status FROM drafts WHERE conversation_id = ?")
        .bind(conversations[0].id)
        .first();
      expect(convDraft).toBeDefined();
      expect(convDraft!.action).toBe("reply");
      expect(convDraft!.status).toBe("executing");
    } finally {
      await mf.dispose();
    }
  });

  it("deduplicates the same tweet_id", async () => {
    const mf = await makeWorker();
    try {
      const { relay_id, token } = await setup(mf);
      const inboundTweet = {
        id: "t-dedup",
        author: "bob",
        text: "Hello!",
        in_reply_to_tweet_id: "user-own-tweet-2",
      };

      await scanInbound(mf, relay_id, token, [inboundTweet]);
      await scanInbound(mf, relay_id, token, [inboundTweet]);

      const { conversations } = await listConversations(mf);
      expect(conversations).toHaveLength(1);
    } finally {
      await mf.dispose();
    }
  });

  it("continues an existing conversation on reply thread", async () => {
    const mf = await makeWorker();
    try {
      const { relay_id, token } = await setup(mf);

      // First turn: opens conversation
      await scanInbound(mf, relay_id, token, [{
        id: "t-first",
        author: "bob",
        text: "First message",
        in_reply_to_tweet_id: "user-own-tweet-3",
      }]);

      const { conversations: convs1 } = await listConversations(mf);
      expect(convs1).toHaveLength(1);
      const convId = convs1[0].id;

      // Simulate the outbound tweet being posted (relay reports success)
      const db = await mf.getD1Database("DB");
      const draft = (await db.prepare("SELECT id FROM drafts WHERE conversation_id = ? LIMIT 1").bind(convId).first()) as { id: string };
      await db.prepare("UPDATE drafts SET status = 'done', result_tweet_id = 'outbound-1' WHERE id = ?").bind(draft.id).run();
      await db.prepare("UPDATE messages SET tweet_id = 'outbound-1' WHERE draft_id = ? AND role = 'outbound'").bind(draft.id).run();

      // Verify the outbound message has the tweet_id
      const outMsg = await db.prepare("SELECT tweet_id FROM messages WHERE conversation_id = ? AND role = 'outbound'").bind(convId).first() as { tweet_id: string };
      expect(outMsg.tweet_id).toBe("outbound-1");

      // Second turn: continues conversation (reply to the outbound tweet)
      await scanInbound(mf, relay_id, token, [{
        id: "t-second",
        author: "bob",
        text: "Second message",
        in_reply_to_tweet_id: "outbound-1",
      }]);

      const { conversations: convs2 } = await listConversations(mf);
      expect(convs2).toHaveLength(1);
      expect(convs2[0].turn_count).toBe(1);
    } finally {
      await mf.dispose();
    }
  });

  it("closes conversation with close_with_message verdict", async () => {
    const mf = await makeWorker();
    try {
      const { relay_id, token } = await setup(mf);
      turnMode = "close_with_message";

      await scanInbound(mf, relay_id, token, [{
        id: "t-close",
        author: "bob",
        text: "Thanks for the help!",
        in_reply_to_tweet_id: "user-own-tweet-4",
      }]);

      const { conversations } = await listConversations(mf);
      expect(conversations).toHaveLength(1);
      expect(conversations[0].status).toBe("closed");
    } finally {
      await mf.dispose();
    }
  });

  it("closes conversation silently with close_silent verdict", async () => {
    const mf = await makeWorker();
    try {
      const { relay_id, token } = await setup(mf);
      turnMode = "close_silent";

      await scanInbound(mf, relay_id, token, [{
        id: "t-silent",
        author: "bob",
        text: "Whatever",
        in_reply_to_tweet_id: "user-own-tweet-5",
      }]);

      const { conversations } = await listConversations(mf);
      expect(conversations).toHaveLength(1);
      expect(conversations[0].status).toBe("closed");

      // No reply draft should be created for close_silent
      const db = await mf.getD1Database("DB");
      const silentDrafts = (await db.prepare("SELECT COUNT(*) as n FROM conversations WHERE id IN (SELECT conversation_id FROM drafts WHERE conversation_id IS NOT NULL)").first()) as { n: number };
      // The conversation has no outbound draft (close_silent = no reply)
      const msgs = (await db.prepare("SELECT role FROM messages WHERE conversation_id = (SELECT id FROM conversations WHERE root_tweet_id = 'user-own-tweet-5')").all()) as { results: Array<{ role: string }> };
      const outboundCount = msgs.results.filter((m) => m.role === "outbound").length;
      expect(outboundCount).toBe(0);
    } finally {
      await mf.dispose();
    }
  });

  it("skips tweets without in_reply_to_tweet_id", async () => {
    const mf = await makeWorker();
    try {
      const { relay_id, token } = await setup(mf);

      await scanInbound(mf, relay_id, token, [{
        id: "t-no-reply",
        author: "bob",
        text: "Standalone tweet",
        in_reply_to_tweet_id: null,
      }]);

      const { conversations } = await listConversations(mf);
      expect(conversations).toHaveLength(0);
    } finally {
      await mf.dispose();
    }
  });
});

describe("max turns cap", () => {
  it("blocks new turns after reaching max_turns", async () => {
    const mf = await makeWorker();
    try {
      const { relay_id, token } = await setup(mf);

      // Set max_turns to 2
      await mf.dispatchFetch("http://localhost/api/conversations/settings", {
        method: "PUT",
        headers: userHeaders(),
        body: JSON.stringify({ max_turns: 2 }),
      });

      // Turn 1: opens conversation
      await scanInbound(mf, relay_id, token, [{
        id: "t-turn1",
        author: "bob",
        text: "First",
        in_reply_to_tweet_id: "user-own-tweet-6",
      }]);

      // Simulate outbound tweet
      const db = await mf.getD1Database("DB");
      const draft1 = (await db.prepare("SELECT id FROM drafts WHERE conversation_id IS NOT NULL ORDER BY created_at DESC LIMIT 1").first()) as { id: string };
      await db.prepare("UPDATE drafts SET status = 'done', result_tweet_id = 'outbound-t1' WHERE id = ?").bind(draft1.id).run();
      await db.prepare("UPDATE messages SET tweet_id = 'outbound-t1' WHERE draft_id = ? AND role = 'outbound'").bind(draft1.id).run();

      // Turn 2: continues
      await scanInbound(mf, relay_id, token, [{
        id: "t-turn2",
        author: "bob",
        text: "Second",
        in_reply_to_tweet_id: "outbound-t1",
      }]);

      const conv = (await db.prepare("SELECT turn_count FROM conversations WHERE root_tweet_id = 'user-own-tweet-6'").first()) as { turn_count: number };
      expect(conv.turn_count).toBe(1); // turn_count after turn 2 processed

      // Simulate outbound for turn 2
      const draft2 = (await db.prepare("SELECT id FROM drafts WHERE conversation_id IS NOT NULL ORDER BY created_at DESC LIMIT 1").first()) as { id: string };
      await db.prepare("UPDATE drafts SET status = 'done', result_tweet_id = 'outbound-t2' WHERE id = ?").bind(draft2.id).run();
      await db.prepare("UPDATE messages SET tweet_id = 'outbound-t2' WHERE draft_id = ? AND role = 'outbound'").bind(draft2.id).run();

      // Turn 3: should be blocked (max_turns = 2, turn_count = 2 after increment)
      // We need turn_count to reach max before blocking. Let's check the logic.
      // After turn 2 batch: turn_count becomes 2 (incremented in batch). max_turns = 2.
      // Turn 3: conv.turn_count (2) >= max_turns (2) → blocked.
      await scanInbound(mf, relay_id, token, [{
        id: "t-turn3",
        author: "bob",
        text: "Third - should be blocked",
        in_reply_to_tweet_id: "outbound-t2",
      }]);

      const draftsAfter = (await db.prepare("SELECT COUNT(*) as n FROM drafts WHERE conversation_id = (SELECT id FROM conversations WHERE root_tweet_id = 'user-own-tweet-6')").first()) as { n: number };
      // Only 2 drafts (turns 1 and 2), turn 3 blocked
      expect(draftsAfter.n).toBe(2);
    } finally {
      await mf.dispose();
    }
  });
});

describe("conversation sweeper", () => {
  it("closes conversations inactive beyond inactivity_minutes", async () => {
    const mf = await makeWorker();
    try {
      const { relay_id, token } = await setup(mf);

      // Set very short inactivity (1 minute)
      await mf.dispatchFetch("http://localhost/api/conversations/settings", {
        method: "PUT",
        headers: userHeaders(),
        body: JSON.stringify({ inactivity_minutes: 1 }),
      });

      // Create conversation
      await scanInbound(mf, relay_id, token, [{
        id: "t-sweep",
        author: "bob",
        text: "Sweep me",
        in_reply_to_tweet_id: "user-own-tweet-7",
      }]);

      const { conversations: before } = await listConversations(mf);
      expect(before[0].status).toBe("open");

      // Backdate last_turn_at to 2 minutes ago
      const db = await mf.getD1Database("DB");
      const twoMinAgo = Math.floor(Date.now() / 1000) - 120;
      await db.prepare("UPDATE conversations SET last_turn_at = ? WHERE root_tweet_id = 'user-own-tweet-7'")
        .bind(twoMinAgo)
        .run();

      await runScheduled({ cron: MAINT_CRON }, { DB: db });

      const { conversations: after } = await listConversations(mf);
      expect(after[0].status).toBe("closed");
    } finally {
      await mf.dispose();
    }
  });
});

describe("conversations API", () => {
  it("GET /api/conversations lists conversations", async () => {
    const mf = await makeWorker();
    try {
      const { relay_id, token } = await setup(mf);

      await scanInbound(mf, relay_id, token, [{
        id: "t-list",
        author: "bob",
        text: "List me",
        in_reply_to_tweet_id: "user-own-tweet-8",
      }]);

      const res = await mf.dispatchFetch("http://localhost/api/conversations", { headers: userHeaders() });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { conversations: unknown[] };
      expect(body.conversations.length).toBeGreaterThanOrEqual(1);
    } finally {
      await mf.dispose();
    }
  });

  it("GET /api/conversations/:id returns conversation with messages", async () => {
    const mf = await makeWorker();
    try {
      const { relay_id, token } = await setup(mf);

      await scanInbound(mf, relay_id, token, [{
        id: "t-detail",
        author: "bob",
        text: "Detail me",
        in_reply_to_tweet_id: "user-own-tweet-9",
      }]);

      const { conversations } = await listConversations(mf);
      const res = await mf.dispatchFetch(`http://localhost/api/conversations/${conversations[0].id}`, { headers: userHeaders() });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { conversation: { id: string }; messages: unknown[] };
      expect(body.conversation.id).toBe(conversations[0].id);
      expect(body.messages.length).toBeGreaterThanOrEqual(1);
    } finally {
      await mf.dispose();
    }
  });

  it("PUT /api/conversations/settings updates settings", async () => {
    const mf = await makeWorker();
    try {
      await setup(mf);

      const res = await mf.dispatchFetch("http://localhost/api/conversations/settings", {
        method: "PUT",
        headers: userHeaders(),
        body: JSON.stringify({ max_turns: 3, daily_new_cap: 5 }),
      });
      expect(res.status).toBe(200);

      const settingsRes = await mf.dispatchFetch("http://localhost/api/conversations/settings/meta", { headers: userHeaders() });
      const body = (await settingsRes.json()) as { settings: { max_turns: number; daily_new_cap: number } };
      expect(body.settings.max_turns).toBe(3);
      expect(body.settings.daily_new_cap).toBe(5);
    } finally {
      await mf.dispose();
    }
  });
});

describe("tickConversations", () => {
  it("enqueues inbound_scan for relays with open conversations", async () => {
    const mf = await makeWorker();
    try {
      const { relay_id, token } = await setup(mf);

      // Create an open conversation
      await scanInbound(mf, relay_id, token, [{
        id: "t-tick",
        author: "bob",
        text: "Tick me",
        in_reply_to_tweet_id: "user-own-tweet-10",
      }]);

      const db = await mf.getD1Database("DB");
      await runScheduled({ cron: TICK_CRON }, { DB: db });

      // The relay should have an inbound_scan command queued
      const cmds = (await db.prepare("SELECT type FROM commands WHERE relay_id = ? AND type = 'inbound_scan'").bind(relay_id).all()) as { results: Array<{ type: string }> };
      expect(cmds.results.length).toBeGreaterThanOrEqual(1);
    } finally {
      await mf.dispose();
    }
  });
});
