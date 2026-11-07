import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { gzipSync } from "node:zlib";
import { loadSources, type Feed, type Source } from "../config/sources.js";
import { parseFeed, type FeedItem } from "../lib/feed-parse.js";
import { FEED_ACCEPT, USER_AGENT, mapLimit } from "../lib/http.js";

const TIMEOUT_MS = 20_000;
const CONCURRENCY = 6;
const RUNS_HEADER = "taken_at,event,expected_at,lateness_s,feeds_ok,feeds_total,items\n";

interface FeedSnapshot {
  source: string;
  url: string;
  sections: string[];
  status: number | null;
  ok: boolean;
  problem: string | null;
  latency_ms: number;
  items: FeedItem[];
}

async function snapshotFeed(source: Source, feed: Feed): Promise<FeedSnapshot> {
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

/** For an hourly cron ("M * * * *"), the most recent scheduled time at or before `now`. */
export function expectedRunTime(schedule: string | undefined, now: Date): Date | null {
  const minute = /^(\d{1,2}) \* \* \* \*$/.exec(schedule?.trim() ?? "")?.[1];
  if (minute === undefined) return null;
  const expected = new Date(now);
  expected.setUTCMinutes(Number(minute), 0, 0);
  if (expected > now) expected.setUTCHours(expected.getUTCHours() - 1);
  return expected;
}

async function main(): Promise<void> {
  const now = new Date();
  const until = process.env.SNAPSHOT_UNTIL;
  if (until && now > new Date(until)) {
    console.log(`Snapshot window ended at ${until}; nothing to do.`);
    return;
  }

  const dir = pathToFileURL(`${resolve(process.env.SNAPSHOT_DIR ?? ".cache/snapshots")}/`);
  const config = await loadSources();
  const jobs = config.sources.filter((s) => s.enabled).flatMap((s) => s.feeds.map((f) => ({ s, f })));
  const feeds = await mapLimit(jobs, CONCURRENCY, ({ s, f }) => snapshotFeed(s, f));

  const takenAt = now.toISOString();
  const event = process.env.GITHUB_EVENT_NAME ?? "local";
  const expected = expectedRunTime(process.env.SCHEDULE, now);
  const latenessS = expected ? Math.round((now.getTime() - expected.getTime()) / 1000) : null;
  const ok = feeds.filter((f) => f.ok).length;
  const itemCount = feeds.reduce((n, f) => n + f.items.length, 0);

  const snapshot = {
    taken_at: takenAt,
    run: { event, schedule: process.env.SCHEDULE ?? null, expected_at: expected?.toISOString() ?? null, lateness_s: latenessS, run_id: process.env.GITHUB_RUN_ID ?? null },
    feeds,
  };
  await mkdir(dir, { recursive: true });
  const file = new URL(`${takenAt.slice(0, 16).replace(":", "-")}Z.json.gz`, dir);
  await writeFile(file, gzipSync(JSON.stringify(snapshot)));

  const runsFile = new URL("runs.csv", dir);
  const existing = await readFile(runsFile, "utf8").catch(() => "");
  if (!existing) await writeFile(runsFile, RUNS_HEADER);
  await appendFile(runsFile, `${takenAt},${event},${expected?.toISOString() ?? ""},${latenessS ?? ""},${ok},${feeds.length},${itemCount}\n`);

  const failed = feeds.filter((f) => !f.ok).map((f) => `${f.source} (${f.problem})`);
  console.log(`Snapshot ${takenAt}: ${ok}/${feeds.length} feeds OK, ${itemCount} items, lateness ${latenessS ?? "n/a"} s.`);
  if (failed.length > 0) console.log(`Failed: ${failed.join(", ")}`);
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
