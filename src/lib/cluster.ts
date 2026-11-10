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
}

export const DEFAULT_CLUSTER_OPTIONS: ClusterOptions = { threshold: 0.32, windowHours: 36 };

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

  for (const n of order) {
    const item = items[n]!;
    const headlineOnly = !item.source.ai_input_allowed || item.summary.length === 0;
    let best: Working | null = null;
    let bestSim = options.threshold;
    for (const c of clusters) {
      if (item.published.getTime() - c.last.getTime() > windowMs) continue;
      if (c.items.some((m) => m.source.id === item.source.id && m.title === item.title)) continue;
      const sim = headlineOnly
        ? cosine(titleVecs[n]!, c.titleCentroid)
        : Math.max(cosine(fullVecs[n]!, c.fullCentroid), cosine(titleVecs[n]!, c.titleCentroid));
      if (sim > bestSim) {
        best = c;
        bestSim = sim;
      }
    }
    if (best) {
      best.items.push(item);
      if (item.published > best.last) best.last = item.published;
      addInto(best.titleSum, titleVecs[n]!);
      addInto(best.fullSum, fullVecs[n]!);
      best.titleCentroid = normalised(best.titleSum);
      best.fullCentroid = normalised(best.fullSum);
    } else {
      const titleSum: Vec = new Map(titleVecs[n]!);
      const fullSum: Vec = new Map(fullVecs[n]!);
      clusters.push({
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
