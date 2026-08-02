import { describe, expect, it } from "vitest";
import { Miniflare } from "miniflare";
import { createAndPair, makeWorker } from "./harness";

function authHeaders(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}`, "content-type": "application/json" };
}

async function enqueue(
  mf: Miniflare,
  relayId: string,
  type: string,
  payload: unknown,
): Promise<string> {
  const res = await mf.dispatchFetch(`http://localhost/api/relays/${relayId}/commands`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ type, payload }),
  });
  expect(res.status).toBe(201);
  const { command_id } = (await res.json()) as { command_id: string };
  return command_id;
}

async function poll(mf: Miniflare, relayId: string, token: string): Promise<{ id: string; type: string; payload: unknown }[]> {
  const res = await mf.dispatchFetch(`http://localhost/api/relays/${relayId}/commands`, {
    headers: authHeaders(token),
  });
  expect(res.status).toBe(200);
  const body = (await res.json()) as { commands: { id: string; type: string; payload: unknown }[] };
  return body.commands;
}

describe("relay pairing", () => {
  it("creates a pending relay with a pairing code", async () => {
    const mf = await makeWorker();
    try {
      const res = await mf.dispatchFetch("http://localhost/api/relays", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "laptop" }),
      });
      expect(res.status).toBe(201);
      const body = (await res.json()) as { relay_id: string; pairing_code: string };
      expect(body.relay_id).toMatch(/^[0-9a-f-]{36}$/);
      expect(body.pairing_code).toHaveLength(6);

      const dash = (await mf.dispatchFetch("http://localhost/api/relays/dashboard").then((r) => r.json())) as {
        relays: { status: string; online: boolean; queued: number }[];
      };
      expect(dash.relays).toHaveLength(1);
      expect(dash.relays[0].status).toBe("pending");
      expect(dash.relays[0].online).toBe(false);
    } finally {
      await mf.dispose();
    }
  });

  it("exchanges the pairing code for a token", async () => {
    const mf = await makeWorker();
    try {
      const { relay_id, token } = await createAndPair(mf);
      expect(token).toBeTruthy();

      const dash = (await mf.dispatchFetch("http://localhost/api/relays/dashboard").then((r) => r.json())) as {
        relays: { id: string; status: string; queued: number }[];
      };
      const relay = dash.relays.find((r) => r.id === relay_id);
      expect(relay?.status).toBe("active");
      expect(relay?.queued).toBe(0);
    } finally {
      await mf.dispose();
    }
  });

  it("rejects an invalid pairing code", async () => {
    const mf = await makeWorker();
    try {
      const created = await mf.dispatchFetch("http://localhost/api/relays", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "x" }),
      });
      const { relay_id } = (await created.json()) as { relay_id: string };
      const res = await mf.dispatchFetch("http://localhost/api/relays/pair", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ relay_id, pairing_code: "WRONG" }),
      });
      expect(res.status).toBe(401);
    } finally {
      await mf.dispose();
    }
  });

  it("rejects an expired pairing code", async () => {
    const mf = await makeWorker();
    try {
      const created = await mf.dispatchFetch("http://localhost/api/relays", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "x" }),
      });
      const { relay_id, pairing_code } = (await created.json()) as { relay_id: string; pairing_code: string };
      const db = await mf.getD1Database("DB");
      await db.prepare("UPDATE relays SET created_at = ?").bind(Math.floor(Date.now() / 1000) - 86401).run();
      const res = await mf.dispatchFetch("http://localhost/api/relays/pair", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ relay_id, pairing_code }),
      });
      expect(res.status).toBe(401);
    } finally {
      await mf.dispose();
    }
  });

  it("rejects polling without a valid token", async () => {
    const mf = await makeWorker();
    try {
      const { relay_id } = await createAndPair(mf);
      const res = await mf.dispatchFetch(`http://localhost/api/relays/${relay_id}/commands`, {
        headers: { authorization: "Bearer nope" },
      });
      expect(res.status).toBe(401);
    } finally {
      await mf.dispose();
    }
  });
});

describe("command channel", () => {
  it("delivers enqueued commands to the relay and clears the queue", async () => {
    const mf = await makeWorker();
    try {
      const { relay_id, token } = await createAndPair(mf);
      const commandId = await enqueue(mf, relay_id, "echo", { message: "hello" });

      const got = await poll(mf, relay_id, token);
      expect(got).toHaveLength(1);
      expect(got[0].id).toBe(commandId);
      expect(got[0].type).toBe("echo");
      expect(got[0].payload).toEqual({ message: "hello" });

      // A second poll must be empty: the command was claimed.
      const second = await poll(mf, relay_id, token);
      expect(second).toHaveLength(0);
    } finally {
      await mf.dispose();
    }
  });

  it("records a successful result and reflects it on the dashboard", async () => {
    const mf = await makeWorker();
    try {
      const { relay_id, token } = await createAndPair(mf);
      const commandId = await enqueue(mf, relay_id, "echo", { message: "hi" });
      await poll(mf, relay_id, token);

      const res = await mf.dispatchFetch(`http://localhost/api/relays/${relay_id}/results`, {
        method: "POST",
        headers: authHeaders(token),
        body: JSON.stringify({ results: [{ command_id: commandId, ok: true, output: { echoed: "hi" } }] }),
      });
      expect(res.status).toBe(200);
      const { updated } = (await res.json()) as { updated: number };
      expect(updated).toBe(1);

      const dash = (await mf.dispatchFetch("http://localhost/api/relays/dashboard").then((r) => r.json())) as {
        relays: { queued: number; done: number; failed: number; online: boolean }[];
      };
      expect(dash.relays[0].queued).toBe(0);
      expect(dash.relays[0].done).toBe(1);
      expect(dash.relays[0].failed).toBe(0);
      expect(dash.relays[0].online).toBe(true);
    } finally {
      await mf.dispose();
    }
  });

  it("catches up the backlog queued while the relay was offline", async () => {
    const mf = await makeWorker();
    try {
      const { relay_id, token } = await createAndPair(mf);
      const ids: string[] = [];
      for (let i = 0; i < 3; i++) {
        ids.push(await enqueue(mf, relay_id, "echo", { n: i }));
      }
      // Backlog is visible on the dashboard before the relay ever logs in.
      const before = (await mf.dispatchFetch("http://localhost/api/relays/dashboard").then((r) => r.json())) as {
        relays: { queued: number }[];
      };
      expect(before.relays[0].queued).toBe(3);
      // Relay comes online: all three queued commands are delivered in order and
      // still counted as backlog while claimed-but-unreported.
      const got = await poll(mf, relay_id, token);
      expect(got.map((c) => c.id)).toEqual(ids);
      const after = (await mf.dispatchFetch("http://localhost/api/relays/dashboard").then((r) => r.json())) as {
        relays: { queued: number; done: number }[];
      };
      expect(after.relays[0].queued).toBe(3);
      expect(after.relays[0].done).toBe(0);
    } finally {
      await mf.dispose();
    }
  });

  it("re-delivers claimed-but-unreported commands after the lease expires", async () => {
    const mf = await makeWorker();
    try {
      const { relay_id, token } = await createAndPair(mf);
      await enqueue(mf, relay_id, "echo", {});
      await poll(mf, relay_id, token);

      // Simulate a crashed relay: backdate the claim past the lease window.
      const db = await mf.getD1Database("DB");
      await db.prepare("UPDATE commands SET claimed_at = ?").bind(Math.floor(Date.now() / 1000) - 601).run();

      const got = await poll(mf, relay_id, token);
      expect(got).toHaveLength(1);
    } finally {
      await mf.dispose();
    }
  });
});