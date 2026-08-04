// Ticket 10: the OpenAI-compatible targeting client. A real HTTP server plays
// the provider (the spec's "AI provider mocked as an OpenAI-compatible stub at
// the Worker boundary"), so the client's wire format, auth header, tolerant
// JSON extraction, and error mapping are all exercised for real.

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import {
  aiTargetingVerdict,
  draftContent,
  maskApiKey,
  PROVIDER_PRESETS,
  type TargetingVerdict,
} from "../../src/lib/ai";

let server: Server;
let baseUrl = "";
let lastRequest: { method?: string; path?: string; auth?: string | undefined; body: Record<string, unknown> } = {
  body: {},
};
let response: { status: number; body: unknown };

const candidate = {
  author: "@alice",
  text: "TypeScript enums are a footgun in our codebase.",
  score: 82,
  automationName: "TS hot takes",
  profile: '{"persona":"senior TS dev","exclusions":"recruiters"}',
};

function stubResponse(verdict: Record<string, unknown>): { status: number; body: unknown } {
  return {
    status: 200,
    body: { choices: [{ message: { content: JSON.stringify(verdict) } }] },
  };
}

beforeAll(async () => {
  server = createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      lastRequest = {
        method: req.method,
        path: req.url,
        auth: req.headers.authorization,
        body: raw ? (JSON.parse(raw) as Record<string, unknown>) : {},
      };
      res.statusCode = response.status;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(response.body));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  lastRequest = { body: {} };
  response = stubResponse({ action: "skip", reason: "irrelevant", priority: 1 });
});

describe("aiTargetingVerdict", () => {
  it("POSTs to /chat/completions with Bearer auth and the candidate context", async () => {
    response = stubResponse({ action: "reply", reason: "on-topic", priority: 3 });

    const out = await aiTargetingVerdict({ baseUrl, apiKey: "sk-test", model: "m1", candidate });

    expect(out).toEqual({ ok: true, verdict: { action: "reply", reason: "on-topic", priority: 3 } });
    expect(lastRequest.method).toBe("POST");
    expect(lastRequest.path).toBe("/chat/completions");
    expect(lastRequest.auth).toBe("Bearer sk-test");
    expect(lastRequest.body.model).toBe("m1");
    const messages = lastRequest.body.messages as Array<{ role: string; content: string }>;
    expect(messages).toHaveLength(2);
    expect(messages[0]?.role).toBe("system");
    expect(messages[1]?.role).toBe("user");
    expect(messages[1]?.content).toContain("@alice");
    expect(messages[1]?.content).toContain("TypeScript enums are a footgun in our codebase.");
    expect(messages[1]?.content).toContain("TS hot takes");
    expect(messages[1]?.content).toContain("senior TS dev");
    expect(messages[1]?.content).toContain("exclusions");
  });

  it("parses a verdict wrapped in a json code fence", async () => {
    response = {
      status: 200,
      body: {
        choices: [
          {
            message: {
              content:
                '```json\n{"action":"quote","reason":"worth amplifying","priority":4}\n```',
            },
          },
        ],
      },
    };

    const out = await aiTargetingVerdict({ baseUrl, apiKey: "k", model: "m", candidate });

    expect(out).toEqual({
      ok: true,
      verdict: { action: "quote", reason: "worth amplifying", priority: 4 },
    });
  });

  it("extracts the verdict from surrounding prose", async () => {
    response = {
      status: 200,
      body: {
        choices: [
          {
            message: {
              content:
                'Sure! The verdict is {"action":"reply","reason":"clearly relevant","priority":5}. Hope that helps!',
            },
          },
        ],
      },
    };

    const out = await aiTargetingVerdict({ baseUrl, apiKey: "k", model: "m", candidate });

    expect(out.ok && out.verdict.action).toBe("reply");
  });

  it("maps a 429 to http_429", async () => {
    response = { status: 429, body: { error: { message: "rate limited" } } };

    const out = await aiTargetingVerdict({ baseUrl, apiKey: "k", model: "m", candidate });

    expect(out).toEqual({ ok: false, error: "http_429" });
  });

  it("maps a 500 to http_500", async () => {
    response = { status: 500, body: {} };

    const out = await aiTargetingVerdict({ baseUrl, apiKey: "k", model: "m", candidate });

    expect(out).toEqual({ ok: false, error: "http_500" });
  });

  it("maps unparseable 200 content to a parse error", async () => {
    response = { status: 200, body: { choices: [{ message: { content: "definitely not json" } }] } };

    const out = await aiTargetingVerdict({ baseUrl, apiKey: "k", model: "m", candidate });

    expect(out.ok).toBe(false);
    expect(out.ok || out.error).toBe("parse");
  });

  it("rejects an invalid action as invalid, not parse", async () => {
    response = stubResponse({ action: "like", reason: "x", priority: 2 } as unknown as TargetingVerdict);

    const out = await aiTargetingVerdict({ baseUrl, apiKey: "k", model: "m", candidate });

    expect(out.ok).toBe(false);
    expect(out.ok || out.error).toBe("invalid");
  });

  it("rejects a missing reason as invalid", async () => {
    response = stubResponse({ action: "reply", priority: 2 } as unknown as TargetingVerdict);

    const out = await aiTargetingVerdict({ baseUrl, apiKey: "k", model: "m", candidate });

    expect(out.ok).toBe(false);
    expect(out.ok || out.error).toBe("invalid");
  });

  it("rejects a non-numeric priority as invalid", async () => {
    response = stubResponse({ action: "reply", reason: "x", priority: "high" } as unknown as TargetingVerdict);

    const out = await aiTargetingVerdict({ baseUrl, apiKey: "k", model: "m", candidate });

    expect(out.ok).toBe(false);
    expect(out.ok || out.error).toBe("invalid");
  });

  it("rejects an empty choices array as a parse error", async () => {
    response = { status: 200, body: { choices: [] } };

    const out = await aiTargetingVerdict({ baseUrl, apiKey: "k", model: "m", candidate });

    expect(out.ok).toBe(false);
    expect(out.ok || out.error).toBe("parse");
  });
});

