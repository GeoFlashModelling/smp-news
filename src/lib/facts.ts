import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { geminiJson } from "../ai/gemini.js";
import { USER_AGENT } from "./http.js";

/** A short fact from Wikipedia (CC BY-SA 4.0), with the article it comes from. */
export interface Fact {
  text: string;
  /** The Wikipedia article to read more, for the credit link. */
  url: string;
  /** "On this day" only: the year it happened. */
  year?: number;
}

export interface Facts {
  onThisDay: Fact | null;
  funFact: Fact | null;
}

const TIMEOUT_MS = 15_000;
const PERTH_OFFSET_MS = 8 * 3_600_000;
/** Australian events first: readers are here. */
const AUSTRALIAN = /\b(Australia|Australian|Perth|Western Australia|Sydney|Melbourne|Brisbane|Adelaide|Hobart|Darwin|Canberra|Tasmania|Queensland|New South Wales|Victoria)\b/;
/** A light box at the top of the page is no place for massacres; such days fall back to the next event. */
const GRIM = /\b(kill(s|ed|ing)?|dead|deaths?|died|massacres?|murder(s|ed)?|genocide|bomb(s|ed|ing)?|terror(ist|ism)?|shot|shooting|executed|execution|suicide|rape[ds]?|abuse[ds]?|torture[ds]?|Holocaust|Nazis?|lynch(ed|ing)?|hanged|beheaded|casualties|famine|epidemic|pandemic|crash(ed)?|disaster|missing|corpses?|cannibal\w*)\b/i;

/** Battles and wars are fine history but a poor first choice for a light box; used only when nothing else is left. */
const WAR = /\b(war|wars|battle|battles|invasion|invaded|siege|army|forces|troops|military|naval|skirmish|coup|attack(s|ed)?|insurgen\w*|rebels?)\b/i;

