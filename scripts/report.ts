/**
 * Nightly report (owner, 11 Nov 2026): how the site did over the last 24 hours, emailed to the owner by the scheduler
 * Worker. Run by .github/workflows/report.yml. Reads the editions' own numbers (.cache/history.json), GitHub's record of
 * the Edition runs, and the live front page. Sends counts only: no story text and nothing secret.
 *
 * REPORT_DRY_RUN=1 prints the report instead of sending it.
 */
import { readFile } from "node:fs/promises";
import type { EditionRecord } from "../src/lib/history.js";

const SITE = "https://thesmpnews.com/";
const REPO = "GeoFlashModelling/smp-news";
const DAY_MS = 86_400_000;
/** The scheduler runs an edition every daytime hour (6 am to 11 pm Sydney) plus one overnight: 19 a day. */
const EXPECTED_RUNS = 19;
const RUN_LIMIT_MIN = 30;
const PAID_CAP_AUD = 3.2;

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
const minutes = (ms: number) => `${(ms / 60_000).toFixed(1)} min`;
const pct = (n: number, d: number) => (d ? `${Math.round((100 * n) / d)}%` : "n/a");

async function history(now: Date): Promise<EditionRecord[]> {
  try {
    const list = JSON.parse(await readFile(process.env.HISTORY ?? ".cache/history.json", "utf8")) as EditionRecord[];
    return list.filter((r) => now.getTime() - Date.parse(r.at) <= DAY_MS);
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

async function main(): Promise<void> {
  const now = new Date();
  const [records, runList, front] = await Promise.all([history(now), runs(now), frontPage()]);
  const attention: string[] = [];

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
  const dayAud = Math.max(0, ...withSummaries.map((r) => r.summaries!.dayAud));
  const paidAud = sum(withSummaries, (r) => r.summaries!.paidAud);
  if (dayAud > 0.8 * PAID_CAP_AUD) attention.push(`Paid AI spend reached A$${dayAud.toFixed(2)} of the A$${PAID_CAP_AUD.toFixed(2)} daily cap.`);
  const failedChecks = sum(withSummaries, (r) => r.summaries!.failed);
  const written = sum(withSummaries, (r) => r.summaries!.written);
  if (written >= 10 && failedChecks > written / 4) attention.push(`${failedChecks} summaries failed their checks against ${written} written: look at the "Summary failed checks" lines in the logs.`);

  const lines: string[] = [];
  const add = (heading: string, rows: string[]) => lines.push(heading, ...rows.map((r) => `  - ${r}`), "");
  add("Editions (last 24 hours)", [
    `${finished.length - failedRuns.length} succeeded, ${failedRuns.length} failed, ${runList.length - finished.length} still running (${scheduled.length} from the scheduler, about ${EXPECTED_RUNS} expected)`,
    durations.length ? `Typical run ${minutes(durations.sort((a, b) => a - b)[Math.floor(durations.length / 2)]!)}, slowest ${minutes(longest)} (limit ${RUN_LIMIT_MIN} min)` : "No finished runs",
    ...(last ? [`Slowest stages last run: feeds ${minutes(last.stageMs.feeds)}, summaries ${minutes(last.stageMs.summaries)}, photos ${minutes(last.stageMs.photos)}, site ${minutes(last.stageMs.site)}`] : []),
  ]);
  add("Live site", [
    `Front page: HTTP ${front.status}; edition from ${front.editionAt ? perth(front.editionAt) : "unknown"} AWST`,
    `${front.cards} story cards, ${front.photos} different photos, ${front.artwork} with section artwork, ${front.sharedPhotos.length} photos repeated`,
    `Top stories with a written summary: ${front.topChecked - front.topWithoutSummary} of ${front.topChecked}`,
  ]);
  if (last) {
    add("Latest edition", [
      `${last.feeds.ok}/${last.feeds.total} feeds OK${last.feeds.failed.length ? ` (failing: ${last.feeds.failed.join(", ")})` : ""}`,
      `${last.items} reports grouped into ${last.stories} stories, ${last.multi} covered by several outlets`,
      `Photos for ${last.photos.total} stories: ${last.photos.event} of the subject or place (${pct(last.photos.event, last.photos.total)}), ${last.photos.object} of a key object (${pct(last.photos.object, last.photos.total)}), ${last.photos.broad} topic pictures (${pct(last.photos.broad, last.photos.total)}); ${last.photos.shared} had to share; ${last.photos.elsewhere} refused as the wrong country`,
      ...(last.summaries ? [`Summaries: ${last.summaries.multiWritten}/${last.multi} multi-source stories written, plus ${last.summaries.single} single-outlet`] : []),
    ]);
  }
  add("AI summaries (last 24 hours)", withSummaries.length
    ? [`${written} new (${sum(withSummaries, (r) => r.summaries!.free)} free, ${sum(withSummaries, (r) => r.summaries!.paid)} paid, ${sum(withSummaries, (r) => r.summaries!.fromArticles)} from full articles); ${failedChecks} failed their checks`, `Paid spend: A$${paidAud.toFixed(2)} (today so far A$${dayAud.toFixed(2)} of the A$${PAID_CAP_AUD.toFixed(2)} cap)`]
    : ["No edition numbers recorded yet (the history starts with the 11 Nov 2026 editions)."]);
  add("Not measured", ["Visitor numbers: the site has no analytics or tracking by design."]);

  const verdict = attention.length ? `${attention.length} thing${attention.length === 1 ? "" : "s"} to look at` : "all good";
  const subject = `S.M.P. News nightly report, ${new Date(now).toLocaleDateString("en-AU", { timeZone: "Australia/Perth", weekday: "short", day: "numeric", month: "short" })}: ${verdict}`;
  const text = [
    `S.M.P. News: the last 24 hours to ${perth(now)} AWST.`,
    "",
    ...(attention.length ? ["Needs attention", ...attention.map((a) => `  ! ${a}`), ""] : ["Nothing needs attention.", ""]),
    ...lines,
    `Site: ${SITE}  Runs: https://github.com/${REPO}/actions/workflows/edition.yml`,
  ].join("\n");

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

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