describe("draftContent", () => {
  const contentCtx = () => ({
    baseUrl,
    apiKey: "sk-test",
    model: "m1",
    candidate: { ...candidate, profile: '{"persona":"senior TS dev"}' },
    action: "reply" as const,
    reason: "on-topic",
  });

  it("returns the text from a JSON response", async () => {
    response = stubResponse({ text: "Great point — we moved off enums and never looked back." });

    const out = await draftContent(contentCtx());

    expect(out).toEqual({ ok: true, text: "Great point — we moved off enums and never looked back." });
    const messages = lastRequest.body.messages as Array<{ role: string; content: string }>;
    expect(messages[1]?.content).toContain("@alice");
    expect(messages[1]?.content).toContain("reply");
  });

  it("parses a fenced JSON response", async () => {
    response = {
      status: 200,
      body: {
        choices: [{ message: { content: '```json\n{"text":"Agreed."}\n```' } }],
      },
    };

    const out = await draftContent(contentCtx());

    expect(out).toEqual({ ok: true, text: "Agreed." });
  });

  it("treats plain prose content as the draft text", async () => {
    response = { status: 200, body: { choices: [{ message: { content: "Just a plain reply text." } }] } };

    const out = await draftContent(contentCtx());

    expect(out).toEqual({ ok: true, text: "Just a plain reply text." });
  });

  it("maps a 429 to http_429", async () => {
    response = { status: 429, body: { error: {} } };

    const out = await draftContent(contentCtx());

    expect(out).toEqual({ ok: false, error: "http_429" });
  });

  it("rejects empty content as invalid", async () => {
    response = { status: 200, body: { choices: [{ message: { content: "   " } }] } };

    const out = await draftContent(contentCtx());

    expect(out.ok).toBe(false);
    expect(out.ok || out.error).toBe("invalid");
  });

  it("rejects content over 280 characters", async () => {
    response = stubResponse({ text: "x".repeat(281) });

    const out = await draftContent(contentCtx());

    expect(out.ok).toBe(false);
    expect(out.ok || out.error).toBe("too_long");
  });
});

describe("PROVIDER_PRESETS", () => {
  it("covers the free-endpoint menu from the spec", () => {
    const names = PROVIDER_PRESETS.map((p) => p.name);
    for (const expected of [
      "NVIDIA NIM",
      "OpenCode Zen",
      "Groq",
      "Gemini",
      "OpenRouter",
      "Cerebras",
      "Mistral",
      "GitHub Models",
      "Cloudflare Workers AI",
    ]) {
      expect(names).toContain(expected);
    }
    expect(PROVIDER_PRESETS.every((p) => p.base_url.startsWith("https://"))).toBe(true);
  });
});

describe("maskApiKey", () => {
  it("keeps the last 4 characters and masks the rest", () => {
    expect(maskApiKey("sk-abcdef123456")).toBe("••••••••3456");
  });

  it("never exposes more than 8 characters", () => {
    const masked = maskApiKey("short");
    expect(masked.length).toBeLessThanOrEqual(12);
    expect(masked.includes("short")).toBe(false);
  });
});
