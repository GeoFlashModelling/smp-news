/**
 * Emails to the owner, sent through the scheduler Worker (owner, 11 Nov 2026):
 * - REPORT_KIND=edition: after each hourly update (edition.yml), how that run went and how today's AI costs stand;
 * - otherwise the nightly report (report.yml): the last 24 hours, the live site, and the same cost tracking.
 * The aim on costs is to stay on Google's free allowance; the paid key is a capped backstop.
 * Reads the editions' own numbers (.cache/history.json), GitHub's record of the Edition runs, and the live front page.
 * Sends counts only: no story text and nothing secret.
 *
 * REPORT_DRY_RUN=1 prints the email instead of sending it.
 */
import { readFile } from "node:fs/promises";
import { AUD_PER_USD, DAILY_PAID_LIMIT_AUD, PAID_PRICES } from "../src/ai/summarise.js";
import type { EditionRecord } from "../src/lib/history.js";

const SITE = "https://thesmpnews.com/";
const REPO = "GeoFlashModelling/smp-news";
const DAY_MS = 86_400_000;
/** The scheduler runs an edition every daytime hour (6 am to 11 pm Sydney) plus one overnight: 19 a day. */
const EXPECTED_RUNS = 19;
const RUN_LIMIT_MIN = 30;
/** Google's free requests a day per model, as published for the free tier. */
const FREE_PER_DAY = (model: string) => (model.includes("flash-lite") ? 500 : model.includes("flash") ? 20 : 0);
/** For paid requests on a model missing from the price table: the dearest Flash-Lite price, to err high. */
const FALLBACK_PRICE: [number, number] = [0.3, 2.5];

interface Run {
  status: string;
  conclusion: string | null;
  event: string;
  run_started_at: string;
  updated_at: string;
  html_url: string;
}

const perth = (d: Date | string) =>
  new Date(d).toLocaleString("en-AU", { timeZone: "Australia/Perth", weekday: "short", day: "numeric", month: "short", hour: "numeric", minute: "2-digit" });
const perthTime = (d: Date | string) => new Date(d).toLocaleTimeString("en-AU", { timeZone: "Australia/Perth", hour: "numeric", minute: "2-digit" });
const dayIn = (timeZone: string, d: Date | string) => new Date(d).toLocaleDateString("en-CA", { timeZone });
const minutes = (ms: number) => `${(ms / 60_000).toFixed(1)} min`;
const pct = (n: number, d: number) => (d ? `${Math.round((100 * n) / d)}%` : "n/a");
const aud = (n: number) => `A$${n.toFixed(2)}`;

async function history(): Promise<EditionRecord[]> {
  try {
    return JSON.parse(await readFile(process.env.HISTORY ?? ".cache/history.json", "utf8")) as EditionRecord[];
  } catch {
    return [];
  }
}

async function runs(now: Date): Promise<Run[]> {
  const since = new Date(now.getTime() - DAY_MS).toISOString();
  const res = await fetch(`https://api.github.com/repos/${REPO}/actions/workflows/edition.yml/runs?per_page=100&created=>=${since}`, {
    headers: { authorization: `Bearer ${process.env.GITHUB_TOKEN}`, accept: "application/vnd.github+json", "user-agent": "smp-news-report" },
  });
  if (!res.ok) throw new Error(`GitHub runs ${res.status}`);
  return ((await res.json()) as { workflow_runs: Run[] }).workflow_runs;
}

interface FrontCheck {
  ok: boolean;
  status: number;
  editionAt: string | null;
  cards: number;
  photos: number;
  sharedPhotos: string[];
  artwork: number;
  topWithoutSummary: number;
  topChecked: number;
}

