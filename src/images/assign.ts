import { isLegalRisk, legalMode } from "../ai/legal-risk.js";
import { namedByOutlets } from "../ai/named.js";
import type { SourceBlock } from "../ai/prompt.js";
import { LOCAL_SECTIONS } from "../config/sources.js";
import type { Story } from "../lib/stories.js";
import { ImageCache } from "./cache.js";
import { imageCandidates, placeCandidates } from "./entities.js";
import { homeGround, venueMentioned } from "./grounds.js";
import { confirmedPerson, deceasedName, isDeathStory, MEDICAL, medicalFile, photoIdeas, standIns, topicFiles, topicPlaces, TOPICS } from "./ideas.js";
import { groundedQuery, isPersonName, otherPerson, searchPhotos, type SearchBudget } from "./search.js";
import { reportsMark, verdict, vetPhotos, VET_MINUTES, VET_REQUESTS } from "./vet.js";
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
  "Cape Breton": "Canada", "Nova Scotia": "Canada", Halifax: "Canada",
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
const STATE_LABELS: { test: RegExp; label: string }[] = [
  { test: /\b(Western Australian?|WA|Perth|Fremantle|Mandurah|Bunbury|Kalgoorlie|Geraldton|Albany|Broome|Karratha|Port Hedland|Pilbara|Kimberley|Rottnest)\b/, label: "Western Australia" },
  { test: /\b(South Australian?|SA|Adelaide|Mount Gambier|Whyalla|Port Augusta|Barossa)\b/, label: "South Australia" },
  { test: /\b(Northern Territory|NT|Darwin|Alice Springs|Uluru)\b/, label: "Northern Territory" },
  { test: /\b(Queensland(er)?s?|Qld|QLD|Brisbane|Gold Coast|Sunshine Coast|Cairns|Townsville|Toowoomba|Rockhampton)\b/, label: "Queensland" },
  { test: /\b(New South Wales|NSW|Sydney|Newcastle|Wollongong|Bondi|Parramatta|Byron Bay)\b/, label: "New South Wales" },
  { test: /\b(Victorian?s?|Vic|Melbourne|Geelong|Ballarat|Bendigo)\b/, label: "Victoria" },
  { test: /\b(Tasmanian?s?|Tas|Hobart|Launceston|Beaconsfield)\b/, label: "Tasmania" },
];
const STATES: RegExp[] = STATE_LABELS.map((s) => s.test);
/** A local section already says where the story is. Canberra is not here: a federal story names it without being about the ACT. */
const SECTION_PLACE: Record<string, string> = {
  "local-wa": "Western Australia",
  "local-nsw": "New South Wales",
  "local-vic": "Victoria",
  "local-qld": "Queensland",
  "local-sa": "South Australia",
  "local-tas": "Tasmania",
  "local-act": "Australian Capital Territory",
  "local-nt": "Northern Territory",
  "new-zealand": "New Zealand",
};

/** Countries named in a piece of text, specific parts of the UK before the UK itself. Australia is left out. */
function countriesIn(text: string): string[] {
  const found: string[] = [];
  if (/\b(Scotland|Scottish)\b/.test(text)) found.push("Scotland");
  else if (/\b(England|English)\b/.test(text)) found.push("England");
  else if (/\b(Wales|Welsh)\b/.test(text) && !/\bNew South Wales\b/.test(text)) found.push("Wales");
  else if (ALSO_NAMED["United Kingdom"]!.test(text)) found.push("United Kingdom");
  if (ALSO_NAMED["New Zealand"]!.test(text)) found.push("New Zealand");
  if (ALSO_NAMED["United States"]!.test(text)) found.push("United States");
  for (const match of text.matchAll(new RegExp(COUNTRY.source, "gu"))) {
    const name = match[1]!;
    if (["USA", "UK", "England", "Scotland", "Wales", "New Zealand"].includes(name) || found.includes(name)) continue;
    found.push(name);
  }
  return found;
}

