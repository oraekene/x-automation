// Ticket 10: OpenAI-compatible targeting client. Provider-agnostic — any
// endpoint that speaks /chat/completions with a Bearer key (see
// PROVIDER_PRESETS). Tolerant of model output: verdicts may arrive wrapped in
// code fences or embedded in prose, and a 200 body may still be garbage, so
// every outcome is an explicit result the caller can audit.

export type TargetingVerdict = {
  action: "reply" | "quote" | "skip";
  reason: string;
  priority: number;
};

export type AiTargetingOutcome =
  | { ok: true; verdict: TargetingVerdict }
  | { ok: false; error: string };

export type AiCandidateContext = {
  author: string;
  text: string;
  score: number;
  automationName: string;
  profile: string; // the automation's targeting profile (JSON), the LLM's fixed reference
};

export type ProviderPreset = { name: string; base_url: string };

// The free-endpoint menu offered in the dashboard provider form (spec:
// "prefilled menu of free endpoints"). base_urls follow each provider's
// documented OpenAI-compatible base.
export const PROVIDER_PRESETS: readonly ProviderPreset[] = [
  { name: "NVIDIA NIM", base_url: "https://integrate.api.nvidia.com/v1" },
  { name: "OpenCode Zen", base_url: "https://opencode.ai/zen/v1" },
  { name: "Groq", base_url: "https://api.groq.com/openai/v1" },
  { name: "Gemini", base_url: "https://generativelanguage.googleapis.com/v1beta/openai" },
  { name: "OpenRouter", base_url: "https://openrouter.ai/api/v1" },
  { name: "Cerebras", base_url: "https://api.cerebras.ai/v1" },
  { name: "Mistral", base_url: "https://api.mistral.ai/v1" },
  { name: "GitHub Models", base_url: "https://models.github.ai/inference" },
  { name: "Cloudflare Workers AI", base_url: "https://api.cloudflare.com/client/v4/accounts/{ACCOUNT_ID}/ai/v1" },
];

const SYSTEM_PROMPT = [
  "You are the targeting stage of a social automation funnel.",
  "A user message gives you a targeting profile (the audience and intent the user wants to reach) followed by one candidate post.",
  "You judge whether to reply to it, quote it, or skip it, against that targeting profile.",
  "Respond with ONLY a JSON object of the form:",
  '{"action": "reply" | "quote" | "skip", "reason": "<one sentence>", "priority": <1-5>}',
  "priority 1 = low value, 5 = must act. Reply = directly engage the author; quote = amplify with commentary.",
].join("\n");

// Model outputs are prose-y: strip ```json fences if present, then take the
// first '{' to the last '}' and parse just that slice.
function extractJsonObject(content: string): unknown | undefined {
  let text = content.trim();
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  if (fence) text = fence[1]!.trim();
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return undefined;
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return undefined;
  }
}

function parseVerdict(content: string): AiTargetingOutcome {
  const raw = extractJsonObject(content);
  if (raw === undefined) return { ok: false, error: "parse" };
  const v = raw as Partial<TargetingVerdict>;
  const action = v.action;
  if (action !== "reply" && action !== "quote" && action !== "skip") return { ok: false, error: "invalid" };
  if (typeof v.reason !== "string" || v.reason.trim() === "") return { ok: false, error: "invalid" };
  if (typeof v.priority !== "number" || !Number.isFinite(v.priority)) return { ok: false, error: "invalid" };
  return { ok: true, verdict: { action, reason: v.reason, priority: Math.min(5, Math.max(1, Math.round(v.priority))) } };
}

// POST {base}/chat/completions with the candidate context and return the
// verdict. Non-2xx maps to http_<status>; 2xx garbage maps to parse/invalid.
// network covers fetch-level failures (DNS, refused, timeout). A 30s timeout
// bounds a hung provider; the caller retries failures on the next run.
const REQUEST_TIMEOUT_MS = 30_000;

export async function aiTargetingVerdict(opts: {
  baseUrl: string;
  apiKey: string;
  model: string;
  candidate: AiCandidateContext;
}): Promise<AiTargetingOutcome> {
  const { baseUrl, apiKey, model, candidate } = opts;
  const userPrompt = [
    "Targeting profile:",
    candidate.profile || "{}",
    "Candidate post:",
    `author: ${candidate.author}`,
    `text: ${candidate.text}`,
    `score: ${candidate.score}`,
    `automation: ${candidate.automationName}`,
  ].join("\n");

  let res: Response;
  try {
    res = await fetch(`${baseUrl.replace(/\/+$/, "")}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: userPrompt },
        ],
      }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch {
    return { ok: false, error: "network" };
  }

  if (!res.ok) return { ok: false, error: `http_${res.status}` };

  let data: unknown;
  try {
    data = await res.json();
  } catch {
    return { ok: false, error: "parse" };
  }
  const content = (data as { choices?: Array<{ message?: { content?: string } }> })?.choices?.[0]?.message?.content;
  if (typeof content !== "string" || content.trim() === "") return { ok: false, error: "parse" };
  return parseVerdict(content);
}

// Keys are stored per user but never echoed back in full; the dashboard form
// shows only the last 4 characters.
export function maskApiKey(key: string): string {
  if (key.length <= 4) return "••••••••";
  return "••••••••" + key.slice(-4);
}
