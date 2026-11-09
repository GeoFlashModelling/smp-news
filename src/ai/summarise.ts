import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { Story } from "../lib/stories.js";
import { geminiJson, GeminiDailyQuotaError } from "./gemini.js";
import { legalMode, type LegalMode } from "./legal-risk.js";
import type { ModelReply } from "./ollama.js";
import { selectSources, summarySentences, SYSTEM_PROMPT, userPrompt, type SourceBlock } from "./prompt.js";
import type { StorySummary } from "./schema.js";
import { validateSummary } from "./validate.js";

/** The outlet behind a citation label (S1, S2, ...), kept with the summary so the labels still resolve next hour. */
export interface CitedSource {
  name: string;
  url: string;
}

export interface StoryWriteup {
  /** null when every model's answer failed the checks; the story shows headlines only until its coverage changes. */
  summary: StorySummary | null;
  sources: Record<string, CitedSource>;
  /** Owner groups the model was given; a rewrite needs enough new ones. */
  owners: string[];
  model: string;
  paid: boolean;
  written: string;
  /** Failed attempts in a row; a failed story is tried again after a gap, up to MAX_FAILURES times. */
  failures?: number;
  /** Version of the court and crime rules a careful write-up passed; older ones are rewritten, never shown. */
  legalRules?: number;
  /** Written under the sensitive-story rules (legal mode "brief"). */
  brief?: boolean;
  /** Write-up format; 1 (or missing) is the old 2-to-4-sentence summary. */
  format?: number;
}

/** Bump when the court and crime rules tighten, so every careful write-up is rewritten under the new rules. */
const LEGAL_RULES = 2;
/** Summaries sized to the material, up to three paragraphs (8 Nov 2026). */
const FORMAT = 2;

/** A write-up that may still be shown: careful ones must have passed the current court and crime rules, sensitive ones the brief rules. */
function stillValid(w: StoryWriteup | undefined, mode: LegalMode): w is StoryWriteup {
  if (!w?.summary || META_HEADLINE.test(w.summary.headline)) return false;
  if (mode === "brief") return w.brief === true;
  return mode === "normal" || (w.legalRules ?? 0) >= LEGAL_RULES;
}
const META_HEADLINE = /\b(provided sources?|no (relevant )?(news )?event|not enough information)\b/i;

interface State {
  version: number;
  writeups: Record<string, StoryWriteup>;
  /** Paid spend so far on one Perth calendar day, in Australian dollars. */
  spend: { day: string; aud: number };
  /** Free models whose daily allowance ran out, and the Pacific-time day it ran out (Google resets at midnight there). */
  exhausted: Record<string, string>;
}

const STATE_VERSION = 1;
const KEEP_DAYS = 3;
const MIN_SOURCES = 2;
/** A single-outlet story needs a description of at least this length; a one-line teaser is too thin to write from. */
const SINGLE_MIN_CHARS = 120;
/** Rewrite when this many owner groups the summary didn't use have joined, at most once per gap. */
const REWRITE_NEW_OWNERS = 2;
const REWRITE_GAP_HOURS = 3;
const MAX_FAILURES = 3;

/** Free key, best writing first. Flash models allow ~20 requests a day each; Flash-Lite ~500 (shared with photo ideas). */
const FREE_FLASH = ["gemini-3.5-flash", "gemini-3.6-flash", "gemini-3.8-flash"];
const FREE_LITE = ["gemini-3.1-flash-lite", "gemini-3.5-flash-lite"];
/** Keeps each model under its free per-minute limit (15 a minute for Flash-Lite, fewer for Flash). */
const MIN_GAP_MS: Record<string, number> = { lite: 4_500, flash: 12_500 };
const COOL_MS = 60_000;
/** The paid key has no free-tier per-minute limit; a short gap just keeps bursts polite. */
const PAID_GAP_MS = 400;

