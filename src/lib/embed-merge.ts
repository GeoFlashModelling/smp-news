import { clusterItems, countriesIn, leadClause, namesIn, regionsIn, type Cluster } from "./cluster.js";
import { embedAllowed } from "./embed.js";
import type { Item } from "./normalise.js";

/**
 * A second pass after the word grouper. MiniLM paraphrases of one event score about 0.78 and up
 * (a Senate result told two ways, 0.82). Different events that share a city or a verb stay under that,
 * except two Auckland fires at 0.76 and every town's Remembrance Day service, so a shared place needs 0.88.
 * A large group's average can sit under that even when a small group matches its closest headlines
 * (the Huang timeline against the affair, 0.84). That join uses the same 0.78. The next pair down,
 * 0.77, is a succession note sharing a group with an ASX market wrap, so the bar stays here.
 * This only joins. It does not pull a story apart.
 */
const MERGE_AT = 0.78;
const NEAR_AT = 0.78;
const SAME_PLACE_AT = 0.88;
const MAX_SMALLER = 8;
const WINDOW_MS = 36 * 3600 * 1000;
const CONTEST = /\b(beats?|beaten|past|defeats?|versus|vs\.?|advances?|fights?|fightback|wins?|won)\b/i;
const COMPETITION = new Set(["shield", "sheffield"]);

interface Side {
  cluster: Cluster;
  vec: Float32Array | null;
  vecs: Float32Array[];
  regions: Set<string>;
  countries: Set<string>;
  names: Set<string>;
}

const sameName = (a: string, b: string) => a.length >= 6 && b.length >= 6 && a.slice(0, 6) === b.slice(0, 6);
const shares = (a: Set<string>, b: Set<string>) => [...a].some((x) => b.has(x) || [...b].some((y) => sameName(x, y)));
const disjoint = (a: Set<string>, b: Set<string>) => a.size > 0 && b.size > 0 && !shares(a, b);

function mean(vecs: Float32Array[]): Float32Array | null {
  const first = vecs[0];
  if (!first) return null;
  const out = new Float32Array(first.length);
  for (const vec of vecs) for (let i = 0; i < out.length; i++) out[i] = (out[i] ?? 0) + (vec[i] ?? 0);
  let norm = 0;
  for (const value of out) norm += value * value;
  norm = Math.sqrt(norm) || 1;
  for (let i = 0; i < out.length; i++) out[i] = (out[i] ?? 0) / norm;
  return out;
}

function cosine(a: Float32Array, b: Float32Array): number {
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += (a[i] ?? 0) * (b[i] ?? 0);
  return dot;
}

/** How close the smaller group's headlines are to the closest headlines in the larger group. */
function coverage(small: Float32Array[], large: Float32Array[]): number {
  if (!small.length || large.length < 2) return 0;
  let sum = 0;
  for (const sv of small) {
    let best = 0;
    for (const lv of large) best = Math.max(best, cosine(sv, lv));
    sum += best;
  }
  return sum / small.length;
}

function contestBlocks(a: Side, b: Side): boolean {
  const aContest = a.cluster.items.some((item) => CONTEST.test(leadClause(item.title)));
  const bContest = b.cluster.items.some((item) => CONTEST.test(leadClause(item.title)));
  if (!aContest || !bContest || a.names.size === 0 || b.names.size === 0) return false;
  const onlyA = [...a.names].some((name) => !b.names.has(name) && ![...b.names].some((other) => sameName(name, other)));
  const onlyB = [...b.names].some((name) => !a.names.has(name) && ![...a.names].some((other) => sameName(name, other)));
  return onlyA && onlyB;
}

