import { isLegalRisk } from "../ai/legal-risk.js";
import type { Story } from "../lib/stories.js";
import { imageCandidates } from "./entities.js";
import { findPhotos, type Photo } from "./wikimedia.js";

/**
 * Every story gets a picture: a free-licensed photo of its main subject where one exists, otherwise its
 * section artwork (undefined here). Court, crime and similar stories always get artwork: a file photo of a
 * person next to an allegation can wrongly suggest who is accused.
 */
export async function assignPhotos(stories: Story[], cacheFile: string, now: Date): Promise<Map<string, Photo>> {
  const wanted = new Map<string, string[]>();
  for (const story of stories) {
    if (isLegalRisk(story.items)) continue;
    const names = imageCandidates(story.items, story.independent >= 2 ? 3 : 2, story.section !== "sport");
    if (names.length) wanted.set(story.id, names);
  }
  const photos = await findPhotos([...wanted.values()].flat(), cacheFile, now);
  const chosen = new Map<string, Photo>();
  for (const [id, names] of wanted) {
    const photo = names.map((n) => photos.get(n)).find((p) => p);
    if (photo) chosen.set(id, photo);
  }
  return chosen;
}
