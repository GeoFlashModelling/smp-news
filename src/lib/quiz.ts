import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { USER_AGENT } from "./http.js";

/**
 * The daily quiz: 10 multiple-choice general-knowledge questions from the Open Trivia Database (opentdb.com,
 * CC BY-SA 4.0, credit required). Chosen once per Perth day and kept in a state file, so every edition that day
 * shows the same quiz; questions already used are remembered so they don't come back.
 */
export interface Question {
  question: string;
  answers: string[];
  /** Index of the right answer in `answers`. */
  correct: number;
  category: string;
  difficulty: "easy" | "medium" | "hard";
}

export interface Quiz {
  /** Perth calendar date, YYYY-MM-DD. */
  day: string;
  questions: Question[];
}

interface State {
  quiz: Quiz | null;
  /** Questions used before, so the daily quiz doesn't repeat them. */
  seen: string[];
}

const API = "https://opentdb.com/api.php?amount=50&type=multiple&encode=url3986";
const QUESTIONS = 10;
const MAX_PER_CATEGORY = 2;
const MAX_HARD = 3;
const MAX_SEEN = 5000;
/** The API allows one request every 5 seconds per address. */
const API_GAP_MS = 5_500;
const ATTEMPTS = 4;
const TIMEOUT_MS = 15_000;

/** Niche, very American or divisive categories that make a poor general quiz for Australian readers. */
const LEFT_OUT = /video games|anime|board games|comics|cartoon|computers|gadgets|politics|celebrities/i;
const UNSUITABLE = /\*|\bf\W?\W?\W?k\b|fuck|shit|nazi|hitler|porn|drugs?\b/i;
/** American leagues and trivia that few Australians would know. */
const US_ONLY = /\b(MLS|NFL|NBA|NHL|MLB|NCAA|WNBA|NASCAR|Super Bowl|World Series|Stanley Cup|American football|baseball|U\.?S\.? states?|American states?|which state|state capital|zip code|Thanksgiving|presidents?|Congress|Senate|sports teams)\b/i;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const perthDay = (d: Date) => d.toLocaleDateString("en-CA", { timeZone: "Australia/Perth" });

/** A fixed shuffle per day and question, so every page in an edition (and every edition that day) agrees. */
function seeded(seed: string): () => number {
  let h = 2166136261;
  for (const c of seed) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
  return () => {
    h = Math.imul(h ^ (h >>> 15), 2246822507);
    h = Math.imul(h ^ (h >>> 13), 3266489909);
    return ((h ^= h >>> 16) >>> 0) / 4294967296;
  };
}

async function fetchBatch(): Promise<any[]> {
  const res = await fetch(API, { headers: { "user-agent": USER_AGENT }, signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!res.ok) throw new Error(`Open Trivia DB ${res.status}`);
  const body = (await res.json()) as { response_code: number; results?: any[] };
  if (body.response_code !== 0) throw new Error(`Open Trivia DB response code ${body.response_code}`);
  return body.results ?? [];
}

/** Adds suitable questions from one batch to `chosen`, keeping the category and difficulty mix. */
function pick(raw: any[], seen: Set<string>, day: string, chosen: Question[]): void {
  const decode = (s: string) => decodeURIComponent(s).trim();
  const perCategory = new Map<string, number>();
  for (const q of chosen) perCategory.set(q.category, (perCategory.get(q.category) ?? 0) + 1);
  let hard = chosen.filter((q) => q.difficulty === "hard").length;
  for (const r of raw) {
    const question = decode(r.question);
    const category = decode(r.category).replace(/^(Entertainment|Science): /, "");
    const difficulty = decode(r.difficulty) as Question["difficulty"];
    const right = decode(r.correct_answer);
    const wrong = (r.incorrect_answers as string[]).map(decode);
    const all = [question, right, ...wrong].join(" ");
    if (seen.has(question) || LEFT_OUT.test(decode(r.category)) || UNSUITABLE.test(all) || US_ONLY.test(all) || wrong.length !== 3) continue;
    if ((perCategory.get(category) ?? 0) >= MAX_PER_CATEGORY || (difficulty === "hard" && hard >= MAX_HARD)) continue;
    const random = seeded(`${day}|${question}`);
    const answers = [right, ...wrong].map((a) => ({ a, k: random() })).sort((x, y) => x.k - y.k).map((x) => x.a);
    chosen.push({ question, answers, correct: answers.indexOf(right), category, difficulty });
    perCategory.set(category, (perCategory.get(category) ?? 0) + 1);
    if (difficulty === "hard") hard++;
    seen.add(question);
    if (chosen.length === QUESTIONS) break;
  }
}

/** Today's quiz: from the state file if already chosen, otherwise fresh. null if none could be put together. */
export async function loadQuiz(stateFile: string, now: Date): Promise<Quiz | null> {
  const day = perthDay(now);
  let state: State = { quiz: null, seen: [] };
  try {
    state = JSON.parse(await readFile(stateFile, "utf8")) as State;
  } catch {
    // first run or unreadable file: start empty
  }
  if (state.quiz?.day === day && state.quiz.questions.length === QUESTIONS) return state.quiz;

  const seen = new Set(state.seen);
  const questions: Question[] = [];
  for (let n = 0; n < ATTEMPTS && questions.length < QUESTIONS; n++) {
    if (n > 0) await sleep(API_GAP_MS);
    try {
      pick(await fetchBatch(), seen, day, questions);
    } catch (err) {
      console.log(`Quiz questions unavailable: ${err instanceof Error ? err.message : err}`);
    }
  }
  if (questions.length < QUESTIONS) return state.quiz?.questions.length === QUESTIONS ? state.quiz : null;
  // Easiest first, so everyone gets off to a good start.
  const order = { easy: 0, medium: 1, hard: 2 };
  questions.sort((a, b) => order[a.difficulty] - order[b.difficulty]);
  const quiz: Quiz = { day, questions };
  await mkdir(dirname(stateFile), { recursive: true });
  await writeFile(stateFile, JSON.stringify({ quiz, seen: [...seen].slice(-MAX_SEEN) } satisfies State));
  return quiz;
}