async function getJson(url: string): Promise<any> {
  const res = await fetch(url, { headers: { "user-agent": USER_AGENT }, signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!res.ok) throw new Error(`${new URL(url).host} ${res.status}`);
  return res.json();
}

function plain(html: string): string {
  return html
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&nbsp;|&#160;/g, " ")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/\s*\([^()]*\b(pictured|illustrated|shown)\b[^()]*\)/gi, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** Perth's calendar date (month, day) for `now`. */
function perthDate(now: Date): { month: number; day: number } {
  const d = new Date(now.getTime() + PERTH_OFFSET_MS);
  return { month: d.getUTCMonth() + 1, day: d.getUTCDate() };
}

/** One of Wikipedia's selected anniversaries for today's date in Perth: an Australian one if there is one, never a grim one. */
async function onThisDay(now: Date): Promise<Fact | null> {
  const { month, day } = perthDate(now);
  const date = `${String(month).padStart(2, "0")}/${String(day).padStart(2, "0")}`;
  const usable = (list: unknown) => ((list ?? []) as any[]).filter((e) => typeof e.text === "string" && typeof e.year === "number" && !GRIM.test(e.text));
  const selected = usable((await getJson(`https://api.wikimedia.org/feed/v1/wikipedia/en/onthisday/selected/${date}`)).selected);
  const peaceful = selected.filter((e) => !WAR.test(e.text));
  let pick = peaceful.find((e) => AUSTRALIAN.test(e.text));
  if (!pick) {
    // Wikipedia's few "selected" anniversaries are rarely Australian; its full list for the date usually has one.
    const all = usable((await getJson(`https://api.wikimedia.org/feed/v1/wikipedia/en/onthisday/events/${date}`)).events);
    pick = all.find((e) => !WAR.test(e.text) && AUSTRALIAN.test(e.text));
  }
  pick ??= peaceful[0] ?? selected[0];
  if (!pick) return null;
  const page = (pick.pages ?? [])[0];
  return { text: plain(pick.text), year: pick.year, url: page?.content_urls?.desktop?.page ?? "https://en.wikipedia.org/wiki/Wikipedia:Selected_anniversaries" };
}

/**
 * Many "Did you know" facts only interest fans of a niche (a minor footballer, a B-side, a railway station): owner,
 * 11 Nov 2026, "they are a bit boring". The day's best few are chosen by a free AI request (`rankFacts`); this word
 * score orders them when the AI can't be asked.
 */
const WOW = /\b(first|only|largest|biggest|smallest|tallest|oldest|youngest|longest|fastest|world|record|million|billion|species|planet|moon|stars?|space|ancient|fossils?|dinosaurs?|invented|accidentally|secretly|named after|animals?|birds?|sharks?|whales?|spiders?|insects?|dogs?|cats?|horses?|banned|illegal|mistaken|survived|escaped|discovered)\b/i;
const NICHE = /\b(footballer|cricketer|rugby|baseball|basketball|ice hockey|politician|MLA|MP|councillor|bishop|priest|album|single|song|EP|episode|season|route|highway|railway|station|regiment|battalion|ship|frigate|destroyer|cultivar|genus|moth|beetle|snail|parish|electoral|constituency|by-election|footballers|league)\b/;

function wordScore(text: string): number {
  return (WOW.test(text) ? 2 : 0) + (/\d/.test(text) ? 1 : 0) + (AUSTRALIAN.test(text) ? 1 : 0) - (NICHE.test(text) ? 3 : 0);
}

const FACTS_PER_DAY = 24;
const RANK_MODELS = ["gemini-3.5-flash-lite", "gemini-3.1-flash-lite"];
const RANK_SYSTEM = `You pick "Did you know" facts for the top of an Australian news website. Readers are ordinary adults, not specialists. From the numbered facts, choose the ${FACTS_PER_DAY} a curious reader would most enjoy: genuinely surprising, delightful or "I never knew that", understandable without background knowledge. Favour nature, animals, space, science, inventions, records, quirky history, odd coincidences and anything Australian. Leave out facts that only matter to fans of a niche (minor athletes, politicians, clergy, songs, albums, TV episodes, sports seasons, roads, railway stations, ships, military units, obscure species), facts that are just someone's job or title, and anything sad, violent or political. Return their numbers, best first.`;

/** The day's most interesting facts, best first, by a free AI request; null when no free model answered. */
async function rankFacts(hooks: Fact[]): Promise<number[] | null> {
  if (!process.env.GEMINI_API_KEY) return null;
  const list = hooks.map((h, i) => `${i}. ${h.text}`).join("\n");
  const schema = { type: "object", properties: { best: { type: "array", items: { type: "integer" }, maxItems: FACTS_PER_DAY } }, required: ["best"] };
  for (const model of RANK_MODELS) {
    try {
      const reply = await geminiJson(model, RANK_SYSTEM, list, schema, { retries: 1, timeoutMs: 60_000 });
      const best = (reply.json as { best?: unknown } | null)?.best;
      if (Array.isArray(best)) {
        const picked = [...new Set(best.filter((n): n is number => Number.isInteger(n) && n >= 0 && n < hooks.length))];
        if (picked.length >= 6) return picked;
      }
    } catch (err) {
      console.log(`Fun fact ranking with ${model} failed: ${err instanceof Error ? err.message : err}`);
    }
  }
  return null;
}

interface FactsState {
  /** Perth date the choice was made. */
  day: string;
  facts: Fact[];
  /** Chosen by the AI (true) or by word score only, in which case it is asked again next edition. */
  ranked: boolean;
}

/**
 * Wikipedia's "Did you know…" facts (hand-picked, sourced, meant to be surprising), from the last week or so of the
 * main page. The day's most interesting are chosen once a day and kept in `stateFile`; a different one each hour,
 * in an order fixed by the hour so every page in an edition agrees.
 */
async function funFact(now: Date, stateFile: string): Promise<Fact | null> {
  const day = new Date(now.getTime() + PERTH_OFFSET_MS).toISOString().slice(0, 10);
  let state: FactsState | null = null;
  try {
    state = JSON.parse(await readFile(stateFile, "utf8")) as FactsState;
  } catch {
    // first run: choose afresh
  }
  if (!state || state.day !== day || !state.ranked) {
    const hooks = await didYouKnow();
    if (hooks.length) {
      const order = await rankFacts(hooks);
      const facts = order ? order.map((i) => hooks[i]!) : hooks.map((h, i) => [h, wordScore(h.text), i] as const).sort((a, b) => b[1] - a[1] || a[2] - b[2]).slice(0, FACTS_PER_DAY).map(([h]) => h);
      state = { day, facts, ranked: order !== null };
      await mkdir(dirname(stateFile), { recursive: true });
      await writeFile(stateFile, JSON.stringify(state));
    }
  }
  if (!state?.facts.length) return null;
  return state.facts[Math.floor(now.getTime() / 3_600_000) % state.facts.length]!;
}

async function didYouKnow(): Promise<Fact[]> {
  const body = await getJson("https://en.wikipedia.org/w/api.php?action=parse&page=Wikipedia:Recent_additions&redirects=1&prop=text&format=json&formatversion=2");
  const html: string = body.parse?.text ?? "";
  const hooks: Fact[] = [];
  for (const m of html.matchAll(/<li[^>]*>\s*(?:…|\.\.\.)\s*that([\s\S]*?)<\/li>/g)) {
    const raw = m[1]!;
    // Hooks like "... that, when X happened, ..." leave a leading comma once "that" is cut off.
    const text = plain(raw).replace(/\?$/, "").replace(/^[\s,;:]+/, "");
    if (text.length < 20 || text.length > 260 || GRIM.test(text)) continue;
    const link = /<b>\s*<a href="\/wiki\/([^"#]+)"/.exec(raw) ?? /<a href="\/wiki\/([^"#:]+)"/.exec(raw);
    if (!link) continue;
    hooks.push({ text: `${text.charAt(0).toUpperCase()}${text.slice(1)}.`, url: `https://en.wikipedia.org/wiki/${link[1]}` });
  }
  return hooks;
}

/** Both facts; either is null when Wikipedia can't be reached, and the page just leaves that box out. */
export async function loadFacts(now: Date, stateFile = ".cache/facts.json"): Promise<Facts> {
  const safe = async (name: string, f: () => Promise<Fact | null>) => {
    try {
      return await f();
    } catch (err) {
      console.log(`${name} unavailable: ${err instanceof Error ? err.message : err}`);
      return null;
    }
  };
  const [a, b] = await Promise.all([safe("On this day", () => onThisDay(now)), safe("Fun fact", () => funFact(now, stateFile))]);
  return { onThisDay: a, funFact: b };
}
