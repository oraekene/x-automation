import { createRemoteJWKSet, jwtVerify } from "jose";
import type { Context } from "hono";
import type { Env } from "./types";

export type User = {
  id: string;
  email: string;
};

const ACCESS_CERTS = (team: string) => `https://${team}.cloudflareaccess.com/cdn-cgi/access/certs`;

// Identity seam (ADR-0006). The default provider is Cloudflare Access: it
// asserts `Cf-Access-Jwt-Assertion` against the team's published JWKS. Swap in
// a magic-link provider by returning a User backed by D1 lookups instead.
export async function getUser(c: Context<{ Bindings: Env }>): Promise<User | null> {
  const header = c.req.header("Cf-Access-Jwt-Assertion");
  if (!header) return null;
  const { ACCESS_TEAM, ACCESS_AUD } = c.env;
  if (ACCESS_TEAM && ACCESS_AUD) {
    return await verifyAccessIdentity(ACCESS_TEAM, ACCESS_AUD, header);
  }
  // Dev/test-only path, never reached when a team+audience are configured.
  if (c.env.AUTH_DEV === "1") return decodeUnverified(header);
  // Fail closed: a misconfigured deployment must reject, not trust.
  return null;
}

async function verifyAccessIdentity(team: string, aud: string, token: string): Promise<User | null> {
  try {
    const { payload } = await jwtVerify(token, createRemoteJWKSet(new URL(ACCESS_CERTS(team))), {
      issuer: `https://${team}.cloudflareaccess.com`,
      audience: aud,
    });
    return userFromPayload(payload.email);
  } catch {
    return null;
  }
}

function decodeUnverified(token: string): User | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  try {
    const b64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    return userFromPayload(JSON.parse(atob(b64)).email);
  } catch {
    return null;
  }
}

function userFromPayload(email: unknown): User | null {
  if (typeof email !== "string") return null;
  return { id: email, email };
}