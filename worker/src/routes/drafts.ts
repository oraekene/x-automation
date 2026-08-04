// Ticket 10: the drafts list (the targeting verdicts). Execution, approval and
// rejection of drafts land with the inbox (ticket 11); this route only reads
// so the dashboard can show what the AI judged actionable.

import { Hono } from "hono";
import type { Env } from "../types";
import { getUser } from "../auth";

export const draftRoutes = new Hono<{ Bindings: Env }>();

draftRoutes.get("/", async (c) => {
  const user = await getUser(c);
  if (!user) return c.json({ error: "unauthorized" }, 401);
  const rows = (await c.env.DB.prepare(
    `SELECT d.id, d.automation_id, d.candidate_id, d.action, d.reason, d.priority, d.provider, d.model, d.created_at,
            c.author, c.text, c.tweet_id, a.name AS automation_name
     FROM drafts d
     JOIN candidates c ON c.id = d.candidate_id
     JOIN automations a ON a.id = d.automation_id
     WHERE d.user_id = ?
     ORDER BY d.created_at DESC, d.id DESC
     LIMIT 200`,
  )
    .bind(user.id)
    .all()) as unknown as {
    results: Array<{
      id: number;
      automation_id: string;
      candidate_id: string;
      action: string;
      reason: string;
      priority: number;
      provider: string;
      model: string;
      created_at: number;
      author: string;
      text: string;
      tweet_id: string;
      automation_name: string;
    }>;
  };

  return c.json({
    drafts: rows.results.map((d) => ({
      id: d.id,
      automation_id: d.automation_id,
      automation_name: d.automation_name,
      candidate_id: d.candidate_id,
      tweet_id: d.tweet_id,
      author: d.author,
      text: d.text,
      action: d.action,
      reason: d.reason,
      priority: d.priority,
      provider: d.provider,
      model: d.model,
      created_at: d.created_at,
    })),
  });
});