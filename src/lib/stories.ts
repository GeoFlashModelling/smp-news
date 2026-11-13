import { createHash } from "node:crypto";
import { isLocal, LOCAL_SECTIONS, SECTIONS, toBarLean, type BarLean, type LocalSection, type Section, type Source } from "../config/sources.js";
import { tokenize, type Cluster } from "./cluster.js";
import { isLegalRisk } from "../ai/legal-risk.js";
import type { StoryWriteup } from "../ai/summarise.js";
import type { Photo } from "../images/wikimedia.js";
import type { Item } from "./normalise.js";

export type CoverageGroup = BarLean | "local" | "official" | "unrated";

export interface Story {
  id: string;
  section: Section;
  headline: Item;
  items: Item[];
  /** Distinct owner groups among non-opinion items: the independence count used for ranking and the bar. */
  independent: number;
  coverage: Record<CoverageGroup, number>;
  /** Set when 3+ independent lean-rated owners cover the story and all sit on one side. */
  oneSided: BarLean | null;
  first: Date;
  last: Date;
  score: number;
  /** Distinct owner groups among major Australian outlets (sources marked `agenda`) reporting the story. */
  agenda: number;
  /** How prominently major outlets' homepages carry the story: per owner group, 1 at the top falling to 0 at FRONT_DEPTH. */
  front: number;
  /** Order for top stories and story cards: what the major Australian outlets are leading with, then breadth and age. */
  lead: number;
  /** Free-licensed file photo (subject, place, setting or topic); when absent the story shows its section artwork. */
  photo?: Photo;
  /** AI summary that passed the support check; absent for court/crime stories and while none is available. */
  writeup?: StoryWriteup;
}

const SECTION_PRIORITY: readonly Section[] = [...LOCAL_SECTIONS, "australia", "new-zealand", "politics", "world", "business", "tech", "science-tech", "sport", "entertainment", "feel-good"];
/**
 * A story's weight halves every 8 hours from its first report. Measured from the latest report instead, big stories
 * that some outlet keeps re-posting stayed on top for two days.
 */
const HALF_LIFE_HOURS = 8;
const INDEPENDENCE_WEIGHT = 1.2;
/**
 * Top stories follow the major Australian outlets: a story three of their owner groups are running outranks one that
 * twenty overseas outlets cover but no Australian one does. Breadth of coverage still breaks ties.
 */
const AGENDA_WEIGHT = 1.5;
/**
 * Being high on a major outlet's homepage counts for more than merely being published by it: every outlet's "latest"
 * feed carries wire stories it doesn't lead with. Each owner group adds up to FRONT_WEIGHT, falling to nothing at
 * position FRONT_DEPTH of its top-stories feed.
 */
const FRONT_WEIGHT = 2;
const FRONT_DEPTH = 20;
/** Beyond this many owner groups, more coverage doesn't lift a story: twenty overseas outlets on a wire story shouldn't outrank Australia's lead. */
const LEAD_BREADTH_CAP = 5;

export function coverageGroup(item: Item): CoverageGroup {
  const s = item.source;
  if (s.content_type === "official") return "official";
  if (s.content_type === "community") return "local";
  return s.lean === null ? "unrated" : toBarLean(s.lean);
}

function storyId(items: Item[]): string {
  const earliest = items.reduce((a, b) => (b.published < a.published ? b : a));
  return createHash("sha256").update(earliest.key).digest("base64url").replace(/[-_]/g, "").slice(0, 10).toLowerCase();
}

const SPORT_WORDS =
  /\b(AFLW?|NRLW?|cricket|Test match|rugby|A-League|Matildas|Socceroos|Wallabies|Kangaroos|Kiwi Ferns|World Cup|grand final|footy|tennis|Wimbledon|Olympics?|netball|golf|F1|Formula One|Grand Prix|premiership|ODI|T20|Ashes|Super Rugby|NBA|NFL|Brownlow|WTA|ATP|Premier League|Champions League|Melbourne Cup|jockey)\b/i;
