import { describe, expect, it } from "vitest";
import {
  DEFAULT_BUDGETS,
  DEFAULT_RULES,
  applyGuardrails,
  filterCandidates,
  parseBudgets,
  parseRules,
} from "../../src/lib/funnel";
import { inQuietHours } from "../../src/lib/time";

// Fixed instant so scoring/guardrail tests are deterministic.
const NOW = Date.parse("2026-08-03T12:00:00Z");
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

function cand(overrides: Record<string, unknown> = {}) {
  return {
    id: "c-" + (overrides.tweet_id ?? "1"),
    user_id: "u1",
    automation_id: "a1",
    relay_id: "r1",
    tweet_id: "t-" + (overrides.tweet_id ?? "1"),
    author: "bob",
    text: "hello",
    created_at: "2026-08-03T09:00:00Z",
    favorite_count: 4,
    retweet_count: 2,
    reply_count: 1,
    lang: "en",
    source: "search" as const,
    found_at: Math.floor(NOW / 1000),
    ...overrides,
  };
}

describe("parseRules", () => {
  it("merges defaults and coerces fields", () => {
    const rules = parseRules({
      target_size: 10,
      weights: { engagement: 2 },
      blocklist: ["SPAMMY"],
      lang: "en",
    });
    expect(rules.target_size).toBe(10);
    expect(rules.weights).toEqual({ engagement: 2, freshness: 1, lang_bonus: 1 });
    expect(rules.blocklist).toEqual(["spammy"]);
    expect(rules.min_engagement).toBe(DEFAULT_RULES.min_engagement);
    expect(rules.max_age_days).toBe(DEFAULT_RULES.max_age_days);
  });

  it("falls back to safe values for nonsense input", () => {
    const r = parseRules({ target_size: -3, weights: { engagement: -1 }, max_per_author: 0, lang: 42 });
    expect(r.target_size).toBe(DEFAULT_RULES.target_size);
    expect(r.weights.engagement).toBe(DEFAULT_RULES.weights.engagement);
    expect(r.max_per_author).toBe(DEFAULT_RULES.max_per_author);
    expect(r.lang).toBeUndefined();
  });

  it("accepts empty input as defaults", () => {
    expect(parseRules(undefined)).toEqual(DEFAULT_RULES);
    expect(parseRules({})).toEqual(DEFAULT_RULES);
  });
});

describe("parseBudgets", () => {
  it("merges defaults and keeps quiet hours", () => {
    const b = parseBudgets({ max_replies_per_day: 5, quiet_hours: { start: "22:00", end: "07:00" } });
    expect(b.max_replies_per_day).toBe(5);
    expect(b.max_posts_per_day).toBe(DEFAULT_BUDGETS.max_posts_per_day);
    expect(b.quiet_hours).toEqual({ start: "22:00", end: "07:00" });
  });

  it("drops malformed quiet hours", () => {
    expect(parseBudgets({ quiet_hours: { start: "22", end: "07:00" } }).quiet_hours).toBeNull();
    expect(parseBudgets({ max_replies_per_day: "lots" }).max_replies_per_day).toBe(DEFAULT_BUDGETS.max_replies_per_day);
  });
});

