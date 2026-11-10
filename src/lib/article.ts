import { toPlainText } from "./feed-parse.js";
import { USER_AGENT } from "./http.js";
import { isAllowed, parseRobots, type Robots } from "./robots.js";
import type { Item } from "./normalise.js";

/**
 * Full article text for sources whose terms allow it (`full_text_allowed`, step 2.2b): the free article page, with
 * robots.txt checked for that exact URL. The text is used only in memory as research for our own summary; it is never
 * stored, cached or published.
 */
const ARTICLE_CHARS = 4000;
const MIN_PARAGRAPH_CHARS = 40;
const TIMEOUT_MS = 15_000;

const robotsCache = new Map<string, Promise<Robots>>();

function robotsFor(origin: string): Promise<Robots> {
  let entry = robotsCache.get(origin);
  if (!entry) {
    entry = (async () => {
      try {
        const res = await fetch(`${origin}/robots.txt`, { headers: { "user-agent": USER_AGENT }, signal: AbortSignal.timeout(TIMEOUT_MS) });
        // RFC 9309: 4xx means no restrictions; 5xx or unreachable means assume everything is disallowed.
        if (res.status >= 400 && res.status < 500) return parseRobots("");
        return parseRobots(res.ok ? await res.text() : "User-agent: *\nDisallow: /");
      } catch {
        return parseRobots("User-agent: *\nDisallow: /");
      }
    })();
    robotsCache.set(origin, entry);
  }
  return entry;
}

const paragraphs = (html: string) =>
  [...html.matchAll(/<p\b[^>]*>([\s\S]*?)<\/p>/gi)].map((m) => toPlainText(m[1]!)).filter((p) => p.length >= MIN_PARAGRAPH_CHARS);

/** The article body: the <article> (or <main>) with the most paragraph text, without page furniture. */
export function articleText(html: string): string {
  const page = html.replace(/<(script|style|noscript|svg|nav|aside|footer|header|form|figure)\b[\s\S]*?<\/\1>/gi, " ");
  const candidates = [...page.matchAll(/<(article|main)\b[\s\S]*?<\/\1>/gi)].map((m) => paragraphs(m[0]));
  const best = candidates.reduce<string[]>((a, b) => (b.join("").length > a.join("").length ? b : a), []);
  const text = (best.length ? best : paragraphs(page)).join("\n");
  return text.length <= ARTICLE_CHARS ? text : text.slice(0, text.lastIndexOf(" ", ARTICLE_CHARS));
}

/** The article's text, or null when the source doesn't allow it, robots.txt disallows the page, or it can't be read. */
export async function fetchArticle(item: Item): Promise<string | null> {
  if (!item.source.full_text_allowed || item.source.paywall === "paywalled") return null;
  try {
    const url = new URL(item.url);
    if (!isAllowed(await robotsFor(url.origin), USER_AGENT, url.href)) return null;
    const res = await fetch(url, { headers: { "user-agent": USER_AGENT, accept: "text/html" }, signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!res.ok || !(res.headers.get("content-type") ?? "").includes("html")) return null;
    const text = articleText(await res.text());
    return text.length >= MIN_PARAGRAPH_CHARS * 3 ? text : null;
  } catch {
    return null;
  }
}
