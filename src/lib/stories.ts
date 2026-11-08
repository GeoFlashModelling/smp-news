import { createHash } from "node:crypto";
import { SECTIONS, toBarLean, type BarLean, type Section } from "../config/sources.js";
import { tokenize, type Cluster } from "./cluster.js";
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
  /** Free-licensed file photo (subject, place, setting or topic); when absent the story shows its section artwork. */
  photo?: Photo;
}

const SECTION_PRIORITY: readonly Section[] = ["local-wa", "australia", "politics", "world", "business", "science-tech", "sport", "entertainment", "feel-good"];
/**
 * A story's weight halves every 8 hours from its first report. Measured from the latest report instead, big stories
 * that some outlet keeps re-posting stayed on top for two days.
 */
const HALF_LIFE_HOURS = 8;
const INDEPENDENCE_WEIGHT = 1.2;

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

export function buildStory(cluster: Cluster, now: Date): Story {
  const items = [...cluster.items].sort((a, b) => b.published.getTime() - a.published.getTime());
  const reporting = items.filter((i) => i.source.content_type !== "opinion");
  const independent = new Set(reporting.map((i) => i.source.owner_group)).size;

  const coverage: Record<CoverageGroup, number> = { left: 0, centre: 0, right: 0, local: 0, official: 0, unrated: 0 };
  const counted = new Set<string>();
  for (const i of reporting) {
    const group = coverageGroup(i);
    const key = `${group}|${i.source.owner_group}`;
    if (counted.has(key)) continue;
    counted.add(key);
    coverage[group]++;
  }
  const rated = coverage.left + coverage.centre + coverage.right;
  const oneSided = rated >= 3 ? ((["left", "centre", "right"] as const).find((g) => coverage[g] === rated && g !== "centre") ?? null) : null;

  const ageHours = (now.getTime() - cluster.first.getTime()) / 3_600_000;
  const score = Math.pow(Math.max(independent, 1), INDEPENDENCE_WEIGHT) * Math.pow(0.5, Math.max(ageHours, 0) / HALF_LIFE_HOURS);
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
  };
}

export function buildStories(clusters: Cluster[], now: Date): Story[] {
  return clusters.map((c) => buildStory(c, now)).sort((a, b) => b.score - a.score);
}

export interface FrontPage {
  top: Story[];
  bySection: Map<Section, Story[]>;
}

/** Top-story slots reserved for Australian and WA stories, so world news can't crowd them out. */
const HOME_SECTIONS: readonly Section[] = ["australia", "local-wa"];
const HOME_SLOTS = 4;

/** Single-report headlines listed on each section page (the front page lists fewer). */
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

/** Top stories (multi-source only) with caps on Feel Good and Entertainment, plus every story by section. */
export function frontPage(stories: Story[], size = 12): FrontPage {
  const multi = stories.filter((s) => s.independent >= 2);
  const top: Story[] = [];
  const caps: Partial<Record<Section, number>> = { "feel-good": 3, entertainment: 1, sport: 2 };
  const fits = (s: Story) => {
    const cap = caps[s.section];
    return !top.includes(s) && (cap === undefined || top.filter((t) => t.section === s.section).length < cap);
  };
  for (const s of multi.filter((s) => HOME_SECTIONS.includes(s.section)).slice(0, HOME_SLOTS)) top.push(s);
  for (const s of multi) {
    if (top.length >= size) break;
    if (fits(s)) top.push(s);
  }
  top.sort((a, b) => b.score - a.score);
  const bySection = new Map<Section, Story[]>(SECTIONS.map((sec) => [sec, stories.filter((s) => s.section === sec)]));
  return { top, bySection };
}