/** Paid prices in US$ per million tokens [input, output]; a model missing here is never used with the paid key. */
const PAID_PRICES: Record<string, [number, number]> = {
  "gemini-3.1-flash-lite": [0.25, 1.5],
  "gemini-3.5-flash-lite": [0.3, 2.5],
  "gemini-3.8-flash": [0.75, 3.75],
};
const DEFAULT_PAID_MODEL = "gemini-3.1-flash-lite";
/** Deliberately high, so the limits below err on the safe side when the exchange rate moves. */
const AUD_PER_USD = 1.6;
/** About A$100 a month. Google's own A$100 monthly cap on the paid project is the backstop. */
const DAILY_PAID_LIMIT_AUD = 3.2;
/** A single edition may use at most an eighth of the day's limit, so even a lost spend record can't run away. */
const RUN_PAID_LIMIT_AUD = DAILY_PAID_LIMIT_AUD / 8;
const MAX_OUTPUT_TOKENS = 4096;

const RUN_SECONDS = 600;
/** A summary normally comes back in 5 to 15 seconds; a call hanging longer is usually an overloaded model, so move on. */
const CALL_TIMEOUT_MS = 45_000;
const MAX_STORIES_PER_RUN = 150;
/** Stories written at the same time; each works through the models on its own, within the shared per-minute gaps. */
const WORKERS = 4;

export interface SummaryCounts {
  written: number;
  kept: number;
  failed: number;
  free: number;
  paid: number;
  paidAud: number;
  dayAud: number;
  waiting: number;
}

const dayIn = (timeZone: string, d: Date) => d.toLocaleDateString("en-CA", { timeZone });
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function loadState(file: string, now: Date): Promise<State> {
  let state: State = { version: STATE_VERSION, writeups: {}, spend: { day: "", aud: 0 }, exhausted: {} };
  try {
    const saved = JSON.parse(await readFile(file, "utf8")) as State;
    if (saved.version === STATE_VERSION) state = saved;
  } catch {
    // first run or unreadable file: start empty
  }
  for (const [id, w] of Object.entries(state.writeups)) if (now.getTime() - Date.parse(w.written) > KEEP_DAYS * 86_400_000) delete state.writeups[id];
  const today = dayIn("Australia/Perth", now);
  if (state.spend.day !== today) state.spend = { day: today, aud: 0 };
  const pacific = dayIn("America/Los_Angeles", now);
  for (const [model, day] of Object.entries(state.exhausted)) if (day !== pacific) delete state.exhausted[model];
  return state;
}

/**
 * Stories the model may summarise: at least two usable reports, or one usable report that says enough to write from
 * (a story only one outlet has covered, or one where the others don't allow AI use).
 */
export function summarisable(story: Story): SourceBlock[] | null {
  const blocks = selectSources(story.items);
  if (blocks.length >= MIN_SOURCES) return blocks;
  return blocks.length === 1 && blocks[0]!.text.length >= SINGLE_MIN_CHARS ? blocks : null;
}

function needsWriting(prev: StoryWriteup | undefined, blocks: SourceBlock[], mode: LegalMode, now: Date): boolean {
  if (!prev) return true;
  const hoursSince = (now.getTime() - Date.parse(prev.written)) / 3_600_000;
  if (!prev.summary) return (prev.failures ?? 1) < MAX_FAILURES && hoursSince >= REWRITE_GAP_HOURS;
  if ((prev.failures ?? 0) >= MAX_FAILURES) return false;
  // Written from one outlet and now covered by more: rewrite once as a comparison.
  if (prev.owners.length < MIN_SOURCES && blocks.length >= MIN_SOURCES) return true;
  // Written in the old short format when the reports support a fuller account: rewrite once, longer.
  if ((prev.format ?? 1) < FORMAT && prev.summary.summary.length < summarySentences(blocks, mode) - 1) return true;
  const used = new Set(prev.owners);
  const fresh = new Set(blocks.map((b) => b.item.source.owner_group).filter((o) => !used.has(o)));
  return fresh.size >= REWRITE_NEW_OWNERS && now.getTime() - Date.parse(prev.written) >= REWRITE_GAP_HOURS * 3_600_000;
}

function costAud(model: string, promptTokens: number, outputTokens: number): number {
  const [input, output] = PAID_PRICES[model]!;
  return ((promptTokens * input + outputTokens * output) / 1_000_000) * AUD_PER_USD;
}

/**
 * Writes AI summaries for the edition's stories (step 2.1). Free models first, best one with requests left today;
 * every answer must pass the support check (validate.ts) or the next model tries. The paid key is the last resort
 * (front-page stories are queued first), within a daily limit enforced here. Stories nobody could summarise show headlines only.
 */
