export type Env = {
  DB: D1Database;
  ACCESS_TEAM?: string;
  ACCESS_AUD?: string;
  AUTH_DEV?: string;
};

export type ScheduleRow = {
  id: string;
  user_id: string;
  relay_id: string;
  name: string;
  type: string;
  payload: string;
  status: string;
  interval_minutes: number;
  timezone: string;
  next_run_at: number;
  last_run_at: number | null;
  created_at: number;
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