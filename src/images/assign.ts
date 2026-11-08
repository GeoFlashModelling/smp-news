import { isLegalRisk } from "../ai/legal-risk.js";
import type { Story } from "../lib/stories.js";
import { ImageCache } from "./cache.js";
import { imageCandidates, placeCandidates } from "./entities.js";
import { homeGround, venueMentioned } from "./grounds.js";
import { photoIdeas, topicFiles, TOPICS } from "./ideas.js";
import { searchPhoto, type SearchBudget } from "./search.js";
import { findFiles, findPhotos, type Photo } from "./wikimedia.js";

const COMMONS_SEARCHES_PER_EDITION = 300;
const OPENVERSE_SEARCHES_PER_EDITION = 15;

export interface PhotoCounts {
  event: number;
  object: number;
  broad: number;
}

/**
 * Every story gets a picture, most specific first. Photos of the news event itself are nearly always copyright, so:
 * 1. event: a free photo of who or where the story is about. The main person, organisation or product (its Wikipedia
 *    lead photo), then where it happened: the venue, building or landmark the reports name, then a town or suburb they
 *    name. Sport puts the ground first, since free photos of teams tend to be years old; when the reports don't name
 *    the ground, an Australian club's home ground stands in (grounds.ts). Court and crime stories skip the person:
 *    a file photo next to an allegation can wrongly suggest who is accused;
 * 2. object: a photo found by searching Wikimedia Commons, then Openverse, for the key object or setting the reports
 *    discuss ("Hawaiian pizza", "open pit gold mine");
 * 3. broad: a common thing that stands for the topic ("wild cat", "Wi-Fi router"), searched the same way, else a
 *    hand-picked photo for the topic (police, court, rugby…);
 * 4. otherwise the section artwork.
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
  const venueOf = new Map<string, string>();
  for (const story of stories) {
    const suggested = ideas.get(story.id)?.venue || null;
    const stated = suggested && venueMentioned(suggested, story) ? suggested : null;
    // A venue the reports name beats a club's home ground, which beats the model's guess. Outside sport a guessed
    // place could be the wrong one, so only a named place counts.
    const venue = story.section === "sport" ? (stated ?? homeGround(story) ?? suggested) : stated;
    if (venue) venueOf.set(story.id, venue);
  }
  const venues = await findPhotos([...venueOf.values()], "place", cache);
  const library = await findFiles(new Map(TOPICS.map((t) => [t.file, t.caption])), cache);

  const photos = new Map<string, Photo>();
  const counts: PhotoCounts = { event: 0, object: 0, broad: 0 };
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
    const venue = venues.get(venueOf.get(story.id) ?? "") ?? null;
    const subject = (idea?.subject && !legal.has(story.id) ? named.get(idea.subject) : null) ?? (subjectsOf.get(story.id) ?? []).map((n) => subjects.get(n)).find((p) => p);
    const place = (placesOf.get(story.id) ?? []).map((n) => places.get(n)).find((p) => p) ?? null;
    let photo = (story.section === "sport" ? (venue ?? subject) : (subject ?? venue)) ?? place;
    let tier: keyof PhotoCounts = "event";
    if (!photo) [photo, tier] = [await firstSearch(idea?.searches ?? []), "object"];
    if (!photo) [photo, tier] = [(idea?.theme ? await firstSearch([idea.theme]) : null) ?? topicFiles(story).map((f) => library.get(f)).find((p) => p) ?? null, "broad"];
    if (photo) {
      photos.set(story.id, photo);
      counts[tier]++;
    } else if (story.independent >= 2) {
      console.log(`No photo: ${story.id} "${story.headline.title}" (idea ${JSON.stringify(idea ?? null)}; places ${JSON.stringify(placesOf.get(story.id) ?? [])})`);
      // Forget the model's suggestions once, so the next edition asks again (headlines may have changed since).
      const retried = `idea-retried:${story.id}`;
      if (idea && !cache.has(retried)) {
        cache.delete(`idea:${story.id}`);
        cache.set(retried, true);
      }
    }
  };
  for (const story of stories) await pick(story);

  await cache.save();
  return { photos, counts };
}
