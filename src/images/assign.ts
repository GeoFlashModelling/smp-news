import { isLegalRisk } from "../ai/legal-risk.js";
import type { Story } from "../lib/stories.js";
import { ImageCache } from "./cache.js";
import { imageCandidates, placeCandidates } from "./entities.js";
import { homeGround, venueMentioned } from "./grounds.js";
import { confirmedPerson, deceasedName, isDeathStory, MEDICAL, medicalFile, photoIdeas, standIns, topicFiles, TOPICS } from "./ideas.js";
import { searchPhotos, type SearchBudget } from "./search.js";
import { findFiles, findPhotos, notAPhotoFile, type Photo } from "./wikimedia.js";

const COMMONS_SEARCHES_PER_EDITION = 300;
const OPENVERSE_SEARCHES_PER_EDITION = 15;
/** Searching stops after this long; stories still without a search answer get one in the next edition. */
const SEARCH_MINUTES = 6;
/** Originals narrower than this look blurry even in a card. */
const MIN_SHARP_WIDTH = 400;
/** A sample of refused photos in the log, to check the place rules aren't refusing good ones. */
const REFUSALS_LOGGED = 25;

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

const US_STATES =
  "Alabama|Alaska|Arizona|Arkansas|California|Colorado|Connecticut|Delaware|Florida|Hawaii|Idaho|Illinois|Indiana|Iowa|Kansas|Kentucky|Louisiana|Maine|Maryland|Massachusetts|Michigan|Minnesota|Mississippi|Missouri|Montana|Nebraska|Nevada|New Hampshire|New Jersey|New Mexico|New York|North Carolina|North Dakota|Ohio|Oklahoma|Oregon|Pennsylvania|Rhode Island|South Carolina|South Dakota|Tennessee|Texas|Utah|Vermont|Virginia|Washington|West Virginia|Wisconsin|Wyoming";
const US_STATE = new RegExp(`\\b(${US_STATES})\\b|\\bU\\.S\\.`);
/** Other ways reports name a country: a story saying "US" or "Britain" is about the United States or United Kingdom. */
const ALSO_NAMED: Record<string, RegExp> = {
  "United States": new RegExp(`\\b(United States|USA|US|U\\.S\\.|America|Americans?|Trump|White House|Congress|Capitol Hill|Pentagon|Republicans?|Democrats?|GOP|bipartisan|filibuster|${US_STATES})\\b`),
  "United Kingdom": /\b(United Kingdom|UK|Britain|British|England|English|Scotland|Scottish|Wales|Welsh|London)\b/,
  "New Zealand": /\b(New Zealand|NZ|Kiwis?|Aotearoa|Auckland|Wellington|Christchurch)\b/,
  Australia: /\b(Australia|Australian?s?|Aussies?|Canberra|Sydney|Melbourne|Brisbane|Perth|Adelaide|Hobart|Darwin)\b/,
};
ALSO_NAMED.USA = ALSO_NAMED["United States"]!;
ALSO_NAMED.UK = ALSO_NAMED["United Kingdom"]!;
ALSO_NAMED.England = ALSO_NAMED["United Kingdom"]!;
ALSO_NAMED.Scotland = ALSO_NAMED["United Kingdom"]!;
ALSO_NAMED.Wales = ALSO_NAMED["United Kingdom"]!;

function storyText(story: Story): string {
  return story.items.map((i) => `${i.title} ${i.summary ?? ""}`).join(" ");
}

function mentions(text: string, country: string): boolean {
  return (ALSO_NAMED[country] ?? new RegExp(`(?<![\\p{L}])${country.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\p{L}])`, "u")).test(text);
}

/** Captions often name only the city: "Nuclear Energy Summit, Brussels Expo". */
const CITY_COUNTRY: Record<string, string> = {
  London: "United Kingdom", Manchester: "United Kingdom", Edinburgh: "United Kingdom", Glasgow: "United Kingdom", Bristol: "United Kingdom",
  Paris: "France", Berlin: "Germany", Munich: "Germany", Brussels: "Belgium", Rome: "Italy", Milan: "Italy", Madrid: "Spain",
  Barcelona: "Spain", Lisbon: "Portugal", Amsterdam: "Netherlands", Geneva: "Switzerland", Zurich: "Switzerland", Vienna: "Austria",
  Moscow: "Russia", Kyiv: "Ukraine", Istanbul: "Turkey", Ankara: "Turkey", Antalya: "Turkey", Yerevan: "Armenia", Jerusalem: "Israel",
  "Tel Aviv": "Israel", Dubai: "United Arab Emirates", Ottawa: "Canada", Toronto: "Canada", Vancouver: "Canada", Montreal: "Canada",
  "New York": "United States", "Los Angeles": "United States", Chicago: "United States", "San Francisco": "United States",
  "Washington, D.C.": "United States", Tokyo: "Japan", Osaka: "Japan", Beijing: "China", Shanghai: "China", Seoul: "South Korea",
  Delhi: "India", Mumbai: "India", Jakarta: "Indonesia", Bali: "Indonesia", Bangkok: "Thailand", Manila: "Philippines",
  "Kuala Lumpur": "Malaysia", "Port Moresby": "Papua New Guinea", Suva: "Fiji",
};
const CITY = new RegExp(`\\b(${Object.keys(CITY_COUNTRY).map((c) => c.replace(/[.]/g, "\\.")).join("|")})(?![\\p{L}])`, "gu");

