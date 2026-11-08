import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { gunzipSync } from "node:zlib";
import { summarisable, summariseStories } from "./ai/summarise.js";
import { loadSources } from "./config/sources.js";
import { applyBlocklist, loadBlocklist } from "./lib/blocklist.js";
import { assignPhotos } from "./images/assign.js";
import { clusterItems } from "./lib/cluster.js";
import { loadFacts } from "./lib/facts.js";
import { fetchAllFeeds, type FeedSnapshot } from "./lib/fetch-feeds.js";
import { normalise } from "./lib/normalise.js";
import { buildStories, frontPage, sectionCards, shownStories } from "./lib/stories.js";
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

  const failed = feeds.filter((f) => !f.ok);
  const items = applyBlocklist(normalise(feeds, sources, now), await loadBlocklist());
  const stories = buildStories(clusterItems(items), now);
  const multi = stories.filter((s) => s.independent >= 2);
  let summaryNote = "summaries off";
  if (process.env.SUMMARIES === "on") {
    const front = frontPage(stories, now);
    // The top stories and each section's first writable stories fill the front page's written slots.
    const slots = [...front.bySection.values()].flatMap((list) => sectionCards(list, front.top, (s) => summarisable(s) !== null));
    const important = new Set([...front.top, ...slots].map((s) => s.id));
    const { writeups, counts: c } = await summariseStories(shownStories(stories), important, resolve(process.env.SUMMARY_STATE ?? ".cache/summaries.json"), now);
    for (const story of stories) story.writeup = writeups.get(story.id);
    const multiWritten = multi.filter((s) => writeups.has(s.id)).length;
    summaryNote = `summaries for ${multiWritten}/${multi.length} multi-source + ${writeups.size - multiWritten} single-outlet (new ${c.written}: free ${c.free}, paid ${c.paid}; kept ${c.kept}; failed checks ${c.failed}; waiting ${c.waiting}; paid A$${c.paidAud.toFixed(3)} this run, A$${c.dayAud.toFixed(2)} today)`;
  }

  // After the summaries, so a sport photo can follow the headline readers see (the summary's, when there is one).
  const { photos, counts } = await assignPhotos(shownStories(stories), resolve(process.env.IMAGE_CACHE ?? ".cache/images.json"), now);
  for (const story of stories) story.photo = photos.get(story.id);

  const out = pathToFileURL(`${resolve(process.env.EDITION_OUT ?? "dist")}/`);
  const files = await generateSite(out, stories, config.sources, now, await loadFacts(now));

  console.log(`Edition ${now.toISOString()}: ${feeds.length - failed.length}/${feeds.length} feeds OK, ${items.length} items, ${stories.length} stories (${multi.length} multi-source), photos for ${photos.size} (event ${counts.event}, object ${counts.object}, broad ${counts.broad}; ${multi.filter((s) => s.photo).length}/${multi.length} multi-source), ${summaryNote}, ${files} files in ${Date.now() - started} ms.`);
  if (failed.length > 0) console.log(`Failed feeds: ${failed.map((f) => `${f.source} (${f.problem})`).join(", ")}`);
  if (multi.length < 10) throw new Error(`Only ${multi.length} multi-source stories; not publishing a thin edition.`);
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
