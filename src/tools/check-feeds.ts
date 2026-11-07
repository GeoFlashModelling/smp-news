import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { loadSources, toBarLean, type Feed, type Source } from "../config/sources.js";
import { FEED_ACCEPT, USER_AGENT, mapLimit } from "../lib/http.js";

const TIMEOUT_MS = 20_000;
const CONCURRENCY = 6;
const STALE_HOURS = 48;
const OUTPUT = new URL("../../.cache/feed-check.json", import.meta.url);

interface FeedResult {
  source: string;
  lean: string;
  via: Feed["via"];
  url: string;
  status: number | null;
  items: number;
  newest_age_hours: number | null;
  latency_ms: number;
  ok: boolean;
  problem: string | null;
}

function countItems(body: string): number {
  return (body.match(/<item[\s>]/g) ?? []).length + (body.match(/<entry[\s>]/g) ?? []).length;
}

function newestAgeHours(body: string): number | null {
  const dates = [...body.matchAll(/<(?:pubDate|updated|published|dc:date)>([^<]+)</g)]
    .map((m) => Date.parse(m[1] ?? ""))
    .filter((d) => !Number.isNaN(d));
  if (dates.length === 0) return null;
  return Math.round(((Date.now() - Math.max(...dates)) / 3_600_000) * 10) / 10;
}

async function checkFeed(source: Source, feed: Feed): Promise<FeedResult> {
  const started = Date.now();
  const base = { source: source.id, lean: source.lean ?? "—", via: feed.via, url: feed.url };
  try {
    const res = await fetch(feed.url, {
      headers: { "user-agent": USER_AGENT, accept: FEED_ACCEPT },
      redirect: "follow",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const body = await res.text();
    const items = countItems(body);
    const age = newestAgeHours(body);
    let problem: string | null = null;
    if (!res.ok) problem = `HTTP ${res.status}`;
    else if (items === 0) problem = "no items (not a feed, or empty)";
    else if (age !== null && age > (source.stale_hours ?? STALE_HOURS)) problem = `stale (newest item ${age} h old)`;
    if (problem === null && res.url !== feed.url && new URL(res.url).host !== new URL(feed.url).host) {
      problem = `redirected to ${new URL(res.url).host}`;
    }
    return { ...base, status: res.status, items, newest_age_hours: age, latency_ms: Date.now() - started, ok: problem === null, problem };
  } catch (err) {
    const e = err as Error & { cause?: { code?: string } };
    return {
      ...base,
      status: null,
      items: 0,
      newest_age_hours: null,
      latency_ms: Date.now() - started,
      ok: false,
      problem: e.name === "TimeoutError" ? `timeout after ${TIMEOUT_MS / 1000} s` : (e.cause?.code ?? e.message),
    };
  }
}

function toMarkdown(results: FeedResult[], sources: Source[], ranAt: string): string {
  const ok = results.filter((r) => r.ok).length;
  const lines = [
    `## Feed check — ${ranAt}`,
    "",
    `${ok} / ${results.length} feeds OK. Host: ${process.env.GITHUB_ACTIONS ? "GitHub runner" : "local"}.`,
    "",
    "| Source | Lean | Via | Status | Items | Newest (h) | Latency (ms) | Problem |",
    "|---|---|---|---|---|---|---|---|",
    ...results.map(
      (r) =>
        `| ${r.ok ? "✅" : "❌"} ${r.source} | ${r.lean} | ${r.via} | ${r.status ?? "—"} | ${r.items} | ${r.newest_age_hours ?? "?"} | ${r.latency_ms} | ${r.problem ?? ""} |`,
    ),
    "",
    "### Reachable sources by bar lean",
    "",
  ];
  const reachable = new Set(results.filter((r) => r.ok).map((r) => r.source));
  for (const bar of ["left", "centre", "right"] as const) {
    const group = sources.filter((s) => s.enabled && s.lean !== null && toBarLean(s.lean) === bar);
    const up = group.filter((s) => reachable.has(s.id));
    lines.push(`- **${bar}**: ${up.length} / ${group.length} (${up.map((s) => s.id).join(", ") || "none"})`);
  }
  const disabled = sources.filter((s) => !s.enabled);
  if (disabled.length > 0) lines.push("", `Disabled / unavailable: ${disabled.map((s) => s.id).join(", ")}`);
  return lines.join("\n") + "\n";
}

async function main(): Promise<void> {
  const strict = process.argv.includes("--strict");
  const config = await loadSources();
  const jobs = config.sources.filter((s) => s.enabled).flatMap((s) => s.feeds.map((f) => ({ s, f })));
  const ranAt = new Date().toISOString();
  const results = await mapLimit(jobs, CONCURRENCY, ({ s, f }) => checkFeed(s, f));

  const markdown = toMarkdown(results, config.sources, ranAt);
  process.stdout.write(markdown);
  await mkdir(new URL(".", OUTPUT), { recursive: true });
  await writeFile(OUTPUT, JSON.stringify({ ran_at: ranAt, github_actions: Boolean(process.env.GITHUB_ACTIONS), results }, null, 2));
  if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, markdown);

  if (strict && results.some((r) => !r.ok)) process.exitCode = 1;
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
