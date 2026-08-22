const PAIRING_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

export function pairingCode(length = 6): string {
  const buf = new Uint8Array(length);
  crypto.getRandomValues(buf);
  return [...buf].map((b) => PAIRING_ALPHABET[b % PAIRING_ALPHABET.length]).join("");
}

export async function hashToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}