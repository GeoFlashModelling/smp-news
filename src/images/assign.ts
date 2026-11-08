import { isLegalRisk } from "../ai/legal-risk.js";
import type { Story } from "../lib/stories.js";
import { ImageCache } from "./cache.js";
import { imageCandidates, placeCandidates } from "./entities.js";
import { photoIdeas, topicFiles, TOPICS } from "./ideas.js";
import { searchPhoto, type SearchBudget } from "./search.js";
import { findFiles, findPhotos, type Photo } from "./wikimedia.js";

const COMMONS_SEARCHES_PER_EDITION = 150;
const OPENVERSE_SEARCHES_PER_EDITION = 15;

export interface PhotoCounts {
  named: number;
  search: number;
  place: number;
  topic: number;
}

/**
 * Every story gets a picture. The first of these that exists, else the section artwork:
 * 1. a free photo of the story's main person, organisation or thing (its Wikipedia lead photo);
 * 2. a photo found by searching Wikimedia Commons, then Openverse, for the place or object at the centre of the story;
 * 3. the Wikipedia photo of a place named in the reports;
 * 4. a hand-picked photo for the story's broad topic (police, court, rugby…).
 * Court and crime stories skip step 1: a file photo of a person next to an allegation can wrongly suggest who is accused.
 */
export async function assignPhotos(shown: Story[], cacheFile: string, now: Date): Promise<{ photos: Map<string, Photo>; counts: PhotoCounts }> {
  // Multi-source stories first, then by rank: they get the AI requests and search budget before single headlines.
  const stories = [...shown.filter((s) => s.independent >= 2), ...shown.filter((s) => s.independent < 2)];
  const cache = await ImageCache.open(cacheFile, now);
  const legal = new Set(stories.filter((s) => isLegalRisk(s.items)).map((s) => s.id));
  const ideas = await photoIdeas(stories, legal, cache);

  const subjectsOf = new Map<string, string[]>();
  const placesOf = new Map<string, string[]>();
  for (const story of stories) {
    if (!legal.has(story.id)) subjectsOf.set(story.id, imageCandidates(story.items, story.independent >= 2 ? 3 : 2, story.section !== "sport", story.headline.title));
    placesOf.set(story.id, placeCandidates(story.items, story.headline.title));
  }
  const named = await findPhotos([...ideas.values()].map((i) => i.subject).filter(Boolean), "named", cache);
  const subjects = await findPhotos([...subjectsOf.values()].flat(), "subject", cache);
  const places = await findPhotos([...placesOf.values()].flat(), "place", cache);
  const library = await findFiles(new Map(TOPICS.map((t) => [t.file, t.caption])), cache);

  const photos = new Map<string, Photo>();
  const counts: PhotoCounts = { named: 0, search: 0, place: 0, topic: 0 };
  const budget: SearchBudget = { commons: COMMONS_SEARCHES_PER_EDITION, openverse: OPENVERSE_SEARCHES_PER_EDITION };
  const firstSearch = async (queries: string[]) => {
    for (const q of queries) {
      const photo = await searchPhoto(q, cache, budget);
      if (photo) return photo;
    }
    return null;
  };

  const pick = async (story: Story): Promise<void> => {
    const idea = ideas.get(story.id);
    let photo = (idea?.subject && !legal.has(story.id) ? named.get(idea.subject) : null) ?? (subjectsOf.get(story.id) ?? []).map((n) => subjects.get(n)).find((p) => p);
    let tier: keyof PhotoCounts = "named";
    if (!photo) [photo, tier] = [await firstSearch(idea?.searches ?? []), "search"];
    if (!photo) [photo, tier] = [(placesOf.get(story.id) ?? []).map((n) => places.get(n)).find((p) => p) ?? null, "place"];
    if (!photo) [photo, tier] = [topicFiles(story).map((f) => library.get(f)).find((p) => p) ?? null, "topic"];
    if (photo) {
      photos.set(story.id, photo);
      counts[tier]++;
    }
  };
  for (const story of stories) await pick(story);

  await cache.save();
  return { photos, counts };
}
