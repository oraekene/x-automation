import { build } from "esbuild";
import { Miniflare } from "miniflare";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

type WranglerConfig = {
  compatibility_date: string;
  compatibility_flags: string[];
};

const configSchema: Record<keyof WranglerConfig, string> = {
  compatibility_date: "string",
  compatibility_flags: "string[]",
};

function wranglerConfig(): WranglerConfig {
  const raw = readFileSync(new URL("../wrangler.jsonc", import.meta.url), "utf-8");
  const stripped = raw
    .split("\n")
    .filter((line) => !line.trim().startsWith("//"))
    .join("\n");
  const parsed = JSON.parse(stripped) as Record<keyof WranglerConfig, unknown>;
  for (const [key, expected] of Object.entries(configSchema)) {
    const value = parsed[key as keyof WranglerConfig];
    const ok = expected === "string" ? typeof value === "string" : Array.isArray(value);
    if (!ok) throw new Error(`wrangler.jsonc is missing ${expected} field "${key}"`);
  }
  return parsed as WranglerConfig;
}

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
  const cfg = wranglerConfig();
  const mf = new Miniflare({
    modules: true,
    script: code,
    compatibilityDate: cfg.compatibility_date,
    compatibilityFlags: cfg.compatibility_flags,
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
