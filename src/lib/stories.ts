import { createHash } from "node:crypto";
import { SECTIONS, toBarLean, type BarLean, type Section, type Source } from "../config/sources.js";
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

const SECTION_PRIORITY: readonly Section[] = ["local-wa", "australia", "politics", "world", "business", "tech", "science-tech", "sport", "entertainment", "feel-good"];
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
  /\b(AFLW?|NRLW?|cricket|Test match|rugby|A-League|Matildas|Socceroos|Wallabies|Kangaroos|Kiwi Ferns|World Cup|grand final|footy|tennis|Wimbledon|Olympics?|netball|golf|F1|Formula One|Grand Prix|premiership|ODI|T20|Ashes|Super Rugby|NBA|NFL|Brownlow)\b/i;
const WA_PLACES =
  /\b(WA|W\.A\.|Western Australian?|Perth|Fremantle|Mandurah|Bunbury|Joondalup|Rockingham|Kalgoorlie|Geraldton|Broome|Karratha|Port Hedland|Pilbara|Kimberley|Goldfields|Esperance|Busselton|Margaret River|Armadale|Cockburn|Wanneroo)\b/;
const AU_PLACES =
  /\b(Australia|Australians?|Aussies?|Sydney|Melbourne|Brisbane|Adelaide|Hobart|Darwin|Canberra|Gold Coast|NSW|Victorian?|Queensland(ers)?|Tasmanian?|Albanese|Parliament House)\b/;

/** Feeds labelled with many sections (an outlet's "all news" feed) say little about any one item. */
const MAX_INFORMATIVE_SECTIONS = 2;

function pickSection(items: Item[]): Section {
  const texts = items.map((i) => `${i.title} ${i.summary.slice(0, 200)}`);
  const share = (re: RegExp) => texts.filter((t) => re.test(t)).length / items.length;
  if (share(SPORT_WORDS) >= 0.4) return "sport";
  if (share(WA_PLACES) >= 0.3) return "local-wa";

  const informative = items.filter((i) => i.sections.length <= MAX_INFORMATIVE_SECTIONS);
  const counts = new Map<Section, number>();
  for (const i of informative.length ? informative : items) for (const s of i.sections) counts.set(s, (counts.get(s) ?? 0) + 1 / i.sections.length);
  let best: Section = items[0]?.sections[0] ?? "world";
  for (const s of SECTION_PRIORITY) if ((counts.get(s) ?? 0) > (counts.get(best) ?? 0)) best = s;

  if (best === "local-wa" && items.length > 1) best = "australia";
  if (best === "world" && share(AU_PLACES) >= 0.3) best = "australia";
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
const HOME_SECTIONS: readonly Section[] = ["australia", "local-wa", "politics"];
const HOME_SLOTS = 5;
const WA_SLOTS = 2;
const TOP_STORIES = 9;

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
  const caps: Partial<Record<Section, number>> = { "feel-good": 1, entertainment: 1, sport: 2, "science-tech": 2, tech: 2, world: 3 };
  const fits = (s: Story) => {
    const cap = caps[s.section];
    if (isGossip(s) && top.filter(isGossip).length >= GOSSIP_TOP) return false;
    return !top.includes(s) && (cap === undefined || top.filter((t) => t.section === s.section).length < cap);
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
      .filter((s) => s.section === sec && !taken.has(s) && !isGossip(s) && s.headline.source.content_type !== "opinion" && !isLegalRisk(s.items) && !HARD_NEWS.test(s.headline.title))
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