async function frontPage(): Promise<FrontCheck> {
  const res = await fetch(SITE, { headers: { "user-agent": "smp-news-report" } });
  const html = await res.text();
  const cards = [...html.matchAll(/<article class="card[\s\S]*?<\/article>/g)].map((m) => m[0]);
  const storyOf = new Map<string, Set<string>>();
  let artwork = 0;
  for (const card of cards) {
    const img = card.match(/<img[^>]*class="pic-img[^"]*"[^>]*src="([^"]+)"/)?.[1] ?? card.match(/<img[^>]+src="([^"]+)"/)?.[1] ?? "";
    const story = card.match(/href="(story\/[^"]+)"/)?.[1] ?? "";
    if (img.includes("assets/sections/")) artwork++;
    else if (img) {
      const file = img.split("?")[0]!;
      storyOf.set(file, (storyOf.get(file) ?? new Set()).add(story));
    }
  }
  const sharedPhotos = [...storyOf].filter(([, s]) => s.size > 1).map(([f, s]) => `${decodeURIComponent(f.split("/").pop()!)} (${s.size} stories)`);
  // The top stories' own pages: each should carry a written summary.
  const top = cards.slice(0, 10).map((c) => c.match(/href="(story\/[^"]+)"/)?.[1]).filter((h): h is string => Boolean(h));
  let topWithoutSummary = 0;
  for (const href of top) {
    const page = await (await fetch(SITE + href, { headers: { "user-agent": "smp-news-report" } })).text();
    if (!page.includes('class="writeup"')) topWithoutSummary++;
  }
  const editionAt = html.match(/Edition updated <time datetime="([^"]+)"/)?.[1] ?? null;
  return { ok: res.ok, status: res.status, editionAt, cards: cards.length, photos: storyOf.size, sharedPhotos, artwork, topWithoutSummary, topChecked: top.length };
}

function sum<T>(list: T[], f: (t: T) => number): number {
  return list.reduce((n, t) => n + f(t), 0);
}

/** What an edition paid Google: every paid request priced from its tokens; older records only know the summaries' spend. */
function paidAud(r: EditionRecord): number {
  if (!r.ai) return r.summaries?.paidAud ?? 0;
  return sum(Object.entries(r.ai), ([model, u]) => {
    const [input, output] = PAID_PRICES[model] ?? FALLBACK_PRICE;
    const [inTokens, outTokens] = u.paidTokens ?? [0, 0];
    return ((inTokens * input + outTokens * output) / 1_000_000) * AUD_PER_USD;
  });
}

/**
 * One Perth day's paid spend. Overlapping runs can lose each other's history records, so the summaries' own running
 * total for the day (kept with the daily cap) is used when it is higher than the records add up to.
 */
function dayAud(records: EditionRecord[]): number {
  return Math.max(sum(records, paidAud), ...records.map((r) => r.summaries?.dayAud ?? 0));
}

const paidRequests = (r: EditionRecord) => sum(Object.values(r.ai ?? {}), (u) => u.paid);

/** How the day's AI use stands against the free allowance and the paid cap. */
function costs(all: EditionRecord[], now: Date): { lines: string[]; attention: string[]; headline: string } {
  const attention: string[] = [];
  const today = all.filter((r) => dayIn("Australia/Perth", r.at) === dayIn("Australia/Perth", now));
  const month = all.filter((r) => dayIn("Australia/Perth", r.at).slice(0, 7) === dayIn("Australia/Perth", now).slice(0, 7));
  // Google's free allowance resets at midnight Pacific time (3 or 4 pm in Perth).
  const sinceReset = all.filter((r) => dayIn("America/Los_Angeles", r.at) === dayIn("America/Los_Angeles", now));
  const todayAud = dayAud(today);
  const monthAud = sum([...new Set(month.map((r) => dayIn("Australia/Perth", r.at)))], (day) =>
    dayAud(month.filter((r) => dayIn("Australia/Perth", r.at) === day)),
  );
  const firstDay = month[0] ? dayIn("Australia/Perth", month[0].at) : null;
  const daysSoFar = firstDay ? Math.max(1, Math.round((Date.parse(dayIn("Australia/Perth", now)) - Date.parse(firstDay)) / DAY_MS) + 1) : 1;
  const [year, mon] = dayIn("Australia/Perth", now).split("-").map(Number) as [number, number];
  const daysInMonth = new Date(year, mon, 0).getDate();

  const models = new Map<string, { free: number; paid: number; usedUpAt?: string }>();
  for (const r of sinceReset)
    for (const [model, u] of Object.entries(r.ai ?? {})) {
      const m = models.get(model) ?? { free: 0, paid: 0 };
      m.free += u.free;
      m.paid += u.paid;
      if (u.freeUsedUp && !m.usedUpAt) m.usedUpAt = perthTime(r.at);
      models.set(model, m);
    }
  const firstPaid = today.find((r) => paidRequests(r) > 0 || (r.summaries?.paid ?? 0) > 0);
  const summariesFree = sum(today, (r) => r.summaries?.free ?? 0);
  const summariesPaid = sum(today, (r) => r.summaries?.paid ?? 0);

  const headline = todayAud > 0 ? `${aud(todayAud)} paid today` : "free only today";
  const lines = [
    todayAud > 0
      ? `Paid AI today: ${aud(todayAud)} of the ${aud(DAILY_PAID_LIMIT_AUD)} daily cap (${pct(todayAud, DAILY_PAID_LIMIT_AUD)}); the free allowance first ran short at ${firstPaid ? perthTime(firstPaid.at) : "?"} AWST`
      : "Paid AI today: A$0.00. Everything so far has run on Google's free allowance.",
    `Month to date: ${aud(monthAud)}${firstDay ? ` over ${daysSoFar} day${daysSoFar === 1 ? "" : "s"} recorded` : ""}; at this rate about ${aud((monthAud / daysSoFar) * daysInMonth)} for the month (Google's own cap: A$100)`,
    `Summaries written today: ${summariesFree} free, ${summariesPaid} paid (${pct(summariesFree, summariesFree + summariesPaid)} free)`,
  ];
  if (models.size) {
    lines.push(`Free requests since Google's daily reset (${perthTime(nextReset(now, -1))} AWST):`);
    for (const [model, m] of [...models].sort((a, b) => b[1].free - a[1].free)) {
      const limit = FREE_PER_DAY(model);
      lines.push(`${model}: ${m.free}${limit ? ` of ${limit}` : ""} free${m.paid ? `, ${m.paid} paid` : ""}${m.usedUpAt ? ` (free share used up at ${m.usedUpAt})` : ""}`);
    }
  } else lines.push("Free requests per model: recorded from the 11 Nov 2026 editions onwards.");
  if (todayAud > 0.8 * DAILY_PAID_LIMIT_AUD) attention.push(`Paid AI spend reached ${aud(todayAud)} of the ${aud(DAILY_PAID_LIMIT_AUD)} daily cap.`);
  return { lines, attention, headline };
}

