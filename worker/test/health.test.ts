import { describe, expect, it } from "vitest";
import { makeWorker, migrations } from "./harness";

describe("worker health endpoint", () => {
  it("reports ok with D1 reachable", async () => {
    const mf = await makeWorker();
    try {
      const res = await mf.dispatchFetch("http://localhost/health");
      expect(res.status).toBe(200);
      const body = (await res.json()) as { status: string; d1: boolean };
      expect(body.status).toBe("ok");
      expect(body.d1).toBe(true);
    } finally {
      await mf.dispose();
    }
  });

  it("loads the schema migrations", () => {
    const loaded = migrations();
    expect(loaded.length).toBeGreaterThanOrEqual(2);
    const sqls = loaded.map((m) => m.sql).join("\n");
    expect(sqls).toContain("CREATE TABLE IF NOT EXISTS relays");
    expect(sqls).toContain("CREATE TABLE IF NOT EXISTS commands");
  });
});