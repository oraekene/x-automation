// Ticket 10: per-user AI provider configuration. GET/PUT the active config and
// GET the free-endpoint presets that prefill the dashboard form. The API key is
// stored as-is (D1 is encrypted at rest by Cloudflare) and never returned in
// full — reads echo back only the last 4 characters, which is enough to know a
// key is configured.

import { Hono } from "hono";
import type { Env, ProviderRow } from "../types";
import { getUser } from "../auth";
import { maskApiKey, PROVIDER_PRESETS } from "../lib/ai";
import { nowSeconds } from "../lib/crypto";

export const providerRoutes = new Hono<{ Bindings: Env }>();

providerRoutes.get("/presets", async (c) => {
  const user = await getUser(c);
  if (!user) return c.json({ error: "unauthorized" }, 401);
  return c.json({ presets: PROVIDER_PRESETS });
});

providerRoutes.get("/", async (c) => {
  const user = await getUser(c);
  if (!user) return c.json({ error: "unauthorized" }, 401);
  const row = (await c.env.DB.prepare("SELECT * FROM provider_configs WHERE user_id = ?")
    .bind(user.id)
    .first()) as ProviderRow | undefined;
  if (!row) return c.json({ provider: null });
  return c.json({
    provider: {
      base_url: row.base_url,
      model: row.model,
      key_configured: true,
      key_masked: maskApiKey(row.api_key),
      updated_at: row.updated_at,
    },
  });
});

providerRoutes.put("/", async (c) => {
  const user = await getUser(c);
  if (!user) return c.json({ error: "unauthorized" }, 401);
  const body = (await c.req.json().catch(() => ({}))) as { base_url?: string; api_key?: string; model?: string };
  const base_url = body.base_url?.trim();
  const model = body.model?.trim();
  if (!base_url || !model) return c.json({ error: "base_url and model are required" }, 400);
  if (!/^https?:\/\//.test(base_url)) return c.json({ error: "base_url must be an http(s) URL" }, 400);

  const existing = (await c.env.DB.prepare("SELECT * FROM provider_configs WHERE user_id = ?")
    .bind(user.id)
    .first()) as ProviderRow | undefined;
  const api_key = body.api_key?.trim() || existing?.api_key;
  if (!api_key) return c.json({ error: "api_key is required" }, 400);

  const updatedAt = nowSeconds();
  await c.env.DB.prepare(
    `INSERT INTO provider_configs (user_id, base_url, api_key, model, updated_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (user_id) DO UPDATE SET base_url = excluded.base_url, api_key = excluded.api_key, model = excluded.model, updated_at = excluded.updated_at`,
  )
    .bind(user.id, base_url, api_key, model, updatedAt)
    .run();

  return c.json({
    provider: { base_url, model, key_configured: true, key_masked: maskApiKey(api_key), updated_at: updatedAt },
  });
});