/** Midnight Pacific time nearest to `now`: the last one (direction -1) or the next. */
function nextReset(now: Date, direction: 1 | -1): Date {
  const t = new Date(now);
  for (let i = 0; i < 25 * 60; i++) {
    const hm = t.toLocaleTimeString("en-GB", { timeZone: "America/Los_Angeles", hour: "2-digit", minute: "2-digit", hour12: false });
    if (hm === "00:00") return t;
    t.setTime(t.getTime() + direction * 60_000);
  }
  return t;
}

async function send(subject: string, text: string): Promise<void> {
  if (process.env.REPORT_DRY_RUN) {
    console.log(`${subject}\n\n${text}`);
    return;
  }
  const res = await fetch(process.env.REPORT_URL!, {
    method: "POST",
    headers: { authorization: `Bearer ${process.env.REPORT_TOKEN}`, "content-type": "application/json" },
    body: JSON.stringify({ subject, text }),
  });
  if (!res.ok) throw new Error(`Sending the report failed: ${res.status} ${await res.text()}`);
  console.log(`Sent: ${subject}`);
}

const section = (heading: string, rows: string[]) => [heading, ...rows.map((r) => `  - ${r}`), ""];

/** After each hourly update: how this run went, and today's costs. */
async function editionEmail(all: EditionRecord[], now: Date): Promise<void> {
  const outcome = process.env.EDITION_OUTCOME ?? "success";
  const runUrl = process.env.RUN_URL ?? `https://github.com/${REPO}/actions/workflows/edition.yml`;
  const last = all.at(-1);
  // This run's record, if it got far enough to write one (the email step follows the build within the 30-minute limit).
  const fresh = last && now.getTime() - Date.parse(last.at) <= (RUN_LIMIT_MIN + 5) * 60_000 ? last : undefined;
  const cost = costs(all, now);
  const attention = [...cost.attention];
  if (outcome !== "success") attention.push(`This update ${outcome === "cancelled" ? "was cancelled" : "failed"}; the previous edition stays on the site. Log: ${runUrl}`);
  if (fresh) {
    if (fresh.multi > 0 && fresh.photos.multiWithPhoto < fresh.multi) attention.push(`${fresh.multi - fresh.photos.multiWithPhoto} multi-source stories have no photo.`);
    if (fresh.feeds.failed.length > 5) attention.push(`${fresh.feeds.failed.length} feeds failed.`);
    if (fresh.ms > 20 * 60_000) attention.push(`The update took ${minutes(fresh.ms)}; GitHub stops a run at ${RUN_LIMIT_MIN} min.`);
  }

  const lines: string[] = [];
  if (fresh) {
    const s = fresh.summaries;
    lines.push(
      ...section("This update", [
        `Finished ${perth(fresh.at)} AWST in ${minutes(fresh.ms)} (feeds ${minutes(fresh.stageMs.feeds)}, summaries ${minutes(fresh.stageMs.summaries)}, photos ${minutes(fresh.stageMs.photos)}, pages ${minutes(fresh.stageMs.site)})`,
        `${fresh.feeds.ok}/${fresh.feeds.total} feeds OK${fresh.feeds.failed.length ? ` (failing: ${fresh.feeds.failed.join(", ")})` : ""}`,
        `${fresh.items} reports grouped into ${fresh.stories} stories; ${fresh.multi} covered by several outlets`,
        ...(s ? [`Summaries: ${s.multiWritten}/${fresh.multi} multi-source stories written, plus ${s.single} single-outlet; ${s.written} new this update (${s.free} free, ${s.paid} paid${s.fromArticles ? `, ${s.fromArticles} from full articles` : ""}), ${s.failed} failed their checks`] : []),
        `Photos: ${fresh.photos.multiWithPhoto}/${fresh.multi} multi-source stories; ${fresh.photos.event} of the subject or place, ${fresh.photos.object} of a key object, ${fresh.photos.broad} topic pictures; ${fresh.photos.shared} shared`,
        `Paid AI this update: ${aud(paidAud(fresh))}`,
      ]),
    );
  } else lines.push(...section("This update", [`No numbers were recorded (${outcome}). Log: ${runUrl}`]));
  lines.push(...section("AI costs (aim: stay on the free allowance)", cost.lines));

  const when = perthTime(fresh?.at ?? now);
  const verdict = outcome !== "success" ? "FAILED" : attention.length ? `${attention.length} to look at` : "OK";
  const subject = `S.M.P. News update ${when}: ${verdict}${fresh ? `, ${fresh.multi} stories` : ""}, ${cost.headline}`;
  const text = [
    ...(attention.length ? ["Needs attention", ...attention.map((a) => `  ! ${a}`), ""] : []),
    ...lines,
    `Site: ${SITE}  This run: ${runUrl}`,
  ].join("\n");
  await send(subject, text);
}

