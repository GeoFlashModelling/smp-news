import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { gunzipSync } from "node:zlib";
import { loadSources } from "../config/sources.js";
import { DEFAULT_CLUSTER_OPTIONS, clusterItems } from "../lib/cluster.js";
import type { FeedSnapshot } from "../lib/fetch-feeds.js";
import { normalise } from "../lib/normalise.js";

/** Usage: npm run cluster-report -- [snapshot.json.gz] [threshold] */
async function main(): Promise<void> {
  const dir = resolve(".cache/snapshots");
  const file = process.argv[2] ?? resolve(dir, (await readdir(dir)).filter((f) => f.endsWith(".json.gz")).sort().at(-1) ?? "");
  const snapshot = JSON.parse(gunzipSync(await readFile(file)).toString("utf8")) as { taken_at: string; feeds: FeedSnapshot[] };
  const threshold = Number(process.argv[3] ?? DEFAULT_CLUSTER_OPTIONS.threshold);

  const config = await loadSources();
  const sources = new Map(config.sources.map((s) => [s.id, s]));
  const items = normalise(snapshot.feeds, sources, new Date(snapshot.taken_at));
  const clusters = clusterItems(items, { ...DEFAULT_CLUSTER_OPTIONS, threshold });

  const owners = (c: (typeof clusters)[number]) => new Set(c.items.map((i) => i.source.owner_group)).size;
  const multi = clusters.filter((c) => owners(c) >= 2).sort((a, b) => owners(b) - owners(a));
  console.log(`${file}\n${items.length} items → ${clusters.length} clusters; ${multi.length} with ≥2 owner groups (threshold ${threshold})\n`);
  for (const c of multi.slice(0, Number(process.env.TOP ?? 40))) {
    console.log(`## ${owners(c)} owners, ${c.items.length} items`);
    for (const i of c.items) console.log(`   ${i.source.id.padEnd(22)} ${(i.source.lean ?? "-").padEnd(12)} ${i.title.slice(0, 110)}`);
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
