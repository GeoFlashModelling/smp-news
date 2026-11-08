import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { gunzipSync } from "node:zlib";
import { loadSources } from "./config/sources.js";
import { applyBlocklist, loadBlocklist } from "./lib/blocklist.js";
import { assignPhotos } from "./images/assign.js";
import { clusterItems } from "./lib/cluster.js";
import { fetchAllFeeds, type FeedSnapshot } from "./lib/fetch-feeds.js";
import { normalise } from "./lib/normalise.js";
import { buildStories, shownStories } from "./lib/stories.js";
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
  const { photos, counts } = await assignPhotos(shownStories(stories), resolve(process.env.IMAGE_CACHE ?? ".cache/images.json"), now);
  for (const story of stories) story.photo = photos.get(story.id);

  const out = pathToFileURL(`${resolve(process.env.EDITION_OUT ?? "dist")}/`);
  const files = await generateSite(out, stories, config.sources, now);

  console.log(`Edition ${now.toISOString()}: ${feeds.length - failed.length}/${feeds.length} feeds OK, ${items.length} items, ${stories.length} stories (${multi.length} multi-source), photos for ${photos.size} (subject ${counts.named}, search ${counts.search}, place ${counts.place}, topic ${counts.topic}; ${multi.filter((s) => s.photo).length}/${multi.length} multi-source), ${files} files in ${Date.now() - started} ms.`);
  if (failed.length > 0) console.log(`Failed feeds: ${failed.map((f) => `${f.source} (${f.problem})`).join(", ")}`);
  if (multi.length < 10) throw new Error(`Only ${multi.length} multi-source stories; not publishing a thin edition.`);
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
