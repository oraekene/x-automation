import { Hono } from "hono";
import type { Env } from "./types";
import { relayRoutes } from "./routes/relays";
import { scheduleRoutes } from "./routes/schedules";
import { automationRoutes } from "./routes/automations";
import { candidateRoutes } from "./routes/candidates";
import { funnelRoutes } from "./routes/funnel";
import { providerRoutes } from "./routes/provider";
import { draftRoutes } from "./routes/drafts";
import { conversationRoutes } from "./routes/conversations";
import { tokenRoutes } from "./routes/tokens";
import { externalRoutes } from "./routes/external";
import { PAGE } from "./dashboard";
import { getUser } from "./auth";
import { runScheduled } from "./scheduled";

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
app.route("/api/schedules", scheduleRoutes);
app.route("/api/automations", automationRoutes);
app.route("/api/candidates", candidateRoutes);
app.route("/api/funnel", funnelRoutes);
app.route("/api/provider", providerRoutes);
app.route("/api/drafts", draftRoutes);
app.route("/api/conversations", conversationRoutes);
app.route("/api/tokens", tokenRoutes);
app.route("/api", externalRoutes);

app.get("/", async (c) => {
  const user = await getUser(c);
  if (!user) return c.json({ error: "unauthorized" }, 401);
  return c.html(PAGE);
});

export default {
  fetch: app.fetch,
  scheduled: runScheduled,
} satisfies ExportedHandler<Env>;