/** The one state or country a piece of text is about, or null when it names several or none. */
function onePlace(text: string): string | null {
  if (!text.trim()) return null;
  const states = STATE_LABELS.filter((s) => s.test.test(text)).map((s) => s.label);
  const countries = countriesIn(text);
  if (states.length === 1 && countries.length === 0) return states[0]!;
  if (countries.length === 1 && states.length === 0) return countries[0]!;
  if (states.length === 1 && countries.length === 1) {
    const stateAt = text.search(STATE_LABELS.find((s) => s.label === states[0])!.test);
    const countryAt = text.search(new RegExp(countries[0]!.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i"));
    return stateAt !== -1 && (countryAt === -1 || stateAt <= countryAt) ? states[0]! : countries[0]!;
  }
  if (states.length > 1 || mentions(text, "Australia")) return "Australia";
  return null;
}

/**
 * Where a generic place photo should be: the reader's local section, else the state or country named in the
 * displayed headline, else in the report titles. A body mention of a club's city does not override the headline.
 */
export function settingOf(story: Story): string | null {
  const fixed = SECTION_PLACE[story.section];
  if (fixed) return fixed;
  const shown = [story.writeup?.summary?.headline, story.headline.title].filter(Boolean).join(" ");
  return onePlace(shown) ?? onePlace(story.items.slice(0, 5).map((i) => i.title).join(" "));
}

/** Whether a photo is in that state or country: the caption says so, or the camera position does. */
function showsSetting(photo: Photo, setting: string): boolean {
  const caption = `${photo.title ?? ""} ${photo.subject}`;
  const word: Record<string, RegExp> = {
    "Western Australia": /\b(western australia|perth|fremantle)\b/i,
    "New South Wales": /\b(new south wales|nsw|sydney)\b/i,
    Victoria: /\b(victoria|melbourne)\b/i,
    Queensland: /\b(queensland|brisbane)\b/i,
    "South Australia": /\b(south australia|adelaide)\b/i,
    Tasmania: /\b(tasmania|hobart)\b/i,
    "Australian Capital Territory": /\b(australian capital territory|canberra)\b/i,
    "Northern Territory": /\b(northern territory|darwin)\b/i,
    "New Zealand": /\b(new zealand|aotearoa|auckland|wellington|christchurch)\b/i,
    Australia: /\baustralia\b/i,
    "United States": /\b(united states|u\.s\.|usa)\b/i,
    "United Kingdom": /\b(united kingdom|britain)\b/i,
    England: /\bengland\b/i,
    Scotland: /\bscotland\b/i,
    Wales: /\bwales\b/i,
  };
  if ((word[setting] ?? new RegExp(`\\b${setting.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i")).test(caption)) return true;
  if (photo.lat === undefined || photo.lon === undefined) return false;
  const region = regionOf(photo.lat, photo.lon);
  if (setting === "New Zealand") return region === "New Zealand";
  if (setting === "Australia") return region === "Australia";
  const state = stateAt(photo.lat, photo.lon);
  return state === setting;
}

/** Which Australian state a camera position is in. The same rough borders as the reader's "Use my location". */
function stateAt(lat: number, lon: number): string | null {
  if (lat > -9 || lat < -44.5 || lon < 112 || lon > 154.5) return null;
  if (lat < -39.2 && lon > 143.5) return "Tasmania";
  if (lon < 129) return "Western Australia";
  if (lon < 138) return lat > -26 ? "Northern Territory" : "South Australia";
  if (lon < 141) return lat > -26 ? "Queensland" : "South Australia";
  if (lat >= -35.92 && lat <= -35.12 && lon >= 148.76 && lon <= 149.21) return "Australian Capital Territory";
  if (lat > (lon < 150 ? -29 : -28.6)) return "Queensland";
  const murray: [number, number][] = [[141, -34], [142.2, -34.15], [143.55, -35.3], [144.75, -36.1], [146.9, -36.07], [148.2, -36.8], [150, -37.5]];
  let border = -37.5;
  for (let i = 1; i < murray.length; i++) {
    const prev = murray[i - 1] ?? murray[0]!;
    const next = murray[i] ?? prev;
    const x0 = prev[0];
    const y0 = prev[1];
    const x1 = next[0];
    const y1 = next[1];
    if (lon <= x1) {
      border = y0 + ((lon - x0) / (x1 - x0)) * (y1 - y0);
      break;
    }
  }
  if (lon <= 150 && lat < border) return "Victoria";
  return "New South Wales";
}

/** A theme that is a place or a sport, so the story's state or country can be added to the search. */
const PLACED_THEME = /\b(rugby|football|cricket|soccer|tennis|golf|netball|basketball|stadium|ground|oval|court(house)?|police|hospital|school|university|beach|airport|station|freeway|street|mine|parliament|skyline)\b/i;

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

const HOME_SECTIONS = new Set<string>(["australia", "new-zealand", ...LOCAL_SECTIONS]);

/**
 * A searched photo taken abroad, on a story set in Australia or New Zealand: an outdoor scene (a petrol station, a
 * street, bushland) looks foreign even when it isn't of a named place. Hand-picked library photos aren't checked.
 */
function takenAbroad(photo: Photo, story: Story): boolean {
  if (photo.lat === undefined || photo.lon === undefined || !HOME_SECTIONS.has(story.section)) return false;
  return regionOf(photo.lat, photo.lon) === "abroad" && !aboutAbroad(story, storyText(story));
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
  /** Photos the model judged off the point of their story (vet.ts). */
  offPoint: number;
}
/** Rounds of checking chosen photos and choosing again for the refused ones. */
const VET_ROUNDS = 3;

/** The photo a story was given, kept while it still passes the checks. */
interface Remembered {
  photo: Photo;
  tier: keyof PhotoCounts;
  death: boolean;
  rules?: number;
}
/** Bump when the order photos are chosen in changes, so every story chooses once more (searches stay cached). */
const PICK_RULES = 3;

/** A photo's subject as a search for other photos of the same thing: "Parliament House, Canberra" → "Parliament House Canberra". */
function sameThing(subject: string): string {
  return subject.replace(/\s*\(.*?\)/g, "").replace(/^(the|a|an) /i, "").replace(/[^\p{L}\p{N}'’ -]+/gu, " ").replace(/\s+/g, " ").trim();
}

/**
 * Every story gets a picture, most specific first. Photos of the news event itself are nearly always copyright, so:
 * 1. event: a free photo of who or where the story is about. A person only when the words may already name them
 *    and the file is the lead image of the English Wikipedia article titled exactly with their name. Then where it
 *    happened: the venue the reports name, a club's home ground when the club is named (grounds.ts), then a town.
 *    Sport puts the ground first. A search result is never a person;
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
  await cache.save();

  const subjectsOf = new Map<string, string[]>();
  const placesOf = new Map<string, string[]>();
  for (const story of stories) {
    if (death.has(story.id)) continue;
    if (!legal.has(story.id)) subjectsOf.set(story.id, imageCandidates(story.items, story.independent >= 2 ? 3 : 2, story.section !== "sport", story.headline.title));
    placesOf.set(story.id, placeCandidates(story.items, story.headline.title));
  }
  const toldOf = (story: Story) => [story.headline.title, ...story.items.slice(0, 6).map((i) => `${i.title} ${i.summary}`)].join(" ");
  const portraitsOf = new Map<string, string[]>();
  const thingNames: string[] = [];
  const ideaThings: string[] = [];
  const ideaPeople: string[] = [];
  for (const story of stories) {
    if (death.has(story.id)) continue;
    const text = toldOf(story);
    const mode = legalMode(story.items);
    if (mode === "normal") {
      const people = (subjectsOf.get(story.id) ?? []).filter((n) => isPersonName(n));
      if (people.length) portraitsOf.set(story.id, people);
      thingNames.push(...(subjectsOf.get(story.id) ?? []).filter((n) => !isPersonName(n)));
      const subject = ideas.get(story.id)?.subject ?? "";
      if (subject && groundedQuery(subject, text)) (isPersonName(subject) ? ideaPeople : ideaThings).push(subject);
    } else {
      const blocks: SourceBlock[] = story.items.slice(0, 8).map((item, n) => ({
        id: `S${n + 1}`,
        item,
        text: `${item.title}. ${item.summary ?? ""}`,
      }));
      const people = [...namedByOutlets(blocks, mode).values()];
      if (people.length) portraitsOf.set(story.id, people);
    }
  }
  const named = await findPhotos(ideaThings, "named", cache);
  const namedPortraits = await findPhotos(ideaPeople, "person", cache);
  const portraits = await findPhotos([...portraitsOf.values()].flat(), "person", cache);
  const subjects = await findPhotos(thingNames, "subject", cache);
  const places = await findPhotos([...placesOf.values()].flat(), "place", cache);
  const venueOf = new Map<string, string>();
  for (const story of stories) {
    if (death.has(story.id)) continue;
    const suggested = ideas.get(story.id)?.venue || null;
    const stated = suggested && venueMentioned(suggested, story) ? suggested : null;
    // A venue the reports name beats a club's home ground. Outside sport the model's guess is not used.
    const venue = story.section === "sport" ? (stated ?? homeGround(story) ?? suggested) : (stated ?? homeGround(story));
    if (venue) venueOf.set(story.id, venue);
  }
  const venues = await findPhotos([...venueOf.values()], "place", cache);
  const deceasedOf = new Map(stories.filter((s) => death.has(s.id)).map((s) => [s.id, deceasedName(s.headline.title)] as const).filter((e): e is [string, string] => e[1] !== null));
  const people = await findPhotos([...deceasedOf.values()], "person", cache);
  const library = await findFiles(new Map([...TOPICS, ...MEDICAL].map((t) => [t.file, t.caption])), cache);

  const photos = new Map<string, Photo>();
  let otherLogged = 0;
  const counts: PhotoCounts = { event: 0, object: 0, broad: 0, shared: 0, elsewhere: 0, offPoint: 0 };
  const chosenOf = new Map<string, { photo: Photo; tier: keyof PhotoCounts; shared: boolean }>();
  const budget: SearchBudget = { commons: COMMONS_SEARCHES_PER_EDITION, openverse: OPENVERSE_SEARCHES_PER_EDITION, until: Date.now() + SEARCH_MINUTES * 60_000 };
  // Stories are picked in order of prominence, so the more prominent story keeps a photo two stories could share.
  const used = new Set<string>();
  // The same file comes back with different tracking parameters ("?utm_source=en.wikipedia.org" or commons).
  const fileOf = (p: Photo) => p.src.split("?")[0]!;

  const pick = async (story: Story, floorOnly = false): Promise<void> => {
    // The best photo no other story uses yet; failing that, the best one even if shared.
    let fallback: [Photo, keyof PhotoCounts] | null = null;
    // A small original looks blurry in a card: only shown when nothing else is found.
    let blurry: [Photo, keyof PhotoCounts] | null = null;
    let tier: keyof PhotoCounts = "event";
    // Good photos another story already shows, with their tier: other photos of the same thing are looked for.
    const taken: [Photo, keyof PhotoCounts][] = [];
    const told = toldOf(story);
    const mark = reportsMark(story);
    const fresh = (p: Photo | null | undefined): Photo | null => {
      // Cached lookups predate some filters, so maps are checked again here.
      if (!p || notAPhotoFile(p.src) || verdict(cache, story.id, p, mark) === false) return null;
      if (otherPerson(p, told)) {
        if (otherLogged < REFUSALS_LOGGED) console.log(`Photo refused as someone else: "${p.subject}" for "${story.headline.title}"`);
        otherLogged++;
        return null;
      }
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
        if (fits(found) && words.every((w) => title.includes(w)) && !refuse(found, undefined, true) && fresh(found)) return found;
      }
      return null;
    };
    const refuse = (p: Photo, asPlace?: boolean, searched = false) => {
      const wrong = shotElsewhere(p, story, asPlace) || (searched && takenAbroad(p, story));
      if (wrong && counts.elsewhere++ < REFUSALS_LOGGED) console.log(`Photo refused as elsewhere: "${p.subject}" (${p.lat?.toFixed(1) ?? "-"}, ${p.lon?.toFixed(1) ?? "-"}) for ${story.section} story "${story.headline.title}"`);
      return wrong;
    };
    const here = (p: Photo | null | undefined) => (p && !refuse(p) ? p : null);
    const place = (p: Photo | null | undefined) => (p && !refuse(p, true) ? p : null);
    const firstSearch = async (queries: string[], where?: string) => {
      for (const q of queries) {
        for (const photo of await searchPhotos(q, cache, budget)) {
          if (where && !showsSetting(photo, where)) continue;
          if (!refuse(photo, Boolean(where), true) && fresh(photo)) return photo;
        }
      }
      return null;
    };
    // The library caption hides where the file was taken ("a rugby league match" is a match in England), so the
    // filename is checked too and a file from somewhere else is skipped.
    const fromLibrary = (files: string[]) =>
      first(files.map((f) => {
        const photo = library.get(f);
        return photo ? here({ ...photo, title: `${photo.subject}. ${f.replace(/_/g, " ")}` }) : null;
      }));
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
      chosenOf.set(story.id, { photo: chosen, tier: chosenTier, shared: !photo });
      // A good photo of its own is kept from now on; a shared, blurry or topic picture is looked at again next hour.
      if (photo && chosenTier !== "broad") cache.set(`chosen:${story.id}`, { photo: chosen, tier: chosenTier, death: death.has(story.id), rules: PICK_RULES } satisfies Remembered);
      return true;
    };
    // A refused photo is replaced with a topic photo. Searching again is what put the wrong person back.
    if (floorOnly) {
      tier = "broad";
      choose(fromLibrary(topicFiles(story)));
      return;
    }
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
    const where = settingOf(story);
    const localPlaces = where ? topicPlaces(story).map((p) => `${p} ${where}`) : [];
    const searches = (idea?.searches ?? []).filter((q) => groundedQuery(q, told));
    const theme = idea?.theme && groundedQuery(idea.theme, told) ? idea.theme : "";
    const placedTheme = where && theme && PLACED_THEME.test(theme) && !theme.toLowerCase().includes(where.toLowerCase()) ? `${theme} ${where}` : "";
    const venue = place(venues.get(venueOf.get(story.id) ?? ""));
    const subjectName = idea?.subject && !legal.has(story.id) && groundedQuery(idea.subject, told) ? idea.subject : "";
    const ideaPhoto = subjectName ? (isPersonName(subjectName) ? namedPortraits.get(subjectName) : named.get(subjectName)) : null;
    const subjectList = [
      ideaPhoto,
      ...(portraitsOf.get(story.id) ?? []).map((n) => portraits.get(n)),
      ...(subjectsOf.get(story.id) ?? []).filter((n) => !isPersonName(n)).map((n) => subjects.get(n)),
    ];
    const placeList = (placesOf.get(story.id) ?? []).map((n) => place(places.get(n)));
    // In science and tech a town in the reports is usually just where the researchers or company are (a galaxy study
    // from Salt Lake City), so the object the story is about comes before the town.
    const townsLast = story.section === "science-tech" || story.section === "tech";
    const eventList = [...(story.section === "sport" ? [venue, ...subjectList] : [...subjectList, venue]), ...(townsLast ? [] : placeList)];
    let photo = first(eventList);
    if (photo && !fits(photo) && !(photo.kind === "named" && isPersonName(photo.subject))) {
      // Portrait or too small for the lead: the same subject in landscape; for a place, another place the reports name.
      const ofPlace = !subjectList.includes(photo);
      photo = (await wider(photo)) ?? (ofPlace ? eventList.slice(eventList.indexOf(photo) + 1).find((p): p is Photo => Boolean(p && fits(p) && fresh(p))) : undefined) ?? photo;
    }
    if (!photo) photo = await alternative(["event"], 2);
    // Allegation stories: a hand-picked topic photo (the parliament, a courthouse) before searched objects, which can
    // come from the allegation itself and look like the scene (owner, 11 Nov 2026: a basketball court on a candidate
    // dropped over remarks to a basketballer).
    if (!photo && legal.has(story.id)) {
      tier = "broad";
      photo = (localPlaces.length ? await firstSearch(localPlaces, where!) : null) ?? fromLibrary(topicFiles(story));
    }
    if (!photo) {
      tier = "object";
      photo = await firstSearch(searches);
    }
    if (!photo && townsLast) {
      tier = "event";
      photo = first(placeList);
    }
    if (!photo) {
      tier = "broad";
      const local = [...localPlaces, ...(placedTheme ? [placedTheme] : [])];
      photo = (local.length ? await firstSearch(local, where!) : null) ?? (theme ? await firstSearch([theme]) : null) ?? fromLibrary(topicFiles(story));
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
  // A story keeps the photo it had (owner, 11 Nov 2026: pictures were changing on existing stories). Remembered photos
  // are claimed before anything is chosen, so a story rising up the page can't take another's photo, unless the photo
  // now fails a check, the story became (or stopped being) about a death, or it is the lead and needs a larger photo.
  const settled = new Set<string>();
  for (const story of stories) {
    const memory = cache.get<Remembered>(`chosen:${story.id}`);
    const p = memory?.photo;
    if (!p || memory.rules !== PICK_RULES || memory.death !== death.has(story.id) || used.has(fileOf(p)) || notAPhotoFile(p.src) || p.width < MIN_SHARP_WIDTH) continue;
    const told = [story.headline.title, ...story.items.slice(0, 6).map((i) => `${i.title} ${i.summary}`)].join(" ");
    if ((story.id === leadId && p.large === undefined) || shotElsewhere(p, story) || otherPerson(p, told) || (memory.tier === "object" && takenAbroad(p, story)) || verdict(cache, story.id, p, reportsMark(story)) === false) continue;
    photos.set(story.id, p);
    used.add(fileOf(p));
    chosenOf.set(story.id, { photo: p, tier: memory.tier, shared: false });
    cache.set(`chosen:${story.id}`, memory);
    settled.add(story.id);
  }
  for (const story of stories) if (!settled.has(story.id)) await pick(story);

  // Every chosen photo is read against its story. A refusal is replaced with a topic photo, not another search.
  // Death stories keep their medical or confirmed photo. A cached yes expires when the reports change.
  const vetBudget = { requests: VET_REQUESTS, until: Date.now() + VET_MINUTES * 60_000 };
  for (let round = 0; round < VET_ROUNDS; round++) {
    const items = stories.filter((s) => !death.has(s.id) && chosenOf.has(s.id)).map((s) => {
      const photo = chosenOf.get(s.id)!.photo;
      return { story: s, photo, takenIn: photo.lat !== undefined && photo.lon !== undefined ? regionOf(photo.lat, photo.lon).replace("abroad", "outside Australia and New Zealand") : undefined };
    });
    counts.offPoint += await vetPhotos(items, cache, vetBudget);
    const redo = items.filter((i) => verdict(cache, i.story.id, i.photo, reportsMark(i.story)) === false).map((i) => i.story);
    if (!redo.length) break;
    for (const s of redo) {
      const file = fileOf(chosenOf.get(s.id)!.photo);
      chosenOf.delete(s.id);
      photos.delete(s.id);
      cache.delete(`chosen:${s.id}`);
      if (![...chosenOf.values()].some((c) => fileOf(c.photo) === file)) used.delete(file);
    }
    for (const s of redo) await pick(s, true);
  }
  for (const c of chosenOf.values()) {
    counts[c.tier]++;
    if (c.shared) counts.shared++;
  }

  await cache.save();
  return { photos, counts };
}