/** A caption showing a building or a place rather than a thing. */
const BUILT =
  /\b(building|house|court(house)?s?|parliament|capitol|hall|offices?|tower|headquarters|street|road|avenue|lane|square|skyline|city|cbd|downtown|town|suburb|station|bridge|harbou?r|port|wharf|beach|stadium|arena|ground|oval|hospital|school|university|college|campus|church|cathedral|museum|library|airport|terminal|mall|shopping cent(re|er)|plaza|palace|embassy|bank|exchange|treasury|ministry|department|hotel|casino|prison|police station|base|barracks)\b/i;

/**
 * Australian states and territories, by name and main towns. Canberra is left out: federal stories name many states
 * and Parliament House suits them all.
 */
const STATES: RegExp[] = [
  /\b(Western Australian?|WA|Perth|Fremantle|Mandurah|Bunbury|Kalgoorlie|Geraldton|Albany|Broome|Karratha|Port Hedland|Pilbara|Kimberley|Rottnest)\b/,
  /\b(South Australian?|SA|Adelaide|Mount Gambier|Whyalla|Port Augusta|Barossa)\b/,
  /\b(Northern Territory|NT|Darwin|Alice Springs|Uluru)\b/,
  /\b(Queensland(er)?s?|Qld|QLD|Brisbane|Gold Coast|Sunshine Coast|Cairns|Townsville|Toowoomba|Rockhampton)\b/,
  /\b(New South Wales|NSW|Sydney|Newcastle|Wollongong|Bondi|Parramatta|Byron Bay)\b/,
  /\b(Victorian?s?|Vic|Melbourne|Geelong|Ballarat|Bendigo)\b/,
  /\b(Tasmanian?s?|Tas|Hobart|Launceston|Beaconsfield)\b/,
];

/** A photo from one state on a story about others: a Darwin courthouse on a South Australian trial. */
function otherState(caption: string, text: string): boolean {
  const shown = STATES.filter((s) => s.test(caption));
  const named = STATES.filter((s) => s.test(text));
  return shown.length > 0 && named.length > 0 && !shown.some((s) => named.includes(s));
}

/** Roughly where a camera position is: the Australian mainland and Tasmania, New Zealand, or anywhere else. */
function regionOf(lat: number, lon: number): "Australia" | "New Zealand" | "abroad" {
  if (lat >= -44.5 && lat <= -9 && lon >= 112 && lon <= 154.5) return "Australia";
  if (lat >= -48 && lat <= -33.5 && lon >= 165.5 && lon <= 179.99) return "New Zealand";
  return "abroad";
}

/** Whether the story is about somewhere other than Australia and New Zealand. */
function aboutAbroad(story: Story, text: string): boolean {
  if (story.section === "world") return true;
  return [...text.matchAll(COUNTRY)].some((m) => m[1] !== "New Zealand") || mentions(text, "United States") || mentions(text, "United Kingdom");
}

/**
 * A photo of somewhere the story isn't about would mislead (owner, 10 Nov 2026: a US federal building on an
 * Australian story). Two tests:
 * 1. where the camera was, when the file records it: abroad is only for stories about abroad; New Zealand only for
 *    stories that mention it, and Australia, for New Zealand stories, only when they mention Australia;
 * 2. the caption: a country (or US state) the story's reports never mention. "Parliament of Victoria" finds the
 *    British Columbia Parliament Building in Victoria, Canada. Likewise an Australian state the story doesn't name
 *    when it names others (`otherState`).
 */
