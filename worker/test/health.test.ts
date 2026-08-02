import { build } from "esbuild";
import { Miniflare } from "miniflare";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

async function bundleWorker(): Promise<string> {
  const result = await build({
    entryPoints: [fileURLToPath(new URL("../src/index.ts", import.meta.url))],
    bundle: true,
    format: "esm",
    platform: "browser",
    target: "es2022",
    write: false,
    external: [],
    logLevel: "silent",
  });
  if (result.outputFiles.length !== 1) throw new Error("expected one output file");
  return result.outputFiles[0].text;
}

async function makeWorker(sql: string): Promise<Miniflare> {
  const code = await bundleWorker();
  const mf = new Miniflare({
    modules: true,
    script: code,
    compatibilityDate: "2025-07-18",
    compatibilityFlags: ["nodejs_compat"],
    d1Databases: ["DB"],
  });
  const db = await mf.getD1Database("DB");
  await db.exec(sql);
  return mf;
}

describe("worker health endpoint", () => {
  it("reports ok with D1 reachable", async () => {
    const mf = await makeWorker("CREATE TABLE app_meta (key TEXT PRIMARY KEY, value TEXT);");
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

  it("returns a root banner", async () => {
    const mf = await makeWorker("CREATE TABLE app_meta (key TEXT PRIMARY KEY, value TEXT);");
    try {
      const res = await mf.dispatchFetch("http://localhost/");
      expect(res.status).toBe(200);
      const body = (await res.json()) as { name: string };
      expect(body.name).toBe("x-automation-worker");
    } finally {
      await mf.dispose();
    }
  });
});