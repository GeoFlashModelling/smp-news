import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { ModelUsage } from "../ai/gemini.js";

/** One edition's numbers, for the nightly report (scripts/report.ts). Counts only: no story text, no keys. */
export interface EditionRecord {
  at: string;
  ms: number;
  /** How long each stage took, to spot a slow one before the 20-minute limit. */
  stageMs: { feeds: number; summaries: number; photos: number; site: number };
  feeds: { ok: number; total: number; failed: string[] };
  items: number;
  stories: number;
  multi: number;
  photos: { total: number; event: number; object: number; broad: number; shared: number; elsewhere: number; offPoint?: number; multiWithPhoto: number };
  summaries?: { multiWritten: number; single: number; written: number; free: number; paid: number; fromArticles: number; failed: number; paidAud: number; dayAud: number; waiting?: number; oldestWaitHours?: number };
  /** Gemini requests per model, free and paid (summaries, photo ideas, quiz, facts). */
  ai?: Record<string, ModelUsage>;
  files: number;
}

/** Long enough for a month-to-date spend in the edition emails. */
const KEEP_DAYS = 35;

/** Adds this edition to the history file GitHub Actions carries between runs, dropping entries older than a few days. */
export async function recordEdition(file: string, record: EditionRecord): Promise<void> {
  let list: EditionRecord[] = [];
  try {
    list = JSON.parse(await readFile(file, "utf8")) as EditionRecord[];
  } catch {
    // first run: start a new history
  }
  const oldest = Date.parse(record.at) - KEEP_DAYS * 86_400_000;
  list = [...list.filter((r) => Date.parse(r.at) >= oldest), record];
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(list));
}
