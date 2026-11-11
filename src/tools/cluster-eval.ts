import { createHash } from "node:crypto";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { gunzipSync } from "node:zlib";
import { geminiJson } from "../ai/gemini.js";
import { loadSources, SECTIONS, type Section } from "../config/sources.js";
import { applyBlocklist, loadBlocklist } from "../lib/blocklist.js";
import { clusterItems, tokenize, type Cluster } from "../lib/cluster.js";
import type { FeedSnapshot } from "../lib/fetch-feeds.js";
import { normalise } from "../lib/normalise.js";
import { buildStories, type Story } from "../lib/stories.js";

/**
 * Measures how well reports are grouped into stories (0.9) and placed in sections (1.7), on a saved snapshot:
 * - purity: a free model reads each multi-outlet story's headlines and names any about a different event;
 * - completeness: pairs of stories with similar headlines (likely splits) are asked "same event?";
 * - sections: the model picks each multi-outlet story's section, compared with ours.
 * Headlines only. Answers are cached in .cache/cluster-labels.json, so runs before and after a change are judged alike.
 * Usage: npm run cluster-eval -- [snapshot.json.gz]   (GEMINI_API_KEY must be set; EVAL_TOP limits stories, default 150)
 */
const MODEL = process.env.EVAL_MODEL ?? "gemini-3.5-flash-lite";
const LABELS = resolve(".cache/cluster-labels.json");
const TOP = Number(process.env.EVAL_TOP ?? 150);
const PAIRS = 150;
const PAIR_MIN_SIMILARITY = 0.12;
const GAP_MS = 4_500;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const hash = (s: string) => createHash("sha256").update(s).digest("base64url").slice(0, 16);

type Labels = Record<string, unknown>;

async function ask<T>(system: string, prompts: { key: string; line: string }[], schema: object, read: (a: Record<string, unknown>) => T | undefined, labels: Labels, batch: number): Promise<void> {
  const todo = prompts.filter((p) => labels[p.key] === undefined);
  for (let i = 0; i < todo.length; i += batch) {
    const part = todo.slice(i, i + batch);
    if (i) await sleep(GAP_MS);
    try {
      const reply = await geminiJson(MODEL, system, part.map((p, n) => JSON.stringify({ id: String(n + 1), ...JSON.parse(p.line) })).join("\n"), schema);
      for (const a of ((reply.json as { answers?: unknown[] } | null)?.answers ?? []) as Record<string, unknown>[]) {
        const p = part[Number(a.id) - 1];
        const value = p && read(a);
        if (p && value !== undefined) labels[p.key] = value;
      }
    } catch (err) {
      console.log(`Request failed (${part.length} items): ${err instanceof Error ? err.message : err}`);
    }
    await writeFile(LABELS, JSON.stringify(labels));
  }
}

const answers = (props: object, required: string[]) => ({
  type: "object",
  properties: { answers: { type: "array", items: { type: "object", properties: { id: { type: "string" }, ...props }, required: ["id", ...required] } } },
  required: ["answers"],
});

const SAME_EVENT = `"The same event" means one specific happening or development: one incident, one announcement, one match, one court case, one report or study, one ongoing crisis followed day by day. Two different matches, two different crimes, two different announcements on the same topic, or a general explainer and a specific incident are different events, even when the topic is the same.`;

const PURITY = `You check how a news site groups reports. For each group you get numbered headlines that were grouped as one story. ${SAME_EVENT}
Return strays: the numbers of the headlines that are not about the same event as most of the group (empty when all belong).`;

const SPLIT = `You check how a news site groups reports. For each pair you get the headlines of story A and story B. ${SAME_EVENT}
Return same: true when A and B are about the same event and should be one story.`;