export function shotElsewhere(photo: Photo, story: Story, place = BUILT.test(photo.subject)): boolean {
  const text = storyText(story);
  // Things and animals look the same anywhere (rugby goalposts, a koala, oil pumpjacks); only places can be the wrong one.
  if (place && photo.lat !== undefined && photo.lon !== undefined) {
    const region = regionOf(photo.lat, photo.lon);
    if (region === "abroad" && !aboutAbroad(story, text)) return true;
    if (region === "New Zealand" && story.section !== "new-zealand" && !mentions(text, "New Zealand")) return true;
    if (region === "Australia" && story.section === "new-zealand" && !mentions(text, "Australia")) return true;
  }
  // "New South Wales" isn't Wales.
  const caption = (photo.title ?? photo.subject).replace(/New South Wales/gi, "NSW");
  const home = story.section === "new-zealand" ? "New Zealand" : "Australia";
  const cities = [...caption.matchAll(CITY)].map((m) => m[1]!).filter((city) => !mentions(text, city));
  const countries = [...[...caption.matchAll(COUNTRY)].map((m) => m[1]!), ...cities.map((city) => CITY_COUNTRY[city]!)]
    .filter((c) => c !== home);
  if (US_STATE.test(caption)) countries.push("United States");
  // Captions name cities more often than countries: "Royal Perth Hospital" belongs on a New Zealand story only when it mentions Australia.
  if (story.section === "new-zealand" && mentions(caption, "Australia")) countries.push("Australia");
  if (story.section !== "new-zealand" && mentions(caption, "New Zealand")) countries.push("New Zealand");
  return countries.some((c) => !mentions(text, c)) || otherState(caption, text);
}

export interface PhotoCounts {
  event: number;
  object: number;
  broad: number;
  /** Stories that had to show a photo another story already shows (counted in their tier too). */
  shared: number;
  /** Photos refused for showing somewhere the story isn't about. */
  elsewhere: number;
}

