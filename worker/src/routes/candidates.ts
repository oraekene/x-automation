import { Hono } from "hono";
import type { CandidateRow, Env } from "../types";
import { getUser } from "../auth";

export const candidateRoutes = new Hono<{ Bindings: Env }>();

candidateRoutes.get("/", async (c) => {
  const user = await getUser(c);
  if (!user) return c.json({ error: "unauthorized" }, 401);
  const rows = await c.env.DB.prepare(
    "SELECT * FROM candidates WHERE user_id = ? ORDER BY found_at DESC, tweet_id DESC LIMIT 200",
  )
    .bind(user.id)
    .all() as unknown as { results: CandidateRow[] };
  return c.json({
    candidates: rows.results.map((r) => ({
      id: r.id,
      automation_id: r.automation_id,
      relay_id: r.relay_id,
      tweet_id: r.tweet_id,
      author: r.author,
      text: r.text,
      created_at: r.created_at,
      favorite_count: r.favorite_count,
      retweet_count: r.retweet_count,
      reply_count: r.reply_count,
      lang: r.lang,
      source: r.source,
      found_at: r.found_at,
    })),
  });
});
