import { SUMMARY_JSON_SCHEMA } from "./schema.js";

export interface ModelReply {
  json: unknown;
  raw: string;
  ms: number;
  promptTokens: number;
  outputTokens: number;
  /** Why the model stopped, when it says ("STOP", "MAX_TOKENS", "SAFETY"…). */
  finish?: string;
}

const OLLAMA_URL = process.env.OLLAMA_URL ?? "http://127.0.0.1:11434";
const TIMEOUT_MS = 10 * 60 * 1000;

/**
 * One structured-output call to a local Ollama server. Temperature 0 and a fixed seed keep reruns comparable.
 * OLLAMA_CPU=1 forces CPU-only inference, to estimate speed on a GitHub runner.
 */
export async function chatJson(model: string, system: string, user: string): Promise<ModelReply> {
  const started = Date.now();
  const res = await fetch(`${OLLAMA_URL}/api/chat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    signal: AbortSignal.timeout(TIMEOUT_MS),
    body: JSON.stringify({
      model,
      stream: false,
      think: false,
      format: SUMMARY_JSON_SCHEMA,
      options: { temperature: 0, seed: 1, num_ctx: 8192, ...(process.env.OLLAMA_CPU === "1" ? { num_gpu: 0 } : {}) },
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
    }),
  });
  if (!res.ok) throw new Error(`Ollama ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const body = (await res.json()) as { message?: { content?: string }; prompt_eval_count?: number; eval_count?: number };
  const raw = body.message?.content ?? "";
  let json: unknown = null;
  try {
    json = JSON.parse(raw);
  } catch {
    json = null;
  }
  return { json, raw, ms: Date.now() - started, promptTokens: body.prompt_eval_count ?? 0, outputTokens: body.eval_count ?? 0 };
}
