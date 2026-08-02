import { build } from "esbuild";
import { Miniflare } from "miniflare";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

type WranglerConfig = {
  compatibility_date: string;
  compatibility_flags: string[];
};

const configSchema: Record<keyof WranglerConfig, string> = {
  compatibility_date: "string",
  compatibility_flags: "string[]",
};

export function wranglerConfig(): WranglerConfig {
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

const migrationsDir = fileURLToPath(new URL("../migrations", import.meta.url));

export function migrations(): { sql: string; statements: string[] }[] {
  const files = readdirSync(migrationsDir)
    .filter((f) => f.endsWith(".sql"))
    .sort();
  if (files.length === 0) throw new Error("no migrations found");
  return files.map((f) => {
    const sql = readFileSync(`${migrationsDir}/${f}`, "utf-8")
      .split("\n")
      .filter((line) => !line.trim().startsWith("--"))
      .join("\n");
    const statements = sql
      .split(";")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    return { sql: statements.join(";\n"), statements };
  });
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

// Build the worker, apply the real migrations, and return a live Miniflare.
export async function makeWorker(): Promise<Miniflare> {
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
  for (const migration of migrations()) {
    for (const statement of migration.statements) {
      await db.prepare(statement).run();
    }
  }
  return mf;
}

// Pair a relay and return { relay_id, token }.
export async function createAndPair(
  mf: Miniflare,
  name = "laptop",
): Promise<{ relay_id: string; token: string }> {
  const created = await mf.dispatchFetch("http://localhost/api/relays", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name }),
  });
  if (created.status !== 201) throw new Error(`create relay failed: ${await created.text()}`);
  const { relay_id, pairing_code } = (await created.json()) as { relay_id: string; pairing_code: string };
  const paired = await mf.dispatchFetch("http://localhost/api/relays/pair", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ relay_id, pairing_code }),
  });
  if (paired.status !== 200) throw new Error(`pair failed: ${await paired.text()}`);
  const { token } = (await paired.json()) as { token: string };
  return { relay_id, token };
}