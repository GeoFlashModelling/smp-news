import type { ModelReply } from "./ollama.js";
import { SUMMARY_JSON_SCHEMA } from "./schema.js";

const API = "https://generativelanguage.googleapis.com/v1beta/models";
const TIMEOUT_MS = 2 * 60 * 1000;
/** Free-tier per-minute limits (429) and "high demand" (503): wait and retry rather than fail the story. */
const RATE_LIMIT_RETRIES = 3;
const RATE_LIMIT_WAIT_MS = 30_000;

/** The model's allowance for today is used up; waiting won't help, so callers move to another model. */
export class GeminiDailyQuotaError extends Error {}

export interface ModelUsage {
  free: number;
  paid: number;
  /** The free daily allowance ran out during this edition. */
  freeUsedUp?: boolean;
  /** Billed tokens on the paid key: input, then output including thinking. */
  paidTokens?: [number, number];
}

/** Requests sent this edition, per model and key (Google counts every request against the free daily allowance). */
export const geminiUsage: Record<string, ModelUsage> = {};

export interface GeminiOptions {
  /** Environment variable holding the key: the free GEMINI_API_KEY unless a caller asks for the paid one. */
  keyEnv?: string;
  /** How often to wait and retry when the model is busy or rate-limited. */
  retries?: number;
  /** Upper bound on billed output (answer plus thinking), so the worst-case cost of a call is known. */
  maxOutputTokens?: number;
  /** Give up after this long; callers with another model to try use less than the 2-minute default. */
  timeoutMs?: number;
  /** How much the model thinks before answering; "low" unless a retry needs less. */
  thinking?: "minimal" | "low";
}

/**
 * One structured-output call to Google Gemini. The key comes from an environment variable (a GitHub Actions secret in
 * production) and is sent as a header, never in the URL, so it can't leak into logs.
 */
export async function geminiJson(model: string, system: string, user: string, schema: object = SUMMARY_JSON_SCHEMA, options: GeminiOptions = {}): Promise<ModelReply> {
  const keyEnv = options.keyEnv ?? "GEMINI_API_KEY";
  const key = process.env[keyEnv];
  if (!key) throw new Error(`${keyEnv} is not set`);
  const started = Date.now();
  const tally = (geminiUsage[model] ??= { free: 0, paid: 0 });
  const paid = keyEnv !== "GEMINI_API_KEY";
  const request = () => {
    if (paid) tally.paid++;
    else tally.free++;
    return fetch(`${API}/${encodeURIComponent(model)}:generateContent`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-goog-api-key": key },
      signal: AbortSignal.timeout(options.timeoutMs ?? TIMEOUT_MS),
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: system }] },
        contents: [{ role: "user", parts: [{ text: user }] }],
        generationConfig: {
          temperature: 0,
          responseMimeType: "application/json",
          responseJsonSchema: schema,
          thinkingConfig: { thinkingLevel: options.thinking ?? "low" },
          ...(options.maxOutputTokens ? { maxOutputTokens: options.maxOutputTokens } : {}),
        },
      }),
    });
  };
  const busy = (status: number) => status === 429 || status === 503;
  let res = await request();
  // A used-up daily quota won't come back by waiting.
  if (res.status === 429 && /PerDay/i.test(await res.clone().text())) {
    if (!paid) tally.freeUsedUp = true;
    throw new GeminiDailyQuotaError(`Gemini daily quota for ${model} used up (429)`);
  }
  for (let retry = 0; busy(res.status) && retry < (options.retries ?? RATE_LIMIT_RETRIES); retry++) {
    await new Promise((r) => setTimeout(r, RATE_LIMIT_WAIT_MS));
    res = await request();
  }
  if (busy(res.status)) throw new Error(`Gemini busy or rate-limited (${res.status})`);
  if (!res.ok) throw new Error(`Gemini ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const body = (await res.json()) as {
    candidates?: { content?: { parts?: { text?: string }[] }; finishReason?: string }[];
    promptFeedback?: { blockReason?: string };
    usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number; thoughtsTokenCount?: number };
  };
  const raw = body.candidates?.[0]?.content?.parts?.map((p) => p.text ?? "").join("") ?? "";
  let json: unknown = null;
  try {
    json = JSON.parse(raw);
  } catch {
    json = null;
  }
  const usage = body.usageMetadata;
  // Thinking is billed as output.
  const promptTokens = usage?.promptTokenCount ?? 0;
  const outputTokens = (usage?.candidatesTokenCount ?? 0) + (usage?.thoughtsTokenCount ?? 0);
  if (paid) {
    const [input, output] = tally.paidTokens ?? [0, 0];
    tally.paidTokens = [input + promptTokens, output + outputTokens];
  }
  const finish = body.promptFeedback?.blockReason ?? body.candidates?.[0]?.finishReason;
  return { json, raw, ms: Date.now() - started, promptTokens, outputTokens, ...(finish ? { finish } : {}) };
}
