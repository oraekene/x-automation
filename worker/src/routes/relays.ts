import { Hono, type Context } from "hono";
import type { Env, RelayRow } from "../types";
import { hashToken, nowSeconds, pairingCode } from "../lib/crypto";
import { commandInsert } from "../lib/command";
import { resultCandidates } from "../lib/candidates";
import { safeParse } from "../lib/json";
import { relayOwnedBy } from "../lib/ownership";
import { getUser } from "../auth";

const CLAIM_LEASE_S = 600;
const PAIRING_TTL_S = 24 * 60 * 60;
const MAX_POLL_BATCH = 20;

export const relayRoutes = new Hono<{ Bindings: Env }>();

type AppContext = Context<{ Bindings: Env }>;

async function bearerRelay(c: AppContext): Promise<RelayRow | null> {
  const auth = c.req.header("Authorization");
  if (!auth?.startsWith("Bearer ")) return null;
  const hash = await hashToken(auth.slice("Bearer ".length));
  const row = (await c.env.DB.prepare(
    "SELECT * FROM relays WHERE status = 'active' AND token_hash = ?",
  )
    .bind(hash)
    .first()) as RelayRow | undefined;
  return row ?? null;
}

relayRoutes.post("/", async (c) => {
  const user = await getUser(c);
  if (!user) return c.json({ error: "unauthorized" }, 401);
  const body = (await c.req.json().catch(() => ({}))) as { name?: string };
  const id = crypto.randomUUID();
  const pairing = pairingCode();
  await c.env.DB.prepare(
    "INSERT INTO relays (id, user_id, name, status, pairing_code_hash, created_at) VALUES (?, ?, ?, 'pending', ?, ?)",
  )
    .bind(id, user.id, body.name ?? "relay", await hashToken(pairing), nowSeconds())
    .run();
  return c.json({ relay_id: id, pairing_code: pairing }, 201);
});

relayRoutes.post("/pair", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as {
    relay_id?: string;
    pairing_code?: string;
    client_name?: string;
  };
  if (!body.relay_id || !body.pairing_code) {
    return c.json({ error: "relay_id and pairing_code required" }, 400);
  }
  const token = crypto.randomUUID() + crypto.randomUUID();
  const hash = await hashToken(token);
  const result = await c.env.DB.prepare(
    `UPDATE relays SET status = 'active', token_hash = ?, name = COALESCE(?, name), last_seen_at = ?
     WHERE id = ? AND status = 'pending' AND pairing_code_hash = ? AND created_at >= ?`,
  )
    .bind(
      hash,
      body.client_name ?? null,
      nowSeconds(),
      body.relay_id,
      await hashToken(body.pairing_code),
      nowSeconds() - PAIRING_TTL_S,
    )
    .run();
  if (result.meta.changes === 0) return c.json({ error: "invalid or expired pairing code" }, 401);
  return c.json({ relay_id: body.relay_id, token });
});

relayRoutes.post("/:id/commands", async (c) => {
  const user = await getUser(c);
  if (!user) return c.json({ error: "unauthorized" }, 401);
  const id = c.req.param("id");
  if (!(await relayOwnedBy(c.env.DB, id, user.id))) return c.json({ error: "not found" }, 404);
  const body = (await c.req.json().catch(() => ({}))) as { type?: string; payload?: unknown };
  if (!body.type) return c.json({ error: "type required" }, 400);
  const commandId = crypto.randomUUID();
  await commandInsert(c.env.DB, commandId, id, body.type, JSON.stringify(body.payload ?? {}), nowSeconds()).run();
  return c.json({ command_id: commandId }, 201);
});

relayRoutes.get("/:id/commands", async (c) => {
  const relay = await bearerRelay(c);
  if (!relay) return c.json({ error: "unauthorized" }, 401);
  const now = nowSeconds();
  await c.env.DB.prepare("UPDATE relays SET last_seen_at = ? WHERE id = ?").bind(now, relay.id).run();
  const rows = await c.env.DB.prepare(
    `SELECT id, type, payload FROM commands
     WHERE relay_id = ?
       AND (status = 'pending' OR (status = 'in_flight' AND claimed_at < ?))
     ORDER BY created_at ASC
     LIMIT ?`,
  )
    .bind(relay.id, now - CLAIM_LEASE_S, MAX_POLL_BATCH)
    .all();
  for (const row of rows.results) {
    await c.env.DB.prepare(
      "UPDATE commands SET status = 'in_flight', attempts = attempts + 1, claimed_at = ? WHERE id = ?",
    )
      .bind(now, row.id)
      .run();
  }
  return c.json({
    commands: rows.results.map((r) => ({
      id: r.id as string,
      type: r.type as string,
      payload: safeParse(r.payload as string),
    })),
  });
});