/** Every evening: the last 24 hours. */
async function nightlyEmail(all: EditionRecord[], now: Date): Promise<void> {
  const records = all.filter((r) => now.getTime() - Date.parse(r.at) <= DAY_MS);
  const [runList, front] = await Promise.all([runs(now), frontPage()]);
  const cost = costs(all, now);
  const attention: string[] = [...cost.attention];

  // Editions
  const finished = runList.filter((r) => r.status === "completed");
  const failedRuns = finished.filter((r) => r.conclusion !== "success" && r.conclusion !== "cancelled" && r.conclusion !== "skipped");
  const scheduled = runList.filter((r) => r.event === "workflow_dispatch" || r.event === "schedule");
  const durations = finished.filter((r) => r.conclusion === "success").map((r) => Date.parse(r.updated_at) - Date.parse(r.run_started_at));
  const longest = Math.max(0, ...durations);
  if (failedRuns.length) attention.push(`${failedRuns.length} edition run(s) failed: ${failedRuns.map((r) => r.html_url).join(" ")}`);
  if (scheduled.length < EXPECTED_RUNS - 3) attention.push(`Only ${scheduled.length} scheduled editions ran (about ${EXPECTED_RUNS} expected): check the Cloudflare scheduler.`);
  if (longest > 20 * 60_000) attention.push(`The slowest edition took ${minutes(longest)}; GitHub stops a run at ${RUN_LIMIT_MIN} min.`);

  // Live site
  const ageMin = front.editionAt ? (now.getTime() - Date.parse(front.editionAt)) / 60_000 : Infinity;
  if (!front.ok) attention.push(`The front page answered HTTP ${front.status}.`);
  if (ageMin > 120) attention.push(`The live edition is ${Number.isFinite(ageMin) ? `${Math.round(ageMin)} minutes` : "of unknown"} old.`);
  if (front.sharedPhotos.length) attention.push(`Photos shown on more than one front-page story: ${front.sharedPhotos.join("; ")}.`);
  if (front.artwork) attention.push(`${front.artwork} front-page card(s) show section artwork instead of a photo.`);
  if (front.topWithoutSummary) attention.push(`${front.topWithoutSummary} of the top ${front.topChecked} stories have no written summary.`);

  // Feeds, photos and summaries, from the editions' own numbers
  const last = records.at(-1);
  const failedEverywhere = last ? last.feeds.failed.filter((f) => records.every((r) => r.feeds.failed.some((g) => g.split(" ")[0] === f.split(" ")[0]))) : [];
  if (records.length >= 3 && failedEverywhere.length) attention.push(`Feeds failing in every edition today: ${failedEverywhere.join(", ")}.`);
  const withSummaries = records.filter((r) => r.summaries);
  const failedChecks = sum(withSummaries, (r) => r.summaries!.failed);
  const written = sum(withSummaries, (r) => r.summaries!.written);
  if (written >= 10 && failedChecks > written / 4) attention.push(`${failedChecks} summaries failed their checks against ${written} written: look at the "Summary failed checks" lines in the logs.`);

  const lines: string[] = [];
  lines.push(
    ...section("Editions (last 24 hours)", [
      `${finished.length - failedRuns.length} succeeded, ${failedRuns.length} failed, ${runList.length - finished.length} still running (${scheduled.length} from the scheduler, about ${EXPECTED_RUNS} expected)`,
      durations.length ? `Typical run ${minutes(durations.sort((a, b) => a - b)[Math.floor(durations.length / 2)]!)}, slowest ${minutes(longest)} (limit ${RUN_LIMIT_MIN} min)` : "No finished runs",
      ...(last ? [`Stages last run: feeds ${minutes(last.stageMs.feeds)}, summaries ${minutes(last.stageMs.summaries)}, photos ${minutes(last.stageMs.photos)}, site ${minutes(last.stageMs.site)}`] : []),
    ]),
    ...section("Live site", [
      `Front page: HTTP ${front.status}; edition from ${front.editionAt ? perth(front.editionAt) : "unknown"} AWST`,
      `${front.cards} story cards, ${front.photos} different photos, ${front.artwork} with section artwork, ${front.sharedPhotos.length} photos repeated`,
      `Top stories with a written summary: ${front.topChecked - front.topWithoutSummary} of ${front.topChecked}`,
    ]),
  );
  if (last)
    lines.push(
      ...section("Latest edition", [
        `${last.feeds.ok}/${last.feeds.total} feeds OK${last.feeds.failed.length ? ` (failing: ${last.feeds.failed.join(", ")})` : ""}`,
        `${last.items} reports grouped into ${last.stories} stories, ${last.multi} covered by several outlets`,
        `Photos for ${last.photos.total} stories: ${last.photos.event} of the subject or place (${pct(last.photos.event, last.photos.total)}), ${last.photos.object} of a key object (${pct(last.photos.object, last.photos.total)}), ${last.photos.broad} topic pictures (${pct(last.photos.broad, last.photos.total)}); ${last.photos.shared} had to share; ${last.photos.elsewhere} refused as the wrong place`,
        ...(last.summaries ? [`Summaries: ${last.summaries.multiWritten}/${last.multi} multi-source stories written, plus ${last.summaries.single} single-outlet`] : []),
      ]),
    );
  lines.push(
    ...section("AI summaries (last 24 hours)", withSummaries.length ? [`${written} new (${sum(withSummaries, (r) => r.summaries!.free)} free, ${sum(withSummaries, (r) => r.summaries!.paid)} paid, ${sum(withSummaries, (r) => r.summaries!.fromArticles)} from full articles); ${failedChecks} failed their checks`] : ["No edition numbers recorded yet."]),
    ...section("AI costs (aim: stay on the free allowance)", cost.lines),
    ...section("Not measured", ["Visitor numbers: the site has no analytics or tracking by design."]),
  );

  const verdict = attention.length ? `${attention.length} thing${attention.length === 1 ? "" : "s"} to look at` : "all good";
  const subject = `S.M.P. News nightly report, ${now.toLocaleDateString("en-AU", { timeZone: "Australia/Perth", weekday: "short", day: "numeric", month: "short" })}: ${verdict}`;
  const text = [
    `S.M.P. News: the last 24 hours to ${perth(now)} AWST.`,
    "",
    ...(attention.length ? ["Needs attention", ...attention.map((a) => `  ! ${a}`), ""] : ["Nothing needs attention.", ""]),
    ...lines,
    `Site: ${SITE}  Runs: https://github.com/${REPO}/actions/workflows/edition.yml`,
  ].join("\n");
  await send(subject, text);
}

async function main(): Promise<void> {
  const now = new Date();
  const all = await history();
  if (process.env.REPORT_KIND === "edition") await editionEmail(all, now);
  else await nightlyEmail(all, now);
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