const SECTION_HELP: Record<Section, string> = {
  "local-wa": "news from Western Australia (Perth, regional WA, the WA government)",
  australia: "Australian news outside WA, including federal government and courts",
  "new-zealand": "New Zealand news",
  politics: "Australian federal or state politics: parties, elections, parliament, policy fights",
  world: "news from other countries and international affairs",
  business: "economy, markets, companies, jobs, prices",
  "science-tech": "science, space, health research, environment and nature science",
  tech: "AI, technology companies, gadgets, apps, games",
  sport: "sport",
  entertainment: "film, TV, music, celebrities, arts, royals",
  "feel-good": "uplifting human-interest stories, animals, quirky good news",
};
const SECTION = `You place news stories in the sections of an Australian news site from Perth. Sections:
${SECTIONS.map((s) => `- ${s}: ${SECTION_HELP[s]}`).join("\n")}
A story about Western Australia goes in local-wa even if it is about politics or business there. For each story you get its headlines; return the best section and, when another section would also be reasonable, that one as also (else "").`;

function vector(titles: string[]): Map<string, number> {
  const v = new Map<string, number>();
  for (const t of titles.flatMap(tokenize)) v.set(t, (v.get(t) ?? 0) + 1);
  return v;
}

function cosine(a: Map<string, number>, b: Map<string, number>, idf: Map<string, number>): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (const [t, w] of a) {
    const x = w * (idf.get(t) ?? 0);
    na += x * x;
    dot += x * (b.get(t) ?? 0) * (idf.get(t) ?? 0);
  }
  for (const [t, w] of b) nb += (w * (idf.get(t) ?? 0)) ** 2;
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}

const owners = (c: Cluster | Story) => new Set(c.items.map((i) => i.source.owner_group)).size;
const titlesOf = (c: Cluster | Story, max = 8) => [...new Set(c.items.map((i) => i.title))].slice(0, max);

