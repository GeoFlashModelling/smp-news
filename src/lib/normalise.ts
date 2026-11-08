import type { Section, Source } from "../config/sources.js";
import type { FeedSnapshot } from "./fetch-feeds.js";

export interface Item {
  /** Canonical URL; unique across the edition. */
  key: string;
  source: Source;
  title: string;
  url: string;
  /** Feed description. Always "" for sources with ai_input_allowed false: their text beyond the headline is never used. */
  summary: string;
  published: Date;
  sections: Section[];
  /** Position (0 = first) in the outlet's top-stories feed, when it appears in one. */
  frontRank?: number;
}

const WINDOW_HOURS = 48;
const FUTURE_TOLERANCE_MS = 60 * 60 * 1000;
const TRACKING_PARAMS = /^(utm_\w+|fbclid|gclid|ocid|cmpid|mc_cid|mc_eid|smid|ref|sr_share|rss|cid)$/i;

/** http(s) URL with tracking parameters and fragment removed, or null if the link is unusable. */
export function canonicalUrl(link: string): string | null {
  let url: URL;
  try {
    url = new URL(link.trim());
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  url.hash = "";
  url.hostname = url.hostname.toLowerCase();
  for (const name of [...url.searchParams.keys()]) if (TRACKING_PARAMS.test(name)) url.searchParams.delete(name);
  return url.toString();
}

/** Removes a trailing " - Outlet" / " | Outlet" that repeats the source's own name. */
export function cleanTitle(title: string, sourceName: string): string {
  const t = title.replace(/\s+/g, " ").trim();
  const m = /^(.*\S)\s+[|\-–—:]\s+([^|\-–—]{2,60})$/.exec(t);
  if (!m) return t;
  const tail = m[2]!.toLowerCase().replace(/[^a-z0-9]/g, "");
  const name = sourceName.toLowerCase().replace(/[^a-z0-9]/g, "");
  return tail.length > 1 && (name.includes(tail) || tail.includes(name)) ? m[1]! : t;
}

/** Flattens fetched feeds into one de-duplicated list of recent items. */
export function normalise(feeds: FeedSnapshot[], sources: Map<string, Source>, now: Date): Item[] {
  const byKey = new Map<string, Item>();
  const oldest = now.getTime() - WINDOW_HOURS * 3600 * 1000;
  for (const feed of feeds) {
    const source = sources.get(feed.source);
    if (!source?.enabled) continue;
    const top = source.feeds.find((f) => f.url === feed.url)?.top === true;
    for (const [position, raw] of feed.items.entries()) {
      const key = canonicalUrl(raw.link);
      const published = raw.published ? new Date(raw.published) : null;
      if (!key || !raw.title.trim() || !published || Number.isNaN(published.getTime())) continue;
      if (published.getTime() < oldest || published.getTime() > now.getTime() + FUTURE_TOLERANCE_MS) continue;
      const sections = feed.sections as Section[];
      const existing = byKey.get(key);
      if (existing) {
        for (const s of sections) if (!existing.sections.includes(s)) existing.sections.push(s);
        if (top) existing.frontRank = Math.min(existing.frontRank ?? position, position);
        continue;
      }
      byKey.set(key, {
        key,
        source,
        title: cleanTitle(raw.title, source.name),
        url: key,
        summary: source.ai_input_allowed ? raw.summary : "",
        published,
        sections: [...sections],
        ...(top ? { frontRank: position } : {}),
      });
    }
  }
  const seen = new Set<string>();
  return [...byKey.values()].filter((item) => {
    const sig = `${item.source.id}|${item.title.toLowerCase()}`;
    if (seen.has(sig)) return false;
    seen.add(sig);
    return true;
  });
}
