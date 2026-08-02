import { Hono } from "hono";
import type { Env } from "./types";
import { relayRoutes } from "./routes/relays";
import { PAGE } from "./dashboard";

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

app.route("/api/relays", relayRoutes);

app.get("/", (c) => c.html(PAGE));

export default app;