relayRoutes.post("/:id/results", async (c) => {
  const relay = await bearerRelay(c);
  if (!relay) return c.json({ error: "unauthorized" }, 401);
  const body = (await c.req.json().catch(() => ({}))) as {
    results?: Array<{ command_id?: string; ok?: boolean; output?: unknown }>;
  };
  if (!Array.isArray(body.results)) return c.json({ error: "results array required" }, 400);
  const now = nowSeconds();
  const updates: D1PreparedStatement[] = [];
  const funnel: Array<{ command_id: string; output: unknown }> = [];
  for (const r of body.results) {
    if (!r.command_id) continue;
    updates.push(
      c.env.DB.prepare(
        "UPDATE commands SET status = ?, result = ?, completed_at = ? WHERE id = ? AND relay_id = ?",
      ).bind(r.ok ? "done" : "failed", JSON.stringify(r.output ?? {}), now, r.command_id, relay.id),
    );
    if (r.ok) funnel.push({ command_id: r.command_id, output: r.output });
  }
  const updated =
    updates.length > 0
      ? (await c.env.DB.batch(updates)).reduce((n, r) => n + (r.meta?.changes ?? 0), 0)
      : 0;

  // Funnel commands (Funnel Stage 1) land their reported tweets in the
  // candidate pool, deduped per user+tweet. Re-select only the successful
  // funnel commands in one bounded query and derive their inserts from the
  // shared lib/candidates shapes.
  const ingest: D1PreparedStatement[] = [];
  if (funnel.length > 0) {
    const rows = (await c.env.DB.prepare(
      `SELECT id, type, payload FROM commands
       WHERE relay_id = ? AND id IN (${funnel.map(() => "?").join(",")})`,
    )
      .bind(relay.id, ...funnel.map((f) => f.command_id))
      .all()) as unknown as { results: Array<{ id: string; type: string; payload: string }> };
    const byId = new Map(rows.results.map((row) => [row.id, row]));
    for (const f of funnel) {
      const row = byId.get(f.command_id);
      if (!row) continue;
      ingest.push(
        ...resultCandidates(c.env.DB, row, f.output, {
          userId: relay.user_id,
          relayId: relay.id,
          foundAt: now,
        }),
      );
    }
  }
  if (ingest.length > 0) await c.env.DB.batch(ingest);
  return c.json({ updated });
});

relayRoutes.get("/dashboard", async (c) => {
  const user = await getUser(c);
  if (!user) return c.json({ error: "unauthorized" }, 401);
  const relays = (await c.env.DB.prepare(
    `SELECT id, name, status, last_seen_at, created_at,
       (SELECT COUNT(*) FROM commands WHERE relay_id = relays.id AND status IN ('pending', 'in_flight')) AS queued,
       (SELECT COUNT(*) FROM commands WHERE relay_id = relays.id AND status = 'done') AS done,
       (SELECT COUNT(*) FROM commands WHERE relay_id = relays.id AND status = 'failed') AS failed
     FROM relays
     WHERE user_id = ?
     ORDER BY created_at DESC`,
  )
    .bind(user.id)
    .all()) as unknown as {
    results: Array<{
      id: string;
      name: string;
      status: string;
      last_seen_at: number | null;
      created_at: number;
      queued: number;
      done: number;
      failed: number;
    }>;
  };
  const onlineAfter = nowSeconds() - 30;
  return c.json({
    relays: relays.results.map((r) => ({
      id: r.id,
      name: r.name,
      status: r.status,
      online: r.status === "active" && r.last_seen_at !== null && r.last_seen_at > onlineAfter,
      queued: r.queued,
      done: r.done,
      failed: r.failed,
    })),
  });
});