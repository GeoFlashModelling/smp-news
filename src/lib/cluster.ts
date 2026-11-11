import type { Item } from "./normalise.js";

/**
 * Lexical event clustering: TF-IDF over headline (+ description where allowed), greedy assignment to the most
 * similar cluster centroid. Comparing with the centroid rather than any single member stops topic chaining
 * ("midterms" pulling in a dozen separate events). Headline-only sources are matched on their headline alone.
 */

export interface Cluster {
  items: Item[];
  first: Date;
  last: Date;
}

export interface ClusterOptions {
  /** Minimum cosine similarity to join a cluster. */
  threshold: number;
  /** Maximum hours between an item and the cluster's newest item. */
  windowHours: number;
  /** Keep headlines naming different states or regions apart (`REGIONS`), and different countries (`COUNTRIES`). */
  separateRegions?: boolean;
  /**
   * A report whose headline names people, companies or places, none of them in the story's headlines, doesn't join it
   * ("MC Mining appoints new directors" and "News Corp appoints new directors").
   */
  useNames?: boolean;
  /**
   * Optional lower threshold for a report sharing two names the story keeps returning to. Off by default: tested
   * 11 Nov 2026, it chained nine different Hong Kong stories and three Elon Musk stories (a shared name is usually
   * the same topic, not the same event).
   */
  namedThreshold?: number;
}

export const DEFAULT_CLUSTER_OPTIONS: ClusterOptions = { threshold: 0.32, windowHours: 36, separateRegions: true, useNames: true };

type Vec = Map<string, number>;

const STOPWORDS = new Set(
  (
    "a about above after again against all also am an and any are as at be because been before being below between both but by " +
    "can could did do does doing down during each few for from further had has have having he her here hers herself him himself " +
    "his how i if in into is it its itself just me more most my myself no nor not now of off on once only or other our ours out " +
    "over own same she should so some such than that the their theirs them themselves then there these they this those through to " +
    "too under until up very was we were what when where which while who whom why will with would you your yours yourself " +
    "says said say new news latest live update updates watch video photos week year years day days today yesterday tomorrow " +
    "first last one two three four five people man woman men women report reports australia australian world amid after over " +
    "could may might must get gets got make makes made take takes took back still big time times way ways like just " +
    // Dates: daily columns ("Market update for Tuesday 10th of November") share them without being the same story.
    "monday tuesday wednesday thursday friday saturday sunday january february april june july august september october november december"
  ).split(" "),
);

function stem(word: string): string {
  if (word.endsWith("'s") || word.endsWith("’s")) word = word.slice(0, -2);
  if (word.length > 4 && word.endsWith("ies")) return `${word.slice(0, -3)}y`;
  if (word.length > 4 && word.endsWith("s") && !word.endsWith("ss") && !word.endsWith("us")) return word.slice(0, -1);
  return word;
}

