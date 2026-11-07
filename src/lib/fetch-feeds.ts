import type { Feed, Source } from "../config/sources.js";
import { parseFeed, type FeedItem } from "./feed-parse.js";
import { FEED_ACCEPT, USER_AGENT, mapLimit } from "./http.js";

const TIMEOUT_MS = 20_000;
const CONCURRENCY = 6;

export interface FeedSnapshot {
  source: string;
  url: string;
  sections: string[];
  status: number | null;
  ok: boolean;
  problem: string | null;
  latency_ms: number;
  items: FeedItem[];
}

async function fetchFeed(source: Source, feed: Feed): Promise<FeedSnapshot> {
  const started = Date.now();
  const base = { source: source.id, url: feed.url, sections: feed.sections };
  try {
    const res = await fetch(feed.url, {
      headers: { "user-agent": USER_AGENT, accept: FEED_ACCEPT },
      redirect: "follow",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const items = res.ok ? parseFeed(await res.text()) : [];
    const problem = !res.ok ? `HTTP ${res.status}` : items.length === 0 ? "no items" : null;
    return { ...base, status: res.status, ok: problem === null, problem, latency_ms: Date.now() - started, items };
  } catch (err) {
    const e = err as Error & { cause?: { code?: string } };
    const problem = e.name === "TimeoutError" ? `timeout after ${TIMEOUT_MS / 1000} s` : (e.cause?.code ?? e.message);
    return { ...base, status: null, ok: false, problem, latency_ms: Date.now() - started, items: [] };
  }
}

/** Fetches every feed of every enabled source. */
export async function fetchAllFeeds(sources: Source[]): Promise<FeedSnapshot[]> {
  const jobs = sources.filter((s) => s.enabled).flatMap((s) => s.feeds.map((f) => ({ s, f })));
  return mapLimit(jobs, CONCURRENCY, ({ s, f }) => fetchFeed(s, f));
}
