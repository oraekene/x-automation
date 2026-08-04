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

export type DueScheduleRow = {
  id: string;
  relay_id: string;
  type: string;
  payload: string;
  interval_minutes: number;
  timezone: string;
  next_run_at: number;
};

export type RelayRow = {
  id: string;
  user_id: string;
  name: string;
  status: string;
  pairing_code_hash: string;
  token_hash: string | null;
  last_seen_at: number | null;
  enabled: number;
  created_at: number;
};

export type AutomationRow = {
  id: string;
  user_id: string;
  relay_id: string;
  name: string;
  status: string;
  search_criteria: string;
  targeting: string;
  rules: string;
  budgets: string;
  mode: "manual" | "auto" | "hybrid";
  auto_threshold: number;
  interval_minutes: number;
  timezone: string;
  next_run_at: number;
  last_run_at: number | null;
  created_at: number;
};

export type DueAutomationRow = {
  id: string;
  relay_id: string;
  search_criteria: string;
  targeting: string;
  interval_minutes: number;
  timezone: string;
  next_run_at: number;
};

export type CandidateRow = {
  id: string;
  user_id: string;
  automation_id: string;
  relay_id: string;
  tweet_id: string;
  author: string;
  text: string;
  created_at: string;
  favorite_count: number;
  retweet_count: number;
  reply_count: number;
  lang: string;
  source: "search" | "profile";
  found_at: number;
};

export type DecisionRow = {
  id: string;
  user_id: string;
  relay_id: string;
  automation_id: string;
  candidate_id: string;
  stage: "filter" | "guardrail" | "ai";
  decision: "keep" | "reject" | "block" | "draft" | "skip" | "fail";
  rule: string;
  reason: string;
  score: number;
  acted_at: number;
};

export type ProviderRow = {
  user_id: string;
  base_url: string;
  api_key: string;
  model: string;
  updated_at: number;
};

export type DraftStatus = "ready" | "content_failed" | "executing" | "done" | "rejected" | "failed";

export type DraftRow = {
  id: number;
  user_id: string;
  relay_id: string;
  automation_id: string;
  candidate_id: string;
  action: "reply" | "quote";
  reason: string;
  priority: number;
  provider: string;
  model: string;
  status: DraftStatus;
  text: string;
  command_id: string | null;
  result_tweet_id: string | null;
  executed_at: number | null;
  decided_at: number | null;
  created_at: number;
};

export type SearchCriteria = {
  keywords: string[];
  hashtags?: string[];
  mentions?: string[];
  min_faves?: number;
  min_retweets?: number;
  min_replies?: number;
  lang?: string;
  since?: string;
  until?: string;
};

export type TargetingProfile = {
  profile?: {
    keywords?: string[];
    min_followers?: number;
    verified?: boolean;
    location?: string;
  };
  persona?: string;
  goals?: string;
  style?: string;
  exclusions?: string;
};