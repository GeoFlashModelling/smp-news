import { writeFile } from "node:fs/promises";
import { loadSources, type Source } from "../config/sources.js";
import { USER_AGENT, mapLimit } from "../lib/http.js";
import { isAllowed, parseRobots, type Robots } from "../lib/robots.js";

const AI_AGENTS = ["GPTBot", "ClaudeBot", "CCBot", "Google-Extended", "Applebot-Extended", "PerplexityBot", "Bytespider", "meta-externalagent"];
const NOTICE = /prohibit|express (written )?permission|not permitted|text and data mining|\btdm\b|machine learning|artificial intelligence|\bai\b/i;
/** Publisher statements forbidding any automated collection without permission. */
const COLLECTION_BAN = /(automated means[\s\S]{0,80}?prohibited|scrape the content[\s\S]{0,80}?prohibited|no scraping, crawling)/i;
/** Publisher statements forbidding use of content for AI / machine learning (beyond training-only bans). */
const AI_USE_BAN =
  /(prohibits the use of any[\s\S]{0,120}?(machine learning|artificial intelligence)|other uses are not permitted[\s\S]{0,120}?(language models|machine learning|artificial intelligence)|retrieval-augmented generation|ai grounding)/i;
const OUTPUT = new URL("../../config/terms-review.json", import.meta.url);

interface TermsResult {
  source: string;
  robots_status: number | null;
  feeds_allowed: boolean;
  blocked_feeds: string[];
  ai_agents_blocked: string[];
  /** Value of `Content-Signal: ai-input=` if the site declares one. */
  content_signal_ai_input: "yes" | "no" | null;
  collection_banned: boolean;
  ai_use_banned: boolean;
  notices: string[];
}

const robotsCache = new Map<string, Promise<{ status: number | null; robots: Robots; raw: string }>>();

function robotsFor(origin: string) {
  let entry = robotsCache.get(origin);
  if (!entry) {
    entry = (async () => {
      try {
        const res = await fetch(`${origin}/robots.txt`, { headers: { "user-agent": USER_AGENT }, signal: AbortSignal.timeout(20_000) });
        // RFC 9309: 4xx means no restrictions; 5xx/unreachable means assume full disallow.
        if (res.status >= 400 && res.status < 500) return { status: res.status, robots: parseRobots(""), raw: "" };
        if (!res.ok) return { status: res.status, robots: parseRobots("User-agent: *\nDisallow: /"), raw: "" };
        const raw = await res.text();
        return { status: res.status, robots: parseRobots(raw), raw };
      } catch {
        return { status: null, robots: parseRobots("User-agent: *\nDisallow: /"), raw: "" };
      }
    })();
    robotsCache.set(origin, entry);
  }
  return entry;
}

async function review(source: Source): Promise<TermsResult> {
  const blocked: string[] = [];
  let status: number | null = null;
  for (const feed of source.feeds) {
    const r = await robotsFor(new URL(feed.url).origin);
    status = r.status;
    if (!isAllowed(r.robots, USER_AGENT, feed.url)) blocked.push(feed.url);
  }
  const site = await robotsFor(new URL(source.homepage).origin);
  const statement = site.robots.comments.join(" ").replace(/\s+/g, " ");
  const signal = /Content-Signal:[^\n]*ai-input=(yes|no)/i.exec(site.raw)?.[1]?.toLowerCase();
  return {
    source: source.id,
    robots_status: status ?? site.status,
    feeds_allowed: blocked.length === 0,
    blocked_feeds: blocked,
    ai_agents_blocked: AI_AGENTS.filter((a) => !isAllowed(site.robots, a, `${new URL(source.homepage).origin}/`)),
    content_signal_ai_input: signal === "yes" || signal === "no" ? signal : null,
    collection_banned: COLLECTION_BAN.test(statement),
    ai_use_banned: AI_USE_BAN.test(statement) || signal === "no",
    notices: [...new Set(site.robots.comments.filter((c) => NOTICE.test(c)))].slice(0, 3),
  };
}

async function main(): Promise<void> {
  const config = await loadSources();
  const sources = config.sources.filter((s) => s.enabled);
  const results = await mapLimit(sources, 6, review);
  const reviewedAt = new Date().toISOString();
  await writeFile(OUTPUT, JSON.stringify({ reviewed_at: reviewedAt, user_agent: USER_AGENT, results }, null, 2) + "\n");

  const lines = [
    `## Terms review (robots.txt) — ${reviewedAt}`,
    "",
    "| Source | Verdict | Feeds allowed | Collection ban | AI-use ban | AI crawlers blocked |",
    "|---|---|---|---|---|---|",
    ...results.map((r) => {
      const verdict = !r.feeds_allowed || r.collection_banned ? "❌ exclude" : r.ai_use_banned ? "🟡 headline only, no AI" : "✅ AI input OK";
      return `| ${r.source} | ${verdict} | ${r.feeds_allowed ? "yes" : "**no**"} | ${r.collection_banned ? "yes" : ""} | ${r.ai_use_banned ? "yes" : ""} | ${r.ai_agents_blocked.length}/${AI_AGENTS.length} |`;
    }),
  ];
  console.log(lines.join("\n"));

  const bySource = new Map(sources.map((s) => [s.id, s]));
  const mismatches = results.flatMap((r) => {
    const s = bySource.get(r.source);
    if (!s) return [];
    const out: string[] = [];
    if (!r.feeds_allowed || r.collection_banned) out.push(`${r.source}: should be disabled (robots.txt disallows the feed or bans automated collection)`);
    if (r.ai_use_banned && s.ai_input_allowed) out.push(`${r.source}: ai_input_allowed must be false (publisher bans AI use)`);
    return out;
  });
  if (mismatches.length > 0) {
    console.log(`\nsources.json disagrees with the review:\n  - ${mismatches.join("\n  - ")}`);
    process.exitCode = 1;
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
