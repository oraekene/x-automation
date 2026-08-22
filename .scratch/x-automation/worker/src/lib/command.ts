// The command channel's single INSERT shape, shared by manual enqueue and the
// tick so both producers write commands identically. Returns a prepared
// statement so the tick can batch it alongside its schedule UPDATE.
export function commandInsert(
  db: D1Database,
  id: string,
  relayId: string,
  type: string,
  payload: string,
  createdAt: number,
): D1PreparedStatement {
  return db
    .prepare(
      "INSERT INTO commands (id, relay_id, type, payload, status, attempts, created_at) VALUES (?, ?, ?, ?, 'pending', 0, ?)",
    )
    .bind(id, relayId, type, payload, createdAt);
}