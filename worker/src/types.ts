export type Env = {
  DB: D1Database;
};

export type RelayRow = {
  id: string;
  user_id: string;
  name: string;
  status: string;
  pairing_code_hash: string;
  token_hash: string | null;
  last_seen_at: number | null;
  created_at: number;
};