export async function summariseStories(stories: Story[], important: Set<string>, stateFile: string, now: Date): Promise<{ writeups: Map<string, StoryWriteup>; counts: SummaryCounts }> {
  const state = await loadState(stateFile, now);
  const pacific = dayIn("America/Los_Angeles", now);
  // `||`, not `??`: the workflow passes an unset repository variable as "", which once silently disabled the paid key.
  const paidModel = process.env.SUMMARY_PAID_MODEL || DEFAULT_PAID_MODEL;
  const paidReady = Boolean(process.env.GEMINI_PAID_API_KEY) && paidModel in PAID_PRICES;
  const counts: SummaryCounts = { written: 0, kept: 0, failed: 0, free: 0, paid: 0, paidAud: 0, dayAud: 0, waiting: 0 };
  const lastCall = new Map<string, number>();
  const deadline = Date.now() + RUN_SECONDS * 1000;

  /** Models that were busy or rate-limited: skipped for a minute rather than waited for. */
  const cooling = new Map<string, number>();

  const call = async (model: string, paid: boolean, prompt: string): Promise<ModelReply> => {
    // Book the slot before waiting, so parallel workers don't both take it.
    const gap = paid ? PAID_GAP_MS : MIN_GAP_MS[model.includes("lite") ? "lite" : "flash"]!;
    const key = paid ? `paid:${model}` : model;
    const slot = Math.max(Date.now(), (lastCall.get(key) ?? 0) + gap);
    lastCall.set(key, slot);
    if (slot > Date.now()) await sleep(slot - Date.now());
    return geminiJson(model, SYSTEM_PROMPT, prompt, undefined, { keyEnv: paid ? "GEMINI_PAID_API_KEY" : "GEMINI_API_KEY", retries: 0, maxOutputTokens: MAX_OUTPUT_TOKENS, timeoutMs: CALL_TIMEOUT_MS });
  };

  /**
   * One model, up to two tries: the second is told which checks the first answer failed. `answered` is false when
   * the model never replied (busy, out of requests, over the spending limit), so the story is retried next hour.
   */
  const attempt = async (model: string, paid: boolean, blocks: SourceBlock[], headlines: string[], mode: LegalMode): Promise<{ summary: StorySummary | null; answered: boolean }> => {
    let prompt = userPrompt(blocks, mode);
    let answered = false;
    for (let n = 0; n < 2; n++) {
      let reply: ModelReply;
      if (paid) {
        // Reserve the worst case before calling, so parallel calls can't overshoot the limits together.
        const worst = costAud(model, Math.ceil(prompt.length / 3) + 1500, MAX_OUTPUT_TOKENS);
        if (state.spend.aud + worst > DAILY_PAID_LIMIT_AUD || counts.paidAud + worst > RUN_PAID_LIMIT_AUD) return { summary: null, answered };
        state.spend.aud += worst;
        counts.paidAud += worst;
        try {
          reply = await call(model, paid, prompt);
        } finally {
          state.spend.aud -= worst;
          counts.paidAud -= worst;
        }
        const aud = costAud(model, reply.promptTokens, reply.outputTokens);
        state.spend.aud += aud;
        counts.paidAud += aud;
      } else reply = await call(model, paid, prompt);
      answered = true;
      const result = reply.json === null ? null : validateSummary(reply.json, blocks, headlines, mode);
      if (result?.summary) return { summary: result.summary, answered };
      prompt = `${userPrompt(blocks, mode)}\n\nYour previous answer failed these checks; fix them and return the full JSON again:\n- ${(result?.errors ?? ["reply was not valid JSON"]).slice(0, 8).join("\n- ")}`;
    }
    return { summary: null, answered };
  };

  const writeups = new Map<string, StoryWriteup>();
  const queue: { story: Story; blocks: SourceBlock[] }[] = [];
  const ordered = [...stories.filter((s) => important.has(s.id)), ...stories.filter((s) => !important.has(s.id))];
  for (const story of ordered) {
    const blocks = summarisable(story);
    if (!blocks) continue;
    const prev = state.writeups[story.id];
    // Single-outlet stories are written only to fill front-page slots; earlier ones are kept for the section pages.
    if (story.independent < 2 && !prev && !important.has(story.id)) continue;
    const mode = legalMode(story.items);
    if (prev?.summary && !stillValid(prev, mode)) delete state.writeups[story.id];
    const current = state.writeups[story.id];
    if (needsWriting(current, blocks, mode, now)) queue.push({ story, blocks });
    else if (current?.summary) {
      writeups.set(story.id, current);
      counts.kept++;
    }
  }

  const later = (story: Story) => {
    counts.waiting++;
    const prev = state.writeups[story.id];
    if (prev?.summary) writeups.set(story.id, prev);
  };

  const write = async ({ story, blocks }: { story: Story; blocks: SourceBlock[] }, worker: number): Promise<void> => {
    const headlines = story.items.map((i) => i.title);
    const mode = legalMode(story.items);
    // Each worker starts on a different Flash-Lite model, so both models' per-minute allowances are used.
    const lite = worker % 2 === 0 ? FREE_LITE : [...FREE_LITE].reverse();
    const ladder = [...(important.has(story.id) ? FREE_FLASH : []), ...lite];
    // Every free model paused: wait for the first to come back rather than skip the story.
    for (;;) {
      const open = ladder.filter((m) => !state.exhausted[m]).map((m) => cooling.get(m) ?? 0);
      const soonest = Math.min(...open);
      if (open.length === 0 || soonest <= Date.now() || soonest > deadline) break;
      await sleep(soonest - Date.now());
    }
    let summary: StorySummary | null = null;
    let answered = false;
    let used = "";
    let paid = false;
    for (const model of ladder) {
      if (state.exhausted[model] || (cooling.get(model) ?? 0) > Date.now()) continue;
      try {
        const r = await attempt(model, false, blocks, headlines, mode);
        summary = r.summary;
        answered ||= r.answered;
      } catch (err) {
        if (err instanceof GeminiDailyQuotaError) state.exhausted[model] = pacific;
        else {
          cooling.set(model, Date.now() + COOL_MS);
          console.log(`Summary model ${model} paused for a minute: ${err instanceof Error ? err.message : err}`);
        }
      }
      if (summary) {
        used = model;
        break;
      }
    }
    if (!summary && paidReady) {
      try {
        const r = await attempt(paidModel, true, blocks, headlines, mode);
        summary = r.summary;
        answered ||= r.answered;
      } catch (err) {
        console.log(`Paid summary failed for ${story.id}: ${err instanceof Error ? err.message : err}`);
      }
      if (summary) [used, paid] = [paidModel, true];
    }
    if (!summary && !answered) return later(story);
    const prev = state.writeups[story.id];
    if (!summary && prev?.summary) {
      // A failed rewrite keeps the summary we have.
      prev.failures = (prev.failures ?? 0) + 1;
      writeups.set(story.id, prev);
      counts.failed++;
      return;
    }
    const writeup: StoryWriteup = {
      summary,
      sources: Object.fromEntries(blocks.map((b) => [b.id, { name: b.item.source.name, url: b.item.url }])),
      owners: [...new Set(blocks.map((b) => b.item.source.owner_group))],
      model: used,
      paid,
      written: now.toISOString(),
      ...(summary ? {} : { failures: (prev?.failures ?? 0) + 1 }),
      ...(mode === "careful" ? { legalRules: LEGAL_RULES } : mode === "brief" ? { brief: true } : {}),
      format: FORMAT,
    };
    state.writeups[story.id] = writeup;
    if (summary) {
      writeups.set(story.id, writeup);
      counts.written++;
      counts[paid ? "paid" : "free"]++;
    } else counts.failed++;
  };

  let next = 0;
  const worker = async (n: number) => {
    while (next < queue.length) {
      const job = queue[next++]!;
      if (next > MAX_STORIES_PER_RUN || Date.now() > deadline) later(job.story);
      else await write(job, n);
    }
  };
  await Promise.all(Array.from({ length: WORKERS }, (_, n) => worker(n)));

  counts.dayAud = state.spend.aud;
  await mkdir(dirname(stateFile), { recursive: true });
  await writeFile(stateFile, JSON.stringify(state));
  return { writeups, counts };
}
