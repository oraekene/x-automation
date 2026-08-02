// Guard used by every user-facing route that addresses a specific relay: the
// relay must exist AND belong to the caller, else 404 (never reveal existence).
export async function relayOwnedBy(
  db: D1Database,
  relayId: string,
  userId: string,
): Promise<boolean> {
  const row = await db.prepare("SELECT id FROM relays WHERE id = ? AND user_id = ?")
    .bind(relayId, userId)
    .first();
  return row !== null;
}