const WA_PLACES =
  /\b(WA|W\.A\.|Western Australian?|Perth|Fremantle|Mandurah|Bunbury|Joondalup|Rockingham|Kalgoorlie|Geraldton|Broome|Karratha|Port Hedland|South Hedland|Pilbara|Kimberley|Goldfields|Esperance|Busselton|Margaret River|Margs|Armadale|Cockburn|Wanneroo|Albany|Great Southern(?! Bank)|Wheatbelt|Narrogin|Kununurra|Dunsborough|Yallingup|Ningaloo|Rottnest|Nedlands|Subiaco|Cottesloe|Floreat|Joondanna|Yanchep|Kwinana|Ellenbrook|Baldivis|Gidgegannup|Toodyay|Wiluna|Swan River|Kings Park|Optus Stadium|WACA|WAFL|Scorchers|Wildcats|West Coast Eagles|Dockers|Roger Cook)\b/;
/** "WA" alone also abbreviates Washington state ("Everett, WA"), so in American outlets' reports only a named WA place counts. */
function namesWa(item: Item, text: string): boolean {
  return WA_PLACES.test(item.source.region_of_rating === "US" ? text.replace(/\bW\.?A\.?(?![\w.])/g, "") : text);
}
/**
 * Places, leaders and institutions that make a story local to the other states and territories. Names shared with
 * other countries or federal politics are left out or fenced off: Newcastle United, Victoria Beckham, Charles Darwin,
 * Palmerston North, and "Canberra", which usually means the federal government.
 */
