import { isLegalRisk } from "../ai/legal-risk.js";
import type { Story } from "../lib/stories.js";
import { ImageCache } from "./cache.js";
import { imageCandidates, placeCandidates } from "./entities.js";
import { homeGround, venueMentioned } from "./grounds.js";
import { confirmedPerson, deceasedName, isDeathStory, MEDICAL, medicalFile, photoIdeas, standIns, topicFiles, TOPICS } from "./ideas.js";
import { searchPhoto, type SearchBudget } from "./search.js";
import { findFiles, findPhotos, type Photo } from "./wikimedia.js";

const COMMONS_SEARCHES_PER_EDITION = 300;
const OPENVERSE_SEARCHES_PER_EDITION = 15;

/** Every country's English name, plus short forms common in photo titles. Australia is home, so it never counts. */
const COUNTRY = (() => {
  const names = new Intl.DisplayNames(["en"], { type: "region" });
  const found = new Set(["USA", "UK", "England", "Scotland", "Wales"]);
  for (const a of "ABCDEFGHIJKLMNOPQRSTUVWXYZ") {
    for (const b of "ABCDEFGHIJKLMNOPQRSTUVWXYZ") {
      const name = names.of(a + b);
      if (name && name !== a + b && !/[()]/.test(name)) found.add(name);
    }
  }
  found.delete("Australia");
  return new RegExp(`(?<![\\p{L}])(${[...found].map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})(?![\\p{L}])`, "gu");
})();

/**
 * A found photo whose title names a country the story's reports never mention shows somewhere else: "Parliament of
 * Victoria" finds the British Columbia Parliament Building in Victoria, Canada.
 */
export function shotElsewhere(caption: string, story: Story): boolean {
  const text = story.items.map((i) => `${i.title} ${i.summary ?? ""}`).join(" ");
  return [...caption.matchAll(COUNTRY)].some((m) => !text.includes(m[1]!));
}

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
 * Stories about someone's death skip all of these: the person's own Wikipedia photo when it is surely them
 * (`confirmedPerson`), else a medical photo suited to the cause (ideas.ts `MEDICAL`).
 */
export async function assignPhotos(shown: Story[], cacheFile: string, now: Date): Promise<{ photos: Map<string, Photo>; counts: PhotoCounts }> {
  // Multi-source stories first, then by rank: they get the AI requests and search budget before single headlines.
  const stories = [...shown.filter((s) => s.independent >= 2), ...shown.filter((s) => s.independent < 2)];
  const cache = await ImageCache.open(cacheFile, now);
  const legal = new Set(stories.filter((s) => isLegalRisk(s.items)).map((s) => s.id));
  const death = new Set(stories.filter(isDeathStory).map((s) => s.id));
  const ideas = await photoIdeas(stories.filter((s) => !death.has(s.id)), legal, cache);

  const subjectsOf = new Map<string, string[]>();
  const placesOf = new Map<string, string[]>();
  for (const story of stories) {
    if (death.has(story.id)) continue;
    if (!legal.has(story.id)) subjectsOf.set(story.id, imageCandidates(story.items, story.independent >= 2 ? 3 : 2, story.section !== "sport", story.headline.title));
    placesOf.set(story.id, placeCandidates(story.items, story.headline.title));
  }
  const named = await findPhotos([...ideas.values()].map((i) => i.subject).filter(Boolean), "named", cache);
  const subjects = await findPhotos([...subjectsOf.values()].flat(), "subject", cache);
  const places = await findPhotos([...placesOf.values()].flat(), "place", cache);
  const venueOf = new Map<string, string>();
  for (const story of stories) {
    if (death.has(story.id)) continue;
    const suggested = ideas.get(story.id)?.venue || null;
    const stated = suggested && venueMentioned(suggested, story) ? suggested : null;
    // A venue the reports name beats a club's home ground, which beats the model's guess. Outside sport a guessed
    // place could be the wrong one, so only a named place counts.
    const venue = story.section === "sport" ? (stated ?? homeGround(story) ?? suggested) : stated;
    if (venue) venueOf.set(story.id, venue);
  }
  const venues = await findPhotos([...venueOf.values()], "place", cache);
  const deceasedOf = new Map(stories.filter((s) => death.has(s.id)).map((s) => [s.id, deceasedName(s.headline.title)] as const).filter((e): e is [string, string] => e[1] !== null));
  const people = await findPhotos([...deceasedOf.values()], "person", cache);
  const library = await findFiles(new Map([...TOPICS, ...MEDICAL].map((t) => [t.file, t.caption])), cache);

  const photos = new Map<string, Photo>();
  const counts: PhotoCounts = { event: 0, object: 0, broad: 0 };
  const budget: SearchBudget = { commons: COMMONS_SEARCHES_PER_EDITION, openverse: OPENVERSE_SEARCHES_PER_EDITION };
  // Stories are picked in order of importance, so the more prominent story keeps a photo two stories could share.
  const used = new Set<string>();
  const firstSearch = async (queries: string[], story: Story, fresh: (p: Photo | null | undefined) => Photo | null) => {
    for (const q of queries) {
      const photo = await searchPhoto(q, cache, budget);
      if (photo && !shotElsewhere(photo.subject, story) && fresh(photo)) return photo;
    }
    return null;
  };

  const pick = async (story: Story): Promise<void> => {
    // The best photo no other story uses yet; failing that, the best one even if shared.
    let fallback: [Photo, keyof PhotoCounts] | null = null;
    let tier: keyof PhotoCounts = "event";
    const fresh = (p: Photo | null | undefined): Photo | null => {
      if (!p) return null;
      fallback ??= [p, tier];
      return used.has(p.src) ? null : p;
    };
    const first = (list: (Photo | null | undefined)[]) => list.map(fresh).find((p) => p) ?? null;
    const choose = (photo: Photo | null) => {
      const [chosen, chosenTier] = photo ? [photo, tier] : (fallback ?? [null, tier]);
      if (!chosen) return false;
      photos.set(story.id, chosen);
      used.add(chosen.src);
      counts[chosenTier]++;
      return true;
    };
    if (death.has(story.id)) {
      const person = people.get(deceasedOf.get(story.id) ?? "") ?? null;
      const own = person?.description && confirmedPerson(story, person.description, now) ? person : null;
      if (own) choose(own);
      else {
        tier = "broad";
        choose(first([library.get(medicalFile(story)), library.get(MEDICAL.at(-1)!.file)]));
      }
      return;
    }
    const idea = ideas.get(story.id);
    const venue = venues.get(venueOf.get(story.id) ?? "") ?? null;
    const subjectList = [idea?.subject && !legal.has(story.id) ? named.get(idea.subject) : null, ...(subjectsOf.get(story.id) ?? []).map((n) => subjects.get(n))];
    const placeList = (placesOf.get(story.id) ?? []).map((n) => places.get(n));
    let photo = first([...(story.section === "sport" ? [venue, ...subjectList] : [...subjectList, venue]), ...placeList]);
    if (!photo) {
      tier = "object";
      photo = await firstSearch(idea?.searches ?? [], story, fresh);
    }
    if (!photo) {
      tier = "broad";
      photo = (idea?.theme ? await firstSearch([idea.theme], story, fresh) : null) ?? first(topicFiles(story).map((f) => library.get(f)));
    }
    const taken = (fallback as [Photo, keyof PhotoCounts] | null)?.[0].subject;
    if (!photo && taken) photo = first(standIns(taken).map((f) => library.get(f)));
    if (!choose(photo) && story.independent >= 2) {
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
