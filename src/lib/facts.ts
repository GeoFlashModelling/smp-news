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
const GRIM = /\b(kill(s|ed|ing)?|dead|deaths?|died|massacres?|murder(s|ed)?|genocide|bomb(s|ed|ing)?|terror(ist|ism)?|shot|shooting|executed|execution|suicide|rape[ds]?|abuse[ds]?|torture[ds]?|Holocaust|Nazis?|lynch(ed|ing)?|hanged|beheaded|casualties|famine|epidemic|pandemic|crash(ed)?|disaster|missing|corpse|cannibal\w*)\b/i;

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
    .replace(/\s*\((pictured|illustrated|shown)[^)]*\)/gi, "")
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
 * Wikipedia's "Did you know…" facts (hand-picked, sourced, meant to be surprising), from the last week or so of the
 * main page. A different one each hour; the order is fixed by the hour so every page in an edition agrees.
 */
async function funFact(now: Date): Promise<Fact | null> {
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
  if (hooks.length === 0) return null;
  return hooks[Math.floor(now.getTime() / 3_600_000) % hooks.length]!;
}

/** Both facts; either is null when Wikipedia can't be reached, and the page just leaves that box out. */
export async function loadFacts(now: Date): Promise<Facts> {
  const safe = async (name: string, f: () => Promise<Fact | null>) => {
    try {
      return await f();
    } catch (err) {
      console.log(`${name} unavailable: ${err instanceof Error ? err.message : err}`);
      return null;
    }
  };
  const [a, b] = await Promise.all([safe("On this day", () => onThisDay(now)), safe("Fun fact", () => funFact(now))]);
  return { onThisDay: a, funFact: b };
}