const STATE_PLACES: Record<Exclude<LocalSection, "local-wa">, RegExp> = {
  "local-nsw":
    /\b(NSW|New South Wales|Sydney(siders)?|Newcastle(?! United| upon)|Wollongong|Illawarra|Shoalhaven|Parramatta|Penrith|Blacktown|Bankstown|Chatswood|Lane Cove|Bondi|Manly|Cronulla|Central Coast|Hunter Valley|Blue Mountains|Byron Bay|Northern Rivers|Lismore|Tamworth|Dubbo|Wagga Wagga|Albury|Coffs Harbour|Port Macquarie|Broken Hill|Minns government|Chris Minns)\b/,
  "local-vic":
    /\b(Victoria(?! Beckham| Cross| Park|, B\.?C\.?| Falls)|Victorians?(?![- ](era|England|London|Britain|times|novels?|Gothic|age|literature|values))|Melbourne|Geelong|Ballarat|Bendigo|Shepparton|Mildura|Gippsland|Mornington Peninsula|Dandenong|Frankston|Footscray|Werribee|Wodonga|Warrnambool|Walhalla|Allan government|Jacinta Allan|Spring Street|VCAA|Big Build)\b/,
  "local-qld":
    /\b(Queensland(ers?)?|QLD|Brisbane|Gold Coast|Sunshine Coast|Cairns|Townsville|Toowoomba|Rockhampton|Mackay|Bundaberg|Moreton Bay|Gympie|Hervey Bay|Noosa|Whitsundays?|Mount Isa|Crisafulli)\b/,
  "local-sa":
    /\b(South Australian?s?|Adelaide|Mount Gambier|Whyalla|Port Augusta|Port Lincoln|Murray Bridge|Barossa|McLaren Vale|Kangaroo Island|Glenelg|Fleurieu|Riverland|Malinauskas)\b/,
  "local-tas":
    /\b(Tasmanian?s?|Tassie|Hobart|Launceston|Devonport|Burnie|Huon Valley|Bruny Island|Cradle Mountain|Port Arthur|Fingal Valley|Rockliff)\b/,
  "local-act":
    /\b(ACT (government|Policing|Legislative Assembly|Health|Labor|Greens|Liberals|Supreme Court|Magistrates Court)|Canberra Liberals|Canberrans|Andrew Barr|Barr government|Belconnen|Tuggeranong|Woden|Gungahlin|Weston Creek|Molonglo|Canberra Hospital|in the ACT)\b/,
  "local-nt":
    /\b(Northern Territory|NT|Territorians?|(?<!Charles )Darwin(?!'s|ian|ism| was| (believed|wrote|thought|argued|famously|himself))|Alice Springs|Tennant Creek|Arnhem Land|Kakadu|Uluru|Palmerston(?! North)|Groote Eylandt|Tiwi Islands|Finocchiaro)\b/,
};
/** Whether an item names places in the state a local section covers. */
function namesState(section: LocalSection, item: Item, text: string): boolean {
  return section === "local-wa" ? namesWa(item, text) : STATE_PLACES[section].test(text);
}
/**
 * Share of a story's reports naming one state's places that makes it that state's local news.
 * 0.5 left a Victorian search in Australia: 0.43 of its reports name Victoria. 0.33 would file a national
 * Beaconsfield feature as New South Wales. Sport is decided before this, so a match stays in Sport.
 */
const STATE_SHARE = 0.4;
/** The same places in a web address ("…/declining-humpback-numbers-western-australia"), where case says nothing. */
const WA_PLACES_ANY_CASE = new RegExp(WA_PLACES.source, "i");
/** Web addresses of WA local pages: PerthNow's /wa/ and community pages, WAtoday's WA pages, The West's WA and regional mastheads. */
const WA_PATH =
  /^\/(wa|community-news|national\/western-australia|countryman)\/|^\/news\/(wa|perth|regional|pilbara|south-west|great-southern-herald|albany-advertiser|south-western-times|kalgoorlie-miner|geraldton-guardian|narrogin-observer|busselton-dunsborough-times|the-kimberley-echo|broome-advertiser|north-west-telegraph|augusta-margaret-river-times|harvey-waroona-reporter|manjimup-bridgetown-times|bunbury-herald|avon-valley-advocate|midwest-times|pilbara-news)\//;
/** Sections given away by the web address, for items from WA outlets' feeds that carry every kind of news. */
const PATH_SECTIONS: readonly [RegExp, Section][] = [
  [/^\/news\/world\//, "world"],
  [/^\/news\/politics\/federal-politics\//, "politics"],
];
/**
 * Topics given away by a folder in the web address ("/sport/tennis/…", "/life/people/celebrity/…", "/business/…").
 * They decide for items whose feed is labelled only with places (World, Australia, ...): an outlet's world or
 * "latest" feed carries its sport, celebrity and business stories too (12 Nov 2026: WTA Finals, Harry Kane and
 * Nvidia under World).
 */
const TOPIC_PATHS: readonly [RegExp, Section][] = [
  [/\/(sport|sports)\//, "sport"],
  // Not "/tv/": the Independent files its news videos there.
  [/\/(entertainment|celebrity|celebrity-gossip|showbiz|movies|film|music|books|royals)\//, "entertainment"],
  [/\/(business|markets|companies|money)\//, "business"],
  [/\/(tech|technology)\//, "tech"],
  [/\/science\//, "science-tech"],
];
/** New Zealand is left out: its outlets' business and media stories belong in the New Zealand section on an Australian site. */
const PLACE_SECTIONS: ReadonlySet<Section> = new Set(["world", "australia", ...LOCAL_SECTIONS]);

function pathOf(url: string): string {
  try {
    return new URL(url).pathname.toLowerCase();
  } catch {
    return "";
  }
}
const AU_PLACES =
  /\b(Australia|Australians?|Aussies?|Sydney|Melbourne|Brisbane|Adelaide|Hobart|Darwin|Canberra|Gold Coast|NSW|Victorian?|Queensland(ers)?|Tasmanian?|Albanese|Parliament House)\b/;
/** Unambiguous New Zealand places and names; Canterbury, Nelson and Hastings are left out because Australia and the UK have them too. */
const NZ_PLACES =
  /\b(New Zealand(ers?)?|NZ|Aotearoa|Kiwis|Auckland|Wellington|Christchurch|Dunedin|Tauranga|Rotorua|Queenstown|Invercargill|Palmerston North|Whang[aā]rei|New Plymouth|Napier|Gisborne|Waikato|Otago|Northland|Taranaki|Hawke's Bay|Bay of Plenty|Southland|Wairarapa|Coromandel|M[aā]ori|Waitangi|Luxon|Hipkins)\b/;

/** Feeds labelled with many sections (an outlet's "all news" feed) say little about any one item. */
const MAX_INFORMATIVE_SECTIONS = 2;

/**
 * An item's sections. The WA outlets' feeds are labelled Local WA, but they also carry national and world news,
 * celebrity gossip and eastern-states sport (Community News republishes PerthNow's whole site), so a Local WA label
 * counts only when the item names a WA place or sits on a WA local page; otherwise its web address or the feed's
 * other labels decide, and Australia when neither does (12 Nov 2026: 25 of 62 Local WA stories weren't WA news).
 * The other states' local feeds (ABC city feeds, community papers) carry little else, so their label counts unless
 * the report names another state and not their own.
 */
function itemSections(item: Item, text: string): readonly Section[] {
  const path = pathOf(item.url);
  const topic = TOPIC_PATHS.find(([re]) => re.test(path))?.[1];
  const locals = item.sections.filter(isLocal);
  const named = (s: LocalSection) => namesState(s, item, text);
  if (locals.every(named)) return topic && item.sections.every((s) => PLACE_SECTIONS.has(s)) ? [topic] : item.sections;
  const kept = locals.filter((s) => {
    if (named(s)) return true;
    if (s === "local-wa") return WA_PATH.test(path) || WA_PLACES_ANY_CASE.test(path.replace(/[-/]/g, " "));
    return !LOCAL_SECTIONS.some((other) => other !== s && named(other));
  });
  if (kept.length) return kept;
  const byPath = topic ?? PATH_SECTIONS.find(([re]) => re.test(path))?.[1];
  if (byPath) return [byPath];
  const rest = item.sections.filter((s) => !isLocal(s));
  return rest.length ? rest : ["australia"];
}

function pickSection(items: Item[]): Section {
  const texts = items.map((i) => `${i.title} ${i.summary.slice(0, 200)}`);
  const share = (re: RegExp) => texts.filter((t) => re.test(t)).length / items.length;
  const labelled = items.map((i, n) => ({ sections: itemSections(i, texts[n]!) }));
  const informative = labelled.filter((i) => i.sections.length <= MAX_INFORMATIVE_SECTIONS);
  const counts = new Map<Section, number>();
  for (const i of informative.length ? informative : labelled) for (const s of i.sections) counts.set(s, (counts.get(s) ?? 0) + 1 / i.sections.length);
  // Sport pages and sport-only feeds keep a club's story in Sport, not its state's local news ("Parramatta Eels…").
  // A sport word alone does not: a golf-club disclosure is politics, and a world story that mentions a club stays in World.
  const sportOnly = labelled.filter((l) => l.sections.length === 1 && l.sections[0] === "sport").length / items.length;
  const sportCount = counts.get("sport") ?? 0;
  const sportWordOnly =
    sportOnly < 0.5 &&
    ((counts.get("politics") ?? 0) > sportCount || (counts.get("business") ?? 0) > sportCount || (sportCount === 0 && (counts.get("world") ?? 0) > 0));
  if ((share(SPORT_WORDS) >= 0.4 || sportOnly >= 0.5) && !sportWordOnly) return "sport";
  if (items.filter((item, n) => namesWa(item, texts[n]!)).length / items.length >= 0.3) return "local-wa";
  // Trans-Tasman stories go to whichever country the reports name more often.
  if (share(NZ_PLACES) >= 0.3 && share(NZ_PLACES) > share(AU_PLACES)) return "new-zealand";
  // Another state's local news when most reports name its places and no other state comes close.
  const states = (Object.keys(STATE_PLACES) as (keyof typeof STATE_PLACES)[]).map((s) => [s, share(STATE_PLACES[s])] as const).sort((a, b) => b[1] - a[1]);
  if (states[0]![1] >= STATE_SHARE && states[0]![1] > states[1]![1]) return states[0]![0];

  let best: Section = labelled[0]?.sections[0] ?? "world";
  for (const s of SECTION_PRIORITY) if ((counts.get(s) ?? 0) > (counts.get(best) ?? 0)) best = s;

  if (isLocal(best) && items.length > 1) best = "australia";
  if (best === "world" && share(AU_PLACES) >= 0.3) best = "australia";
  // A company story carried half by a business page and half by World or Australia was landing in the place
  // section (David Jones in Australia, an RBA rates note in World). When those labels are level, it is Business.
  const business = counts.get("business") ?? 0;
  if ((best === "world" || best === "australia") && business > 0 && business === (counts.get(best) ?? 0)) best = "business";
  return best;
}

const LEAN_BONUS: Record<CoverageGroup, number> = { centre: 1.15, left: 1, right: 1, local: 1, unrated: 0.9, official: 0.6 };

/**
 * The headline shown for the story: the most representative one (its words appear in the most other headlines),
 * from a non-opinion, non-paywalled outlet where possible, with a slight preference for centre-rated outlets.
 */
function pickHeadline(items: Item[]): Item {
  const tokens = items.map((i) => new Set(tokenize(i.title)));
  const df = new Map<string, number>();
  for (const set of tokens) for (const t of set) df.set(t, (df.get(t) ?? 0) + 1);
  let best = items[0]!;
  let bestScore = -1;
  items.forEach((item, n) => {
    const set = tokens[n]!;
    if (set.size === 0) return;
    let shared = 0;
    for (const t of set) shared += (df.get(t) ?? 1) - 1;
    const penalty = (item.source.content_type === "opinion" ? 0.5 : 1) * (item.source.paywall === "paywalled" ? 0.7 : 1);
    const score = (shared / Math.sqrt(set.size)) * penalty * LEAN_BONUS[coverageGroup(item)];
    if (score > bestScore) {
      best = item;
      bestScore = score;
    }
  });
  return best;
}

const CENTRAL_FIRST: readonly CoverageGroup[] = ["centre", "left", "right", "local", "unrated", "official"];

export function buildStory(cluster: Cluster, now: Date): Story {
  const items = [...cluster.items].sort((a, b) => b.published.getTime() - a.published.getTime());
  const reporting = items.filter((i) => i.source.content_type !== "opinion");
  const independent = new Set(reporting.map((i) => i.source.owner_group)).size;

  const coverage: Record<CoverageGroup, number> = { left: 0, centre: 0, right: 0, local: 0, official: 0, unrated: 0 };
  // One vote per owner group (7News and The West share copy), cast for the lean most of its reports in the story
  // have; on a tie, the more central one.
  const byOwner = new Map<string, Map<CoverageGroup, number>>();
  for (const i of reporting) {
    const groups = byOwner.get(i.source.owner_group) ?? new Map<CoverageGroup, number>();
    groups.set(coverageGroup(i), (groups.get(coverageGroup(i)) ?? 0) + 1);
    byOwner.set(i.source.owner_group, groups);
  }
  for (const groups of byOwner.values()) {
    const vote = [...groups].sort(([a, na], [b, nb]) => nb - na || CENTRAL_FIRST.indexOf(a) - CENTRAL_FIRST.indexOf(b))[0]![0];
    coverage[vote]++;
  }
  const rated = coverage.left + coverage.centre + coverage.right;
  const oneSided = rated >= 3 ? ((["left", "centre", "right"] as const).find((g) => coverage[g] === rated && g !== "centre") ?? null) : null;

  const ageHours = (now.getTime() - cluster.first.getTime()) / 3_600_000;
  const decay = Math.pow(0.5, Math.max(ageHours, 0) / HALF_LIFE_HOURS);
  const score = Math.pow(Math.max(independent, 1), INDEPENDENCE_WEIGHT) * decay;
  const agenda = new Set(reporting.filter((i) => i.source.agenda).map((i) => i.source.owner_group)).size;
  const prominence = new Map<string, number>();
  for (const i of reporting) {
    if (i.frontRank === undefined || !i.source.agenda) continue;
    const p = Math.max(0, 1 - i.frontRank / FRONT_DEPTH);
    prominence.set(i.source.owner_group, Math.max(prominence.get(i.source.owner_group) ?? 0, p));
  }
  const front = [...prominence.values()].reduce((a, b) => a + b, 0);
  const lead = Math.pow(1 + agenda + FRONT_WEIGHT * front, AGENDA_WEIGHT) * Math.sqrt(Math.min(Math.max(independent, 1), LEAD_BREADTH_CAP)) * decay;
  return {
    id: storyId(items),
    section: pickSection(items),
    headline: pickHeadline(items),
    items,
    independent,
    coverage,
    oneSided,
    first: cluster.first,
    last: cluster.last,
    score,
    agenda,
    front,
    lead,
  };
}

export function buildStories(clusters: Cluster[], now: Date): Story[] {
  return clusters.map((c) => buildStory(c, now)).sort((a, b) => b.score - a.score);
}

export interface FrontPage {
  /** What's hot: led by Local WA, then Australia, then the world. */
  top: Story[];
  /** The last of the top stories: an uplifting or curious one to finish on ("And finally"). */
  finale: Story | null;
  /** Single-outlet stories high on a major outlet's homepage: what the big sites lead with that no one else has yet. */
  alsoLeading: Story[];
  /** Less prominent stories worth reading: science, good news, tech, business and entertainment, one per outlet. */
  interesting: Story[];
  bySection: Map<Section, Story[]>;
}

/** Celebrity and reality-TV gossip. A trending one or two is news; a page of them is a gossip magazine. */
const GOSSIP =
  /\b(Kardashians?|Jenners?|Biebers?|Kanye|Meghan Markle|Prince Harry|Harry and Meghan|reality (TV )?stars?|MAFS|Married at First Sight|The Bachelor(ette)?|Bachelor in Paradise|Love Island|I'm a Celeb\w*|Big Brother|red carpet|bikini|flaunts?|stuns? in|sizzl\w+|jaw-dropping|racy|steamy|loved-up|PDA|split rumours?|engagement ring|baby bump|wardrobe malfunction|plastic surgery|cosmetic surgery|influencers?|TikTok star|celebrit(y|ies)|celebs?|A-lister|socialite|dating rumours?)\b/i;
const GOSSIP_SHARE = 0.3;
/** Gossip stories allowed among the top stories, in "Also in the headlines", and in each section's list. */
const GOSSIP_TOP = 1;
const GOSSIP_PER_LIST = 2;

export function isGossip(story: Story): boolean {
  const hits = story.items.filter((i) => GOSSIP.test(`${i.title} ${i.summary.slice(0, 200)}`)).length;
  return hits / story.items.length >= GOSSIP_SHARE;
}

/** Product round-ups ("6 Best Touchscreen Gloves (2026)", "The best robot vacuums to buy"): fine in a section list, not as news. */
const BUYERS_GUIDE =
  /^\d+ best\b|^the \d+ best\b|^(the )?best [\w\s'’-]{1,50}\b(to buy|you can buy|right now|for (every|most) \w+)\b|\b(buying guide|gift guide|we tested|tested and rated)\b|\(20\d\d\)\s*$/i;

export function isBuyersGuide(story: Story): boolean {
  return BUYERS_GUIDE.test(story.headline.title);
}

/** Keeps at most `max` gossip stories in a list, in order. */
function limitGossip(list: Story[], max: number): Story[] {
  let n = 0;
  return list.filter((s) => !isGossip(s) || n++ < max);
}

const INTERESTING_SECTIONS: readonly Section[] = ["science-tech", "feel-good", "tech", "business", "entertainment"];
/** "Worth a look" is for curiosity, not more hard news. */
const HARD_NEWS = /\b(kill(s|ed|ing)?|dead|deaths?|died|attack(s|ed)?|strikes?|war|bomb(s|ing)?|missiles?|shooting|stabbing|crash(es|ed)?|murder(ed)?|terror\w*|hostages?)\b/i;
const INTERESTING = 6;
const INTERESTING_MAX_AGE_HOURS = 36;

/** Homepage positions (0-based) that count as "leading with", and how many such headlines the front page lists. */
const LEADING_RANK = 6;
const ALSO_LEADING = 3;

/** NASA, Phys.org, ScienceAlert and the like: every feed is science. General outlets' science feeds don't count. */
function isScienceSource(source: Source): boolean {
  return source.feeds.every((f) => f.sections.every((s) => s === "science-tech"));
}

/**
 * What's hot, in the reader's order: Local WA (readers are in Perth) gets WA_SLOTS, Australian news (including federal
 * politics) fills up to HOME_SLOTS, then the rest by prominence with world stories capped, since Australian outlets
 * lead mostly with Australian news.
 */
const HOME_SECTIONS: readonly Section[] = ["australia", "politics", ...LOCAL_SECTIONS];
const HOME_SLOTS = 5;
const WA_SLOTS = 2;
/** The lead story plus a full 3-by-3 grid on desktop (owner, 10 Nov 2026). */
const TOP_STORIES = 10;

/** Each section on the front page: written stories, then links to more. */
export const SECTION_WRITTEN = 6;
export const SECTION_LINKS = 3;

/** Single-outlet stories from any one outlet among a section's written stories, so one prolific outlet can't fill it. */
const SINGLES_PER_OUTLET = 2;

/** A section's written stories on the front page: the first `SECTION_WRITTEN` that `ok` accepts, outside the top stories. */
export function sectionCards(list: Story[], top: Story[], ok: (s: Story) => boolean): Story[] {
  const perOutlet = new Map<string, number>();
  const cards: Story[] = [];
  for (const s of list) {
    if (cards.length >= SECTION_WRITTEN) break;
    if (top.includes(s) || !ok(s)) continue;
    if (s.independent < 2) {
      const n = perOutlet.get(s.headline.source.id) ?? 0;
      if (n >= SINGLES_PER_OUTLET) continue;
      perOutlet.set(s.headline.source.id, n + 1);
    }
    cards.push(s);
  }
  // Last resort: a thin section is filled from the same outlets rather than left short.
  for (const s of list) {
    if (cards.length >= SECTION_WRITTEN) break;
    if (!top.includes(s) && !cards.includes(s) && ok(s)) cards.push(s);
  }
  return cards;
}

/** Single-report headlines listed on each section page. */
export const SECTION_HEADLINES = 60;

/** Stories that appear somewhere on the site: every multi-source story, and each section's top single-report headlines. */
export function shownStories(stories: Story[]): Story[] {
  const singles = new Map<Section, number>();
  return stories.filter((s) => {
    if (s.independent >= 2) return true;
    const n = singles.get(s.section) ?? 0;
    singles.set(s.section, n + 1);
    return n < SECTION_HEADLINES;
  });
}

/**
 * Built in the reader's order. First what's hot: top stories (multi-source only) led by what the major Australian
 * outlets are running, with Local WA and Australian slots reserved, one science story kept, caps on lighter sections
 * and on gossip; then what the big sites lead with that only one outlet has; then less prominent stories worth
 * reading. Each section lists its multi-source stories in the same order, then its single-report headlines.
 */
export function frontPage(stories: Story[], now: Date, writable: (s: Story) => boolean = () => true, size = TOP_STORIES - 1): FrontPage {
  const multi = stories.filter((s) => s.independent >= 2).sort((a, b) => b.lead - a.lead);
  const top: Story[] = [];
  const caps: Partial<Record<Section, number>> = { "feel-good": 1, entertainment: 1, sport: 2, "science-tech": 2, tech: 2, world: 3, "new-zealand": 1 };
  const fits = (s: Story) => {
    const cap = caps[s.section];
    if (isGossip(s) && top.filter(isGossip).length >= GOSSIP_TOP) return false;
    return !top.includes(s) && !isBuyersGuide(s) && (cap === undefined || top.filter((t) => t.section === s.section).length < cap);
  };
  for (const s of multi.filter((s) => s.section === "local-wa" && fits(s)).slice(0, WA_SLOTS)) top.push(s);
  for (const s of multi.filter((s) => HOME_SECTIONS.includes(s.section) && fits(s)).slice(0, HOME_SLOTS - top.length)) top.push(s);
  const science = multi.find((s) => s.section === "science-tech" && s.items.some((i) => isScienceSource(i.source)));
  for (const s of multi) {
    if (top.length >= size - (science && !top.includes(science) ? 1 : 0)) break;
    if (fits(s)) top.push(s);
  }
  if (science && !top.includes(science)) top.push(science);
  top.sort((a, b) => b.lead - a.lead);
  const finale = andFinally(stories, top, now.getTime(), writable);
  if (finale) top.push(finale);
  else {
    // No closing story: another top story keeps the grid full.
    const next = multi.find(fits);
    if (next) top.push(next);
  }
  const bySection = new Map<Section, Story[]>(
    SECTIONS.map((sec) => {
      const inSection = stories.filter((s) => s.section === sec);
      const byLead = (a: Story, b: Story) => b.lead - a.lead;
      return [sec, limitGossip([...inSection.filter((s) => s.independent >= 2).sort(byLead), ...inSection.filter((s) => s.independent < 2).sort(byLead)], GOSSIP_PER_LIST)];
    }),
  );
  const alsoLeading = limitGossip(
    stories
      .filter((s) => s.independent < 2 && s.items.some((i) => i.source.agenda && i.source.content_type !== "opinion" && (i.frontRank ?? Infinity) < LEADING_RANK))
      .sort((a, b) => b.lead - a.lead),
    GOSSIP_TOP,
  ).slice(0, ALSO_LEADING);
  return { top, finale, alsoLeading, interesting: worthALook(stories, new Set([...top, ...alsoLeading]), now.getTime()), bySection };
}

/** Sections the closing story comes from, in order of preference. */
const FINALE_SECTIONS: readonly Section[] = ["feel-good", "science-tech", "local-wa", "australia", "entertainment"];
const FINALE_MAX_AGE_HOURS = 24;

/**
 * The closing top story, like the heart-warming one at the end of the nightly news: uplifting or simply interesting,
 * often not widely reported. No hard news, court or crime, gossip or opinion; must be one we can write up.
 */
function andFinally(stories: Story[], top: Story[], at: number, writable: (s: Story) => boolean): Story | null {
  const ok = (s: Story) =>
    !top.includes(s) &&
    at - s.first.getTime() <= FINALE_MAX_AGE_HOURS * 3_600_000 &&
    s.headline.source.content_type !== "opinion" &&
    !isGossip(s) &&
    !isBuyersGuide(s) &&
    !isLegalRisk(s.items) &&
    !HARD_NEWS.test(s.headline.title) &&
    writable(s);
  for (const sec of FINALE_SECTIONS) {
    // Outside Feel Good, only stories from uplifting outlets or plainly good-news headlines qualify.
    const pool = stories.filter((s) => s.section === sec && ok(s) && (sec === "feel-good" || sec === "science-tech" || UPLIFTING.test(s.headline.title)));
    const best = pool.sort((a, b) => b.score - a.score)[0];
    if (best) return best;
  }
  return null;
}

const UPLIFTING = /\b(rescued?|saved?|reunit\w*|heart-?warming|kindness|volunteers?|donat\w*|celebrat\w*|record-breaking|first-ever|milestone|centenarian|100th birthday|good news|hero(es)?|bravery|inspir\w*|surviv\w*|recover\w*|adopt\w*)\b/i;

/**
 * Less prominent stories worth reading, taken in turn from science, good news, tech, business and entertainment
 * (newest-weighted within each), one per outlet; no gossip, opinion, or court and crime stories.
 */
function worthALook(stories: Story[], taken: Set<Story>, at: number): Story[] {
  const pools = INTERESTING_SECTIONS.map((sec) =>
    stories
      .filter((s) => s.section === sec && !taken.has(s) && !isGossip(s) && !isBuyersGuide(s) && s.headline.source.content_type !== "opinion" && !isLegalRisk(s.items) && !HARD_NEWS.test(s.headline.title))
      .filter((s) => at - s.first.getTime() <= INTERESTING_MAX_AGE_HOURS * 3_600_000)
      .sort((a, b) => b.score - a.score),
  );
  const picked: Story[] = [];
  const outlets = new Set<string>();
  for (let round = 0; picked.length < INTERESTING && pools.some((p) => p.length); round++) {
    for (const pool of pools) {
      while (pool.length && outlets.has(pool[0]!.headline.source.id)) pool.shift();
      const s = pool.shift();
      if (!s || picked.length >= INTERESTING) continue;
      picked.push(s);
      outlets.add(s.headline.source.id);
    }
  }
  return picked;
}