export function tokenize(text: string): string[] {
  return (text.toLowerCase().normalize("NFKD").replace(/[\u0300-\u036f]/g, "").match(/[a-z0-9][a-z0-9'’]*/g) ?? [])
    .map(stem)
    .filter((w) => w.length >= 3 && !STOPWORDS.has(w) && !/^\d+(st|nd|rd|th)?$/.test(w));
}

/**
 * States and regions named in headlines. The same kind of event in two places ("Thunderstorms forecast for Otago" and
 * "thunderstorms over Brisbane") shares its words but isn't one story. Case-sensitive, and ambiguous names (Victoria,
 * Canterbury, Hamilton, Nelson, Hastings, Newcastle) are left out. Canberra is left out: federal stories name it anywhere.
 */
const REGIONS: [string, RegExp][] = [
  ["WA", /\b(WA|Western Australian?|Perth|Fremantle|Mandurah|Bunbury|Kalgoorlie|Geraldton|Broome|Karratha|Pilbara|Kimberley)\b/],
  ["NSW", /\b(NSW|New South Wales|Sydney|Wollongong|Blue Mountains)\b/],
  ["VIC", /\b(Victorian|Melbourne|Geelong|Ballarat|Bendigo)\b/],
  ["QLD", /\b(Queensland(ers?)?|QLD|Qld|Brisbane|Gold Coast|Sunshine Coast|Cairns|Townsville|Toowoomba)\b/],
  ["SA", /\b(South Australian?|Adelaide)\b/],
  ["TAS", /\b(Tasmanian?|Hobart|Launceston)\b/],
  ["NT", /\b(Northern Territory|Darwin|Alice Springs)\b/],
  ["Auckland", /\bAuckland\b/],
  ["Wellington", /\bWellington\b/],
  ["Christchurch", /\bChristchurch\b/],
  ["Otago", /\b(Otago|Dunedin|Queenstown)\b/],
  ["Southland", /\b(Southland|Invercargill)\b/],
  ["Bay of Plenty", /\b(Bay of Plenty|Tauranga|Rotorua)\b/],
  ["Northland", /\b(Northland|Whang[aā]rei)\b/],
  ["Taranaki", /\b(Taranaki|New Plymouth)\b/],
  ["Hawke's Bay", /\b(Hawke's Bay|Napier)\b/],
  ["Waikato", /\bWaikato\b/],
];

export function regionsIn(title: string): Set<string> {
  return new Set(REGIONS.filter(([, re]) => re.test(title)).map(([name]) => name));
}

/**
 * Countries named in headlines, by name, people and a few unambiguous capitals. "Schools in Italy evacuated after
 * bomb threats" and "Schools across UK evacuated over bomb threat" are two events. Australian states and New Zealand
 * regions count as their country. Ambiguous names (Georgia, Jordan, Chad, Turkey the bird, Paris the person,
 * Washington) are left out.
 */
const COUNTRIES: [string, RegExp][] = [
  ["Australia", /\b(Australia|Australians?|Aussies?|WA|NSW|Queensland(ers?)?|Tasmanian?|Victorian|South Australian?|Western Australian?|Northern Territory|Sydney|Melbourne|Brisbane|Perth|Adelaide|Hobart|Darwin|Canberra|Albanese)\b/],
  ["New Zealand", /\b(New Zealand(ers?)?|NZ|Kiwis|Aotearoa|Auckland|Wellington|Christchurch|Dunedin|Otago|Waikato|Tauranga|Luxon)\b/],
  ["United Kingdom", /\b(UK|U\.K\.|Britain|British|England|English|Scotland|Scottish|Wales|Welsh|London|Starmer)\b/],
  ["United States", /\b(US|U\.S\.|USA|America|Americans?|Trump|White House|Pentagon|Congress)\b/],
  ["Italy", /\b(Italy|Italian|Rome|Milan)\b/],
  ["France", /\b(France|French|Macron)\b/],
  ["Germany", /\b(Germany|German|Berlin)\b/],
  ["Spain", /\b(Spain|Spanish|Madrid|Barcelona)\b/],
  ["Russia", /\b(Russia|Russian|Moscow|Kremlin|Putin)\b/],
  ["Ukraine", /\b(Ukraine|Ukrainian|Kyiv|Zelensky[yi]?)\b/],
  ["China", /\b(China|Chinese|Beijing|Xi Jinping)\b/],
  ["Japan", /\b(Japan|Japanese|Tokyo)\b/],
  ["India", /\b(India|Indian|Delhi|Mumbai|Modi)\b(?! Ocean)/],
  ["Indonesia", /\b(Indonesia|Indonesian|Jakarta|Bali|Prabowo)\b/],
  ["Israel", /\b(Israel|Israeli|Netanyahu|Knesset)\b/],
  ["Iran", /\b(Iran|Iranian|Tehran)\b/],
  ["Canada", /\b(Canada|Canadian|Ottawa|Toronto)\b/],
  ["Poland", /\b(Poland|Polish|Warsaw|Krak[oó]w)\b/],
  ["Philippines", /\b(Philippines|Filipino|Manila)\b/],
  ["Papua New Guinea", /\b(Papua New Guinea|PNG|Port Moresby)\b/],
];

export function countriesIn(title: string): Set<string> {
  // "New South Wales" isn't Wales; "New England" may be Australia or the US.
  const t = title.replace(/New South Wales/g, "NSW").replace(/New England/g, "");
  return new Set(COUNTRIES.filter(([, re]) => re.test(t)).map(([name]) => name));
}

/** A word that opens a headline or a clause, where every word is capitalised. */
const CLAUSE_START = /^|[:.?!|—–]\s+|\s[-–]\s|["“‘']/;

/** "Bulgarian" and "Bulgaria", "Ukrainian" and "Ukraine": names sharing their first six letters. */
function sameName(a: string, b: string): boolean {
  return a.length >= 6 && b.length >= 6 && a.slice(0, 6) === b.slice(0, 6);
}

/** Capitalised words that name a role or a kind of thing, not who or what a story is about. */
const NOT_NAMES = new Set([
  ..."ceo cfo md pm mp ai tv gdp nfl nba afl nrl covid breaking exclusive opinion analysis watch live update explainer review podcast quiz".split(" "),
  // Titles and institutions any outlet may or may not name ("WA Police Commissioner" and "Blanch" are one person).
  ..."commissioner premier minister president senator governor mayor chief judge justice coroner inquest police government council court parliament senate house treasurer opposition leader".split(" "),
  // Seasons and holidays: a "white Christmas" hailstorm is the Mt Magnet hailstorm.
  ..."christmas easter summer winter spring autumn".split(" "),
].map(stem));

/**
 * Names in each headline: people, companies, products, places. A capitalised word counts as a name when, across this
 * edition's sentence-case headlines, it is mostly capitalised mid-sentence. In title-case headlines ("Trump Is Firmly
 * in Jensen Huang's Corner") only words other outlets capitalise mid-sentence count. Countries, states and regions are
 * left to `COUNTRIES` and `REGIONS`.
 */
export function namesIn(titles: string[]): Set<string>[] {
  const split = (title: string) => {
    const out: { key: string; capital: boolean; start: boolean; word: string }[] = [];
    // "U.N." is "UN"; "ex-Crusaders" names the Crusaders.
    for (const m of title.matchAll(/[\p{L}\p{N}](?:[\p{L}\p{N}'’&]|\.(?=\p{Lu}))*/gu)) {
      const word = m[0].replace(/['’]s$/, "").replace(/\./g, "").replace(/['’]+$/, "");
      if (word.length < 2) continue;
      const before = title.slice(Math.max(0, m.index - 3), m.index);
      const start = m.index === 0 || new RegExp(`(${CLAUSE_START.source})$`).test(before);
      out.push({ key: stem(word.toLowerCase()), capital: /^\p{Lu}/u.test(word), start, word });
    }
    return out;
  };
  const words = titles.map(split);
  const titleCase = words.map((list) => {
    const long = list.filter((w) => w.word.length >= 4 && !w.start);
    return long.length >= 3 && long.filter((w) => w.capital).length >= 0.6 * long.length;
  });
  const capital = new Map<string, number>();
  const lower = new Map<string, number>();
  words.forEach((list, n) => {
    for (const w of list) {
      if (w.start || (titleCase[n] && w.capital)) continue;
      const counts = w.capital ? capital : lower;
      counts.set(w.key, (counts.get(w.key) ?? 0) + 1);
    }
  });
  return words.map((list, n) => {
    const names = new Set<string>();
    for (const w of list) {
      if (!w.capital || STOPWORDS.has(w.key) || NOT_NAMES.has(w.key) || countriesIn(w.word).size || regionsIn(w.word).size) continue;
      const caps = capital.get(w.key) ?? 0;
      const low = lower.get(w.key) ?? 0;
      const sentenceCaseWord = !titleCase[n] && !w.start;
      // A sentence-case headline's first word ("Westpac outage…") is a name when it is never written in lower case.
      const opener = !titleCase[n] && w.start && low === 0;
      if (opener || ((sentenceCaseWord || caps > 0) && low <= 0.25 * caps + (sentenceCaseWord ? 0.5 : 0))) names.add(w.key);
    }
    return names;
  });
}

function termFreq(tokens: string[], weight: number, into: Vec = new Map()): Vec {
  for (const t of tokens) into.set(t, (into.get(t) ?? 0) + weight);
  return into;
}

function weigh(tf: Vec, idf: Map<string, number>): Vec {
  const out: Vec = new Map();
  let norm = 0;
  for (const [t, f] of tf) {
    const w = (1 + Math.log(f)) * (idf.get(t) ?? 0);
    if (w > 0) {
      out.set(t, w);
      norm += w * w;
    }
  }
  norm = Math.sqrt(norm) || 1;
  for (const [t, w] of out) out.set(t, w / norm);
  return out;
}

function cosine(a: Vec, b: Vec): number {
  const [small, large] = a.size < b.size ? [a, b] : [b, a];
  let dot = 0;
  for (const [t, w] of small) dot += w * (large.get(t) ?? 0);
  return dot;
}

function addInto(sum: Vec, v: Vec): void {
  for (const [t, w] of v) sum.set(t, (sum.get(t) ?? 0) + w);
}

function normalised(sum: Vec): Vec {
  let norm = 0;
  for (const w of sum.values()) norm += w * w;
  norm = Math.sqrt(norm) || 1;
  const out: Vec = new Map();
  for (const [t, w] of sum) out.set(t, w / norm);
  return out;
}

interface Working extends Cluster {
  regions: Set<string>;
  countries: Set<string>;
  /** Names in the story's headlines, with how many headlines name each. */
  names: Map<string, number>;
  titleSum: Vec;
  fullSum: Vec;
  titleCentroid: Vec;
  fullCentroid: Vec;
}

export function clusterItems(items: Item[], options: ClusterOptions = DEFAULT_CLUSTER_OPTIONS): Cluster[] {
  const titleTokens = items.map((i) => tokenize(i.title));
  const summaryTokens = items.map((i) => tokenize(i.summary.slice(0, 400)));

  const df = new Map<string, number>();
  items.forEach((_, n) => {
    for (const t of new Set([...titleTokens[n]!, ...summaryTokens[n]!])) df.set(t, (df.get(t) ?? 0) + 1);
  });
  const idf = new Map<string, number>();
  for (const [t, d] of df) idf.set(t, d < 2 ? Math.log(items.length) * 0.6 : Math.log(items.length / d));

  const titleVecs = titleTokens.map((t) => weigh(termFreq(t, 1), idf));
  const fullVecs = items.map((_, n) => weigh(termFreq(summaryTokens[n]!, 1, termFreq(titleTokens[n]!, 2)), idf));

  const order = items.map((_, n) => n).sort((a, b) => items[a]!.published.getTime() - items[b]!.published.getTime());
  const clusters: Working[] = [];
  const windowMs = options.windowHours * 3600 * 1000;
  const itemNames = options.useNames ? namesIn(items.map((i) => i.title)) : items.map(() => new Set<string>());
  const disjoint = (a: Set<string>, b: Set<string> | Map<string, number>) => a.size > 0 && b.size > 0 && ![...a].some((x) => b.has(x));

  for (const n of order) {
    const item = items[n]!;
    const headlineOnly = !item.source.ai_input_allowed || item.summary.length === 0;
    const regions = regionsIn(item.title);
    const countries = options.separateRegions ? countriesIn(item.title) : new Set<string>();
    const names = itemNames[n]!;
    let best: Working | null = null;
    let bestSim = 0;
    for (const c of clusters) {
      if (item.published.getTime() - c.last.getTime() > windowMs) continue;
      if (c.items.some((m) => m.source.id === item.source.id && m.title === item.title)) continue;
      if (options.separateRegions && disjoint(regions, c.regions)) continue;
      // Different names or countries keep a report out, unless it shares any name or country with the story: a big
      // story's headlines mention other countries and people in passing.
      const sharesAny = [...names].some((x) => c.names.has(x) || [...c.names.keys()].some((y) => sameName(x, y))) || [...countries].some((x) => c.countries.has(x));
      if (!sharesAny && (disjoint(names, c.names) || disjoint(countries, c.countries))) continue;
      const sim = headlineOnly
        ? cosine(titleVecs[n]!, c.titleCentroid)
        : Math.max(cosine(fullVecs[n]!, c.fullCentroid), cosine(titleVecs[n]!, c.titleCentroid));
      // Only names the story keeps returning to: a big story collects passing names from its many headlines.
      const shared = [...names].filter((x) => (c.names.get(x) ?? 0) >= Math.min(2, c.items.length)).length;
      const needed = shared >= 2 && options.namedThreshold !== undefined ? Math.min(options.namedThreshold, options.threshold) : options.threshold;
      if (sim > needed && sim > bestSim) {
        best = c;
        bestSim = sim;
      }
    }
    if (best) {
      best.items.push(item);
      for (const r of regions) best.regions.add(r);
      for (const x of countries) best.countries.add(x);
      for (const x of names) best.names.set(x, (best.names.get(x) ?? 0) + 1);
      if (item.published > best.last) best.last = item.published;
      addInto(best.titleSum, titleVecs[n]!);
      addInto(best.fullSum, fullVecs[n]!);
      best.titleCentroid = normalised(best.titleSum);
      best.fullCentroid = normalised(best.fullSum);
    } else {
      const titleSum: Vec = new Map(titleVecs[n]!);
      const fullSum: Vec = new Map(fullVecs[n]!);
      clusters.push({
        regions,
        countries,
        names: new Map([...names].map((x) => [x, 1])),
        items: [item],
        first: item.published,
        last: item.published,
        titleSum,
        fullSum,
        titleCentroid: titleVecs[n]!,
        fullCentroid: fullVecs[n]!,
      });
    }
  }
  return clusters.map(({ items, first, last }) => ({ items, first, last }));
}