describe("filterCandidates", () => {
  it("scores by engagement, freshness and language bonus", () => {
    const r = filterCandidates(
      [
        cand({ tweet_id: "hot", favorite_count: 100, retweet_count: 50, reply_count: 10, lang: "en" }),
        cand({ tweet_id: "yesterday", created_at: "2026-08-02T09:00:00Z" }),
      ],
      parseRules({ lang: "en" }),
      NOW,
    );
    const hot = r.kept.find((d) => d.candidateId.includes("hot"))!;
    const yesterday = r.kept.find((d) => d.candidateId.includes("yesterday"))!;
    expect(hot.score).toBeGreaterThan(yesterday.score);
    // The day-old tweet is still kept (within the default 30-day window) but scored lower.
    expect(yesterday.decision).toBe("keep");
  });

  it("rejects blocklisted authors case-insensitively without scoring", () => {
    const r = filterCandidates(
      [cand({ tweet_id: "bad", author: "Spammy" }), cand({ tweet_id: "good" })],
      parseRules({ blocklist: ["spammy"] }),
      NOW,
    );
    const bad = r.rejected.find((d) => d.candidateId.includes("bad"))!;
    expect(bad.rule).toBe("blocklist");
    expect(bad.score).toBe(0);
    expect(r.kept.map((d) => d.candidateId)).toContain("c-good");
  });

  it("keeps only allowlisted authors when the allowlist is non-empty", () => {
    const r = filterCandidates(
      [cand({ tweet_id: "a", author: "bob" }), cand({ tweet_id: "b", author: "carol" })],
      parseRules({ allowlist: ["bob"] }),
      NOW,
    );
    expect(r.kept).toHaveLength(1);
    expect(r.rejected[0].rule).toBe("allowlist");
  });

  it("rejects tweets older than max_age_days", () => {
    const r = filterCandidates(
      [cand({ tweet_id: "recent", created_at: "2026-08-01T00:00:00Z" }), cand({ tweet_id: "moldy", created_at: "2026-01-01T00:00:00Z" })],
      parseRules({ max_age_days: 7 }),
      NOW,
    );
    expect(r.kept.map((d) => d.candidateId)).toEqual(["c-recent"]);
    expect(r.rejected.find((d) => d.candidateId.includes("moldy"))!.rule).toBe("freshness");
  });

  it("rejects candidates below min_engagement", () => {
    const r = filterCandidates(
      [cand({ tweet_id: "quiet", favorite_count: 1, retweet_count: 0, reply_count: 0 })],
      parseRules({ min_engagement: 10 }),
      NOW,
    );
    expect(r.rejected[0].rule).toBe("engagement");
    expect(r.kept).toHaveLength(0);
  });

  it("filters out tweets whose language differs from the configured language", () => {
    const r = filterCandidates(
      [cand({ tweet_id: "english", lang: "en" }), cand({ tweet_id: "espanol", lang: "es" })],
      parseRules({ lang: "en" }),
      NOW,
    );
    expect(r.kept.map((d) => d.candidateId)).toEqual(["c-english"]);
    expect(r.rejected[0].rule).toBe("language");
  });

  it("leaves tweets with an unknown language alone when a language is configured", () => {
    const r = filterCandidates(
      [cand({ tweet_id: "unknown", lang: "" })],
      parseRules({ lang: "en" }),
      NOW,
    );
    expect(r.kept.map((d) => d.candidateId)).toEqual(["c-unknown"]);
  });

  it("caps the pool at target_size in score order", () => {
    const many = Array.from({ length: 6 }, (_, i) =>
      cand({ tweet_id: `c${i}`, author: `a${i}`, favorite_count: (i + 1) * 10 }),
    );
    const r = filterCandidates(many, parseRules({ target_size: 3, max_per_author: 6 }), NOW);
    expect(r.kept).toHaveLength(3);
    expect(r.rejected.filter((d) => d.rule === "target_size")).toHaveLength(3);
    const keptIds = r.kept.map((d) => parseInt(d.candidateId.split("-")[1].slice(1), 10));
    expect(keptIds).toEqual([5, 4, 3].sort((a, b) => b - a));
  });

  it("enforces a per-author diversity cap before target_size", () => {
    const r = filterCandidates(
      [cand({ tweet_id: "x1", author: "star", favorite_count: 90 }), cand({ tweet_id: "x2", author: "star", favorite_count: 5 }), cand({ tweet_id: "x3", author: "other" })],
      parseRules({ target_size: 2, max_per_author: 1 }),
      NOW,
    );
    // The first star tweet is kept; the second is cut for diversity.
    expect(r.kept.map((d) => d.candidateId)).toEqual(["c-x1", "c-x3"]);
    expect(r.rejected).toHaveLength(1);
    expect(r.rejected[0].rule).toBe("diversity");
  });
});

describe("inQuietHours", () => {
  const UTC = "UTC";
  it("is false with no quiet hours", () => {
    expect(inQuietHours(NOW, null, UTC)).toBe(false);
  });

  it("matches a same-day window", () => {
    const window = { start: "11:00", end: "13:00" };
    expect(inQuietHours(NOW, window, UTC)).toBe(true);
    expect(inQuietHours(NOW + 2 * HOUR, window, UTC)).toBe(false);
  });

  it("matches a window crossing midnight", () => {
    const window = { start: "22:00", end: "07:00" };
    const atNight = Date.parse("2026-08-03T03:00:00Z");
    const atDaytime = Date.parse("2026-08-03T12:00:00Z");
    expect(inQuietHours(atNight, window, UTC)).toBe(true);
    expect(inQuietHours(atDaytime, window, UTC)).toBe(false);
  });
});

describe("applyGuardrails", () => {
  const kept = [
    { candidateId: "c1", tweetId: "t1", decision: "keep" as const, rule: "target_size", reason: "", score: 1 },
  ];
  const ctx = (over: Partial<Parameters<typeof applyGuardrails>[1]> = {}) =>
    ({ budgets: { ...DEFAULT_BUDGETS, quiet_hours: null }, relayEnabled: true, timezone: "UTC", nowMs: NOW, dedupTweetIds: new Set<string>(), usage: { posts: 0, replies: 0 }, ...over });

  it("does not block a healthy candidate", () => {
    expect(applyGuardrails(kept, ctx())).toHaveLength(0);
  });

  it("blocks everything when the kill switch is on", () => {
    const b = applyGuardrails(kept, ctx({ relayEnabled: false }));
    expect(b).toHaveLength(1);
    expect(b[0].rule).toBe("kill_switch");
  });

  it("blocks tweets already acted on elsewhere (dedupe across automations/accounts)", () => {
    const b = applyGuardrails(kept, ctx({ dedupTweetIds: new Set(["t1"]) }));
    expect(b[0].rule).toBe("dedupe");
  });

  it("blocks everything during quiet hours", () => {
    const b = applyGuardrails(
      kept,
      ctx({ budgets: { ...DEFAULT_BUDGETS, quiet_hours: { start: "11:00", end: "13:00" } } }),
    );
    expect(b[0].rule).toBe("quiet_hours");
  });

  it("blocks everything when the daily post budget is exhausted", () => {
    const b = applyGuardrails(kept, ctx({ usage: { posts: 10, replies: 0 } }));
    expect(b[0].rule).toBe("budget");
    expect(b[0].reason).toContain("post");
  });

  it("blocks everything when the daily reply budget is exhausted", () => {
    const b = applyGuardrails(kept, ctx({ usage: { posts: 0, replies: 20 } }));
    expect(b[0].rule).toBe("budget");
    expect(b[0].reason).toContain("reply");
  });
});