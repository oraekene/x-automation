import { Hono } from "hono";

export type Env = {
  DB: D1Database;
};

const app = new Hono<{ Bindings: Env }>();

app.get("/health", async (c) => {
  try {
    await c.env.DB.prepare("SELECT 1").first();
    return c.json({ status: "ok", d1: true });
  } catch (err) {
    console.error("health check failed", err);
    return c.json({ status: "degraded", d1: false }, 503);
  }
});

app.get("/", (c) => c.json({ name: "x-automation-worker", health: "/health" }));

export default app;
