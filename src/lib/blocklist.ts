import { readFile } from "node:fs/promises";
import { canonicalUrl, type Item } from "./normalise.js";

const BLOCKLIST_PATH = new URL("../../config/blocklist.json", import.meta.url);

export interface Blocklist {
  urls: string[];
  phrases: string[];
}

export async function loadBlocklist(): Promise<Blocklist> {
  const raw = JSON.parse(await readFile(BLOCKLIST_PATH, "utf8")) as Partial<Blocklist>;
  if (!Array.isArray(raw.urls) || !Array.isArray(raw.phrases)) throw new Error("config/blocklist.json needs `urls` and `phrases` arrays");
  return { urls: raw.urls.map(String), phrases: raw.phrases.map(String) };
}

/** Items not matched by the takedown list. */
export function applyBlocklist(items: Item[], list: Blocklist): Item[] {
  const urls = new Set(list.urls.map((u) => canonicalUrl(u) ?? u));
  const phrases = list.phrases.map((p) => p.toLowerCase().trim()).filter(Boolean);
  return items.filter((i) => !urls.has(i.key) && !phrases.some((p) => i.title.toLowerCase().includes(p)));
}
