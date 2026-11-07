import { loadSources } from "../config/sources.js";

try {
  const config = await loadSources();
  const enabled = config.sources.filter((s) => s.enabled);
  const feeds = enabled.reduce((n, s) => n + s.feeds.length, 0);
  console.log(`sources.json is valid: ${enabled.length} enabled sources, ${feeds} feeds.`);
} catch (err) {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
}
