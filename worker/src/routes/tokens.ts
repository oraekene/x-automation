// Ticket 14: per-user API token management. Tokens are stored hashed (SHA-256)
// with a visible prefix so the user can identify them. Creating a token returns
// the plaintext once; revoking sets revoked_at.

import { Hono } from "hono";
import type { Env, ApiTokenRow } from "../types";
import { hashToken, nowSeconds } from "../lib/crypto";
import { getUser } from "../auth";

export const tokenRoutes = new Hono<{ Bindings: Env }>();

tokenRoutes.post("/", async (c) => {
  const user = await getUser(c);
  if (!user) return c.json({ error: "unauthorized" }, 401);
  const body = (await c.req.json().catch(() => ({}))) as { name?: string };
  const name = body.name?.trim() || "api-token";
  const raw = crypto.randomUUID().replace(/-/g, "") + crypto.randomUUID().replace(/-/g, "");
  const hash = await hashToken(raw);
  const prefix = raw.slice(0, 8);
  const id = crypto.randomUUID();
  await c.env.DB.prepare(
    "INSERT INTO api_tokens (id, user_id, name, token_hash, prefix, created_at) VALUES (?, ?, ?, ?, ?, ?)",
  )
    .bind(id, user.id, name, hash, prefix, nowSeconds())
    .run();
  return c.json({ id, name, token: raw, prefix }, 201);
});

tokenRoutes.get("/", async (c) => {
  const user = await getUser(c);
  if (!user) return c.json({ error: "unauthorized" }, 401);
  const rows = (await c.env.DB.prepare(
    "SELECT id, name, prefix, created_at, revoked_at FROM api_tokens WHERE user_id = ? ORDER BY created_at DESC",
  )
    .bind(user.id)
    .all()) as unknown as { results: Omit<ApiTokenRow, "token_hash" | "user_id">[] };
  return c.json({
    tokens: rows.results.map((r) => ({
      id: r.id,
      name: r.name,
      prefix: r.prefix,
      created_at: r.created_at,
      revoked: r.revoked_at !== null,
    })),
  });
});

tokenRoutes.delete("/:id", async (c) => {
  const user = await getUser(c);
  if (!user) return c.json({ error: "unauthorized" }, 401);
  const result = await c.env.DB.prepare(
    "UPDATE api_tokens SET revoked_at = ? WHERE id = ? AND user_id = ? AND revoked_at IS NULL",
  )
    .bind(nowSeconds(), c.req.param("id"), user.id)
    .run();
  if (result.meta.changes === 0) return c.json({ error: "not found or already revoked" }, 404);
  return c.json({ ok: true });
});