/** A photo's subject as a search for other photos of the same thing: "Parliament House, Canberra" → "Parliament House Canberra". */
function sameThing(subject: string): string {
  return subject.replace(/\s*\(.*?\)/g, "").replace(/^(the|a|an) /i, "").replace(/[^\p{L}\p{N}'’ -]+/gu, " ").replace(/\s+/g, " ").trim();
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
 * No two stories share a photo while another good one exists (owner, 10 Nov 2026: repeats must not mean weaker
 * pictures): each search keeps several results, and when a story's photo of its subject or place is taken, other
 * photos of that same subject or place are searched for before a weaker kind of picture is tried. Photos of
 * somewhere the story isn't about are refused (`shotElsewhere`).
 * Stories about someone's death skip all of these: the person's own Wikipedia photo when it is surely them
 * (`confirmedPerson`), else a medical photo suited to the cause (ideas.ts `MEDICAL`).
 */
export async function assignPhotos(shown: Story[], cacheFile: string, now: Date, onFront: Story[] = []): Promise<{ photos: Map<string, Photo>; counts: PhotoCounts }> {
  // The front page's stories first, in reading order, so none of them repeats another's photo; then multi-source
  // stories, then by rank: they get the AI requests and search budget before single headlines.
  const front = new Set(onFront.map((s) => s.id));
  // The front page's first story is its large lead.
  const leadId = onFront[0]?.id;
  const rest = shown.filter((s) => !front.has(s.id));
  const stories = [...new Set([...onFront.filter((s) => shown.includes(s)), ...rest.filter((s) => s.independent >= 2), ...rest.filter((s) => s.independent < 2)])];
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
  const counts: PhotoCounts = { event: 0, object: 0, broad: 0, shared: 0, elsewhere: 0 };
  const budget: SearchBudget = { commons: COMMONS_SEARCHES_PER_EDITION, openverse: OPENVERSE_SEARCHES_PER_EDITION, until: Date.now() + SEARCH_MINUTES * 60_000 };
  // Stories are picked in order of prominence, so the more prominent story keeps a photo two stories could share.
  const used = new Set<string>();
  // The same file comes back with different tracking parameters ("?utm_source=en.wikipedia.org" or commons).
  const fileOf = (p: Photo) => p.src.split("?")[0]!;

  const pick = async (story: Story): Promise<void> => {
    // The best photo no other story uses yet; failing that, the best one even if shared.
    let fallback: [Photo, keyof PhotoCounts] | null = null;
    // A small original looks blurry in a card: only shown when nothing else is found.
    let blurry: [Photo, keyof PhotoCounts] | null = null;
    let tier: keyof PhotoCounts = "event";
    // Good photos another story already shows, with their tier: other photos of the same thing are looked for.
    const taken: [Photo, keyof PhotoCounts][] = [];
    const fresh = (p: Photo | null | undefined): Photo | null => {
      // Cached lookups predate some filters, so maps are checked again here.
      if (!p || notAPhotoFile(p.src)) return null;
      if (p.width < MIN_SHARP_WIDTH) {
        blurry ??= [p, tier];
        return null;
      }
      fallback ??= [p, tier];
      if (!used.has(fileOf(p))) return p;
      taken.push([p, tier]);
      return null;
    };
    const first = (list: (Photo | null | undefined)[]) => list.map(fresh).find((p) => p) ?? null;
    // Landscape photos fill the card; the lead story is shown large, so it needs the large version too.
    const fits = (p: Photo) => p.width >= p.height && (story.id !== leadId || p.large !== undefined);
    // A landscape photo of the same person, organisation or place ("BHP" → a BHP mine, not the logo-like portrait).
    const wider = async (p: Photo): Promise<Photo | null> => {
      const name = sameThing(p.subject);
      const words = name.toLowerCase().split(/\s+/).filter((w) => w.length >= 2);
      if (!words.length || words.length > 5) return null;
      for (const found of await searchPhotos(name, cache, budget)) {
        const title = (found.title ?? found.subject).toLowerCase();
        if (fits(found) && words.every((w) => title.includes(w)) && !refuse(found) && fresh(found)) return found;
      }
      return null;
    };
    const refuse = (p: Photo, asPlace?: boolean) => {
      const wrong = shotElsewhere(p, story, asPlace);
      if (wrong && counts.elsewhere++ < REFUSALS_LOGGED) console.log(`Photo refused as elsewhere: "${p.subject}" (${p.lat?.toFixed(1) ?? "-"}, ${p.lon?.toFixed(1) ?? "-"}) for ${story.section} story "${story.headline.title}"`);
      return wrong;
    };
    const here = (p: Photo | null | undefined) => (p && !refuse(p) ? p : null);
    const place = (p: Photo | null | undefined) => (p && !refuse(p, true) ? p : null);
    const firstSearch = async (queries: string[]) => {
      for (const q of queries) {
        for (const photo of await searchPhotos(q, cache, budget)) if (!refuse(photo) && fresh(photo)) return photo;
      }
      return null;
    };
    const tried = new Set<string>();
    // Another photo of something a taken photo shows ("Parliament House, Canberra" → search for it), at that photo's tier.
    const alternative = async (tiers: (keyof PhotoCounts)[], most: number) => {
      for (const [p, t] of taken.filter(([, t]) => tiers.includes(t))) {
        const query = sameThing(p.subject);
        if (tried.has(query) || tried.size >= most) continue;
        tried.add(query);
        tier = t;
        const photo = await firstSearch([query]);
        if (photo) return photo;
      }
      return null;
    };
    const choose = (photo: Photo | null) => {
      const [chosen, chosenTier] = photo ? [photo, tier] : ((fallback as [Photo, keyof PhotoCounts] | null) ?? (blurry as [Photo, keyof PhotoCounts] | null) ?? [null, tier]);
      if (!chosen) return false;
      photos.set(story.id, chosen);
      used.add(fileOf(chosen));
      counts[chosenTier]++;
      if (!photo) counts.shared++;
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
    const venue = place(venues.get(venueOf.get(story.id) ?? ""));
    const subjectList = [idea?.subject && !legal.has(story.id) ? named.get(idea.subject) : null, ...(subjectsOf.get(story.id) ?? []).map((n) => subjects.get(n))];
    const placeList = (placesOf.get(story.id) ?? []).map((n) => place(places.get(n)));
    // In science and tech a town in the reports is usually just where the researchers or company are (a galaxy study
    // from Salt Lake City), so the object the story is about comes before the town.
    const townsLast = story.section === "science-tech" || story.section === "tech";
    const eventList = [...(story.section === "sport" ? [venue, ...subjectList] : [...subjectList, venue]), ...(townsLast ? [] : placeList)];
    let photo = first(eventList);
    if (photo && !fits(photo)) {
      // Portrait or too small for the lead: the same subject in landscape; for a place, another place the reports name.
      const ofPlace = !subjectList.includes(photo);
      photo = (await wider(photo)) ?? (ofPlace ? eventList.slice(eventList.indexOf(photo) + 1).find((p): p is Photo => Boolean(p && fits(p) && fresh(p))) : undefined) ?? photo;
    }
    if (!photo) photo = await alternative(["event"], 2);
    if (!photo) {
      tier = "object";
      photo = await firstSearch(idea?.searches ?? []);
    }
    if (!photo && townsLast) {
      tier = "event";
      photo = first(placeList);
    }
    if (!photo) {
      tier = "broad";
      photo = (idea?.theme ? await firstSearch([idea.theme]) : null) ?? first(topicFiles(story).map((f) => here(library.get(f))));
    }
    for (const [p] of [...taken]) if (!photo) photo = first(standIns(p.subject, p.src).map((f) => here(library.get(f))));
    if (!photo) photo = await alternative(["object", "broad"], 4);
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
