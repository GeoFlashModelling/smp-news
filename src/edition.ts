import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { gunzipSync } from "node:zlib";
import { geminiUsage } from "./ai/gemini.js";
import { summarisable, summariseStories } from "./ai/summarise.js";
import { isLocal, loadSources } from "./config/sources.js";
import { applyBlocklist, loadBlocklist } from "./lib/blocklist.js";
import { assignPhotos } from "./images/assign.js";
import { groupReports } from "./lib/embed-merge.js";
import { loadFacts } from "./lib/facts.js";
import { keepStoryIds } from "./lib/identity.js";
import { recordEdition, type EditionRecord } from "./lib/history.js";
import { fetchAllFeeds, type FeedSnapshot } from "./lib/fetch-feeds.js";
import { normalise } from "./lib/normalise.js";
import { loadQuiz } from "./lib/quiz.js";
import { loadWeather } from "./lib/weather.js";
import { buildStories, frontPage, sectionCards, shownStories, type Story } from "./lib/stories.js";
import { generateSite } from "./site/generate.js";

/**
 * One edition: fetch every feed, group reports into stories, write the static site to dist/.
 * EDITION_SNAPSHOT=path/to/snapshot.json.gz builds from a saved snapshot instead of fetching (offline testing).
 */
async function main(): Promise<void> {
  const started = Date.now();
  const config = await loadSources();
  const sources = new Map(config.sources.map((s) => [s.id, s]));

  let feeds: FeedSnapshot[];
  let now: Date;
  const snapshotPath = process.env.EDITION_SNAPSHOT;
  if (snapshotPath) {
    const snapshot = JSON.parse(gunzipSync(await readFile(snapshotPath)).toString("utf8")) as { taken_at: string; feeds: FeedSnapshot[] };
    feeds = snapshot.feeds;
    now = new Date(snapshot.taken_at);
  } else {
    now = new Date();
    feeds = await fetchAllFeeds(config.sources);
  }

  const fedAt = Date.now();
  const failed = feeds.filter((f) => !f.ok);
  const items = applyBlocklist(normalise(feeds, sources, now), await loadBlocklist());
  const grouped = await groupReports(items);
  const stories = buildStories(grouped.clusters, now);
  await keepStoryIds(stories, resolve(process.env.STORY_IDS ?? ".cache/stories.json"), now);
  const multi = stories.filter((s) => s.independent >= 2);
  let summaryNote = "summaries off";
  let summaries: EditionRecord["summaries"];
  const front = frontPage(stories, now, (s) => process.env.SUMMARIES !== "on" || summarisable(s) !== null);
  if (process.env.SUMMARIES === "on") {
    // The top stories and each section's first writable stories fill the front page's written slots. The other
    // states' local blocks only show what is written anyway: no extra single-outlet or paid writing for them.
    const slots = [...front.bySection]
      .filter(([sec]) => !isLocal(sec) || sec === "local-wa")
      .flatMap(([, list]) => sectionCards(list, front.top, (s) => summarisable(s) !== null));
    const important = new Set([...front.top, ...slots].map((s) => s.id));
    const { writeups, counts: c } = await summariseStories(shownStories(stories), important, resolve(process.env.SUMMARY_STATE ?? ".cache/summaries.json"), now);
    for (const story of stories) story.writeup = writeups.get(story.id);
    const multiWritten = multi.filter((s) => writeups.has(s.id)).length;
    summaryNote = `summaries for ${multiWritten}/${multi.length} multi-source + ${writeups.size - multiWritten} single-outlet (new ${c.written}: free ${c.free}, paid ${c.paid}, from full articles ${c.fromArticles}; kept ${c.kept}; failed checks ${c.failed}; waiting ${c.waiting}${c.waiting ? `, longest ${c.oldestWaitHours.toFixed(1)} h` : ""}; paid A$${c.paidAud.toFixed(3)} this run, A$${c.dayAud.toFixed(2)} today)`;
    summaries = { multiWritten, single: writeups.size - multiWritten, written: c.written, free: c.free, paid: c.paid, fromArticles: c.fromArticles, failed: c.failed, paidAud: c.paidAud, dayAud: c.dayAud, waiting: c.waiting, oldestWaitHours: c.oldestWaitHours };
  }
  const summarisedAt = Date.now();

  // After the summaries, so a sport photo can follow the headline readers see (the summary's, when there is one).
  const writable = (s: Story) => process.env.SUMMARIES !== "on" || summarisable(s) !== null;
  const onFront = [...front.top, ...front.alsoLeading, ...front.interesting, ...[...front.bySection.values()].flatMap((list) => sectionCards(list, front.top, writable))];
  const { photos, counts } = await assignPhotos(shownStories(stories), resolve(process.env.IMAGE_CACHE ?? ".cache/images.json"), now, onFront);
  for (const story of stories) story.photo = photos.get(story.id);
  const photosAt = Date.now();

  const out = pathToFileURL(`${resolve(process.env.EDITION_OUT ?? "dist")}/`);
  const [facts, weather, quiz] = await Promise.all([loadFacts(now), loadWeather(), loadQuiz(resolve(process.env.QUIZ_STATE ?? ".cache/quiz.json"), now)]);
  const files = await generateSite(out, stories, front, config.sources, now, { facts, weather, quiz });

  console.log(`Edition ${now.toISOString()}: ${feeds.length - failed.length}/${feeds.length} feeds OK, ${items.length} items, ${stories.length} stories (${multi.length} multi-source), ${grouped.note}, photos for ${photos.size} (event ${counts.event}, object ${counts.object}, broad ${counts.broad}, shared ${counts.shared}, refused as elsewhere ${counts.elsewhere}, off the point ${counts.offPoint}; ${multi.filter((s) => s.photo).length}/${multi.length} multi-source), ${summaryNote}, ${files} files in ${Date.now() - started} ms.`);
  const done = Date.now();
  await recordEdition(resolve(process.env.HISTORY ?? ".cache/history.json"), {
    at: now.toISOString(),
    ms: done - started,
    stageMs: { feeds: fedAt - started, summaries: summarisedAt - fedAt, photos: photosAt - summarisedAt, site: done - photosAt },
    feeds: { ok: feeds.length - failed.length, total: feeds.length, failed: failed.map((f) => `${f.source} (${f.problem})`) },
    items: items.length,
    stories: stories.length,
    multi: multi.length,
    photos: { total: photos.size, ...counts, multiWithPhoto: multi.filter((s) => s.photo).length },
    summaries,
    ai: geminiUsage,
    files,
  });
  if (failed.length > 0) console.log(`Failed feeds: ${failed.map((f) => `${f.source} (${f.problem})`).join(", ")}`);
  if (multi.length < 10) throw new Error(`Only ${multi.length} multi-source stories; not publishing a thin edition.`);
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