/** Join groups whose headlines are paraphrases. Headlines that were not embedded (AI input forbidden) do not vote. */
export function mergeByEmbedding(items: Item[], clusters: Cluster[], vectors: (Float32Array | null)[]): { clusters: Cluster[]; merges: number } {
  const titles = items.map((item) => leadClause(item.title));
  const nameSets = namesIn(titles);
  const indexOf = new Map(items.map((item, index) => [item.key, index]));
  const sides: Side[] = clusters.map((cluster) => {
    const indexes = cluster.items.flatMap((item) => {
      const index = indexOf.get(item.key);
      return index === undefined ? [] : [index];
    });
    const names = new Set<string>();
    const regions = new Set<string>();
    const countries = new Set<string>();
    const vecs: Float32Array[] = [];
    for (const index of indexes) {
      for (const name of nameSets[index] ?? []) if (!COMPETITION.has(name)) names.add(name);
      for (const region of regionsIn(titles[index] ?? "")) regions.add(region);
      for (const country of countriesIn(titles[index] ?? "")) countries.add(country);
      const vec = vectors[index];
      if (vec) vecs.push(vec);
    }
    return { cluster, vec: mean(vecs), vecs, regions, countries, names };
  });

  let merges = 0;
  let moved = true;
  while (moved) {
    moved = false;
    let bestI = -1;
    let bestJ = -1;
    let best = 0;
    for (let i = 0; i < sides.length; i++) {
      for (let j = i + 1; j < sides.length; j++) {
        const a = sides[i]!;
        const b = sides[j]!;
        if (!a.vec || !b.vec) continue;
        if (Math.min(a.cluster.items.length, b.cluster.items.length) > MAX_SMALLER) continue;
        if (a.cluster.first.getTime() - b.cluster.last.getTime() > WINDOW_MS || b.cluster.first.getTime() - a.cluster.last.getTime() > WINDOW_MS) continue;
        if (disjoint(a.regions, b.regions)) continue;
        const shared = shares(a.names, b.names) || shares(a.countries, b.countries);
        if (!shared && (disjoint(a.names, b.names) || disjoint(a.countries, b.countries))) continue;
        if (contestBlocks(a, b)) continue;
        const sim = cosine(a.vec, b.vec);
        const bar = shares(a.regions, b.regions) ? SAME_PLACE_AT : MERGE_AT;
        if (sim < bar || sim <= best) continue;
        best = sim;
        bestI = i;
        bestJ = j;
      }
    }
    if (bestI < 0) break;
    const left = sides[bestI]!;
    const right = sides[bestJ]!;
    const [keep, drop] = left.cluster.items.length >= right.cluster.items.length ? [left, right] : [right, left];
    keep.cluster.items.push(...drop.cluster.items);
    if (drop.cluster.first < keep.cluster.first) keep.cluster.first = drop.cluster.first;
    if (drop.cluster.last > keep.cluster.last) keep.cluster.last = drop.cluster.last;
    for (const name of drop.names) keep.names.add(name);
    for (const region of drop.regions) keep.regions.add(region);
    for (const country of drop.countries) keep.countries.add(country);
    keep.vecs.push(...drop.vecs);
    const vecs = [keep.vec, drop.vec].filter((vec): vec is Float32Array => vec !== null);
    keep.vec = mean(vecs);
    sides.splice(sides.indexOf(drop), 1);
    merges++;
    moved = true;
  }

  // A small group can match the closest headlines of a large one while the large average has wandered off.
  moved = true;
  while (moved) {
    moved = false;
    let bestI = -1;
    let bestJ = -1;
    let best = 0;
    for (let i = 0; i < sides.length; i++) {
      for (let j = i + 1; j < sides.length; j++) {
        const a = sides[i]!;
        const b = sides[j]!;
        if (Math.min(a.cluster.items.length, b.cluster.items.length) > MAX_SMALLER) continue;
        if (Math.max(a.vecs.length, b.vecs.length) < 2) continue;
        if (a.cluster.first.getTime() - b.cluster.last.getTime() > WINDOW_MS || b.cluster.first.getTime() - a.cluster.last.getTime() > WINDOW_MS) continue;
        if (disjoint(a.regions, b.regions)) continue;
        const shared = shares(a.names, b.names) || shares(a.countries, b.countries);
        if (!shared && (disjoint(a.names, b.names) || disjoint(a.countries, b.countries))) continue;
        if (contestBlocks(a, b)) continue;
        const [small, large] = a.cluster.items.length <= b.cluster.items.length ? [a, b] : [b, a];
        let sim = coverage(small.vecs, large.vecs);
        if (a.cluster.items.length === b.cluster.items.length) sim = Math.max(sim, coverage(large.vecs, small.vecs));
        const bar = shares(a.regions, b.regions) ? SAME_PLACE_AT : NEAR_AT;
        if (sim < bar || sim <= best) continue;
        best = sim;
        bestI = i;
        bestJ = j;
      }
    }
    if (bestI < 0) break;
    const left = sides[bestI]!;
    const right = sides[bestJ]!;
    const [keep, drop] = left.cluster.items.length >= right.cluster.items.length ? [left, right] : [right, left];
    keep.cluster.items.push(...drop.cluster.items);
    if (drop.cluster.first < keep.cluster.first) keep.cluster.first = drop.cluster.first;
    if (drop.cluster.last > keep.cluster.last) keep.cluster.last = drop.cluster.last;
    for (const name of drop.names) keep.names.add(name);
    for (const region of drop.regions) keep.regions.add(region);
    for (const country of drop.countries) keep.countries.add(country);
    keep.vecs.push(...drop.vecs);
    const vecs = [keep.vec, drop.vec].filter((vec): vec is Float32Array => vec !== null);
    keep.vec = mean(vecs);
    sides.splice(sides.indexOf(drop), 1);
    merges++;
    moved = true;
  }
  return { clusters: sides.map((side) => side.cluster), merges };
}

/** Word grouping, then a local embedding join. If the model is missing, the word grouping is what publishes. */
export async function groupReports(items: Item[]): Promise<{ clusters: Cluster[]; note: string }> {
  const clusters = clusterItems(items);
  const vectors = await embedAllowed(items.map((item) => (item.source.ai_input_allowed ? leadClause(item.title) : null)));
  if (!vectors) return { clusters, note: "grouping on words" };
  const merged = mergeByEmbedding(items, clusters, vectors);
  const count = merged.merges;
  return { clusters: merged.clusters, note: count ? `embeddings joined ${count} ${count === 1 ? "group" : "groups"}` : "embeddings joined 0" };
}