async function main(): Promise<void> {
  const dir = resolve(".cache/snapshots");
  const file = process.argv[2] ?? resolve(dir, (await readdir(dir)).filter((f) => f.endsWith(".json.gz")).sort().at(-1) ?? "");
  const snapshot = JSON.parse(gunzipSync(await readFile(file)).toString("utf8")) as { taken_at: string; feeds: FeedSnapshot[] };
  const now = new Date(snapshot.taken_at);
  const config = await loadSources();
  const items = applyBlocklist(normalise(snapshot.feeds, new Map(config.sources.map((s) => [s.id, s])), now), await loadBlocklist());
  const clusters = clusterItems(items);
  const stories = buildStories(clusters, now);
  const multi = stories.filter((s) => s.independent >= 2).sort((a, b) => b.lead - a.lead).slice(0, TOP);
  let labels: Labels = {};
  try {
    labels = JSON.parse(await readFile(LABELS, "utf8")) as Labels;
  } catch {
    // first run
  }
  console.log(`${file}: ${items.length} items, ${stories.length} stories, ${stories.filter((s) => s.independent >= 2).length} multi-outlet; judging the top ${multi.length} (${MODEL})\n`);

  // Purity.
  const purityKey = (s: Story) => `p:${hash(titlesOf(s, 30).sort().join("\n"))}`;
  await ask(PURITY, multi.map((s) => ({ key: purityKey(s), line: JSON.stringify({ headlines: titlesOf(s, 30) }) })), answers({ strays: { type: "array", items: { type: "string" } } }, ["strays"]), (a) => (Array.isArray(a.strays) ? a.strays.map(Number).filter((n) => n > 0) : undefined), labels, 8);
  let pure = 0;
  let judged = 0;
  let strayItems = 0;
  let groupedItems = 0;
  const impure: string[] = [];
  for (const s of multi) {
    const strays = labels[purityKey(s)] as number[] | undefined;
    if (!strays) continue;
    judged++;
    const titles = titlesOf(s, 30);
    groupedItems += titles.length;
    strayItems += strays.length;
    if (!strays.length) pure++;
    else impure.push(`  "${s.headline.title}" (${titles.length} headlines): ${strays.map((n) => `"${titles[n - 1] ?? "?"}"`).join("; ")}`);
  }

  // Completeness: pairs of stories (one shown as multi-outlet at least, or together they would be) with similar headlines.
  const df = new Map<string, number>();
  const vecs = new Map(stories.map((s) => [s, vector(titlesOf(s))]));
  for (const v of vecs.values()) for (const t of v.keys()) df.set(t, (df.get(t) ?? 0) + 1);
  const idf = new Map([...df].map(([t, d]) => [t, Math.log(stories.length / d)]));
  const candidates: { a: Story; b: Story; sim: number }[] = [];
  const pool = stories.filter((s) => s.items.length >= 1);
  const shown = new Set(multi);
  for (let i = 0; i < pool.length; i++) {
    for (let j = i + 1; j < pool.length; j++) {
      const a = pool[i]!;
      const b = pool[j]!;
      if (!shown.has(a) && !shown.has(b)) continue;
      const sim = cosine(vecs.get(a)!, vecs.get(b)!, idf);
      if (sim >= PAIR_MIN_SIMILARITY) candidates.push({ a, b, sim });
    }
  }
  const pairs = candidates.sort((x, y) => y.sim - x.sim).slice(0, PAIRS);
  const pairKey = (a: Story, b: Story) => `s:${hash([titlesOf(a).sort().join("\n"), titlesOf(b).sort().join("\n")].sort().join("\n--\n"))}`;
  await ask(SPLIT, pairs.map(({ a, b }) => ({ key: pairKey(a, b), line: JSON.stringify({ A: titlesOf(a, 5), B: titlesOf(b, 5) }) })), answers({ same: { type: "boolean" } }, ["same"]), (x) => (typeof x.same === "boolean" ? x.same : undefined), labels, 15);
  const splits = pairs.filter(({ a, b }) => labels[pairKey(a, b)] === true);

  // Sections.
  const sectionKey = (s: Story) => `c:${hash(titlesOf(s).sort().join("\n"))}`;
  await ask(SECTION, multi.map((s) => ({ key: sectionKey(s), line: JSON.stringify({ headlines: titlesOf(s, 6) }) })), answers({ section: { type: "string", enum: [...SECTIONS] }, also: { type: "string" } }, ["section", "also"]), (a) => (typeof a.section === "string" ? [a.section, String(a.also ?? "")] : undefined), labels, 25);
  let placed = 0;
  let placedOk = 0;
  const wrong: string[] = [];
  for (const s of multi) {
    const label = labels[sectionKey(s)] as [string, string] | undefined;
    if (!label) continue;
    placed++;
    if (label.includes(s.section)) placedOk++;
    else wrong.push(`  ${s.section.padEnd(13)} → ${label[0].padEnd(13)} "${s.headline.title}"`);
  }

  const pct = (n: number, d: number) => (d ? `${((100 * n) / d).toFixed(1)}%` : "-");
  console.log(`PURITY: ${pure}/${judged} stories have no stray headline (${pct(pure, judged)}); ${strayItems}/${groupedItems} headlines are strays (${pct(strayItems, groupedItems)})`);
  for (const line of impure) console.log(line);
  console.log(`\nSPLITS: ${splits.length} of ${pairs.length} similar pairs are the same event`);
  for (const { a, b, sim } of splits) console.log(`  ${sim.toFixed(2)} [${owners(a)}] "${a.headline.title}"  ==  [${owners(b)}] "${b.headline.title}"`);
  console.log(`\nSECTIONS: ${placedOk}/${placed} in a right section (${pct(placedOk, placed)})`);
  for (const line of wrong) console.log(line);
  console.log(`\nSUMMARY purity ${pct(pure, judged)} | stray headlines ${pct(strayItems, groupedItems)} | splits ${splits.length}/${pairs.length} | sections ${pct(placedOk, placed)}`);
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
