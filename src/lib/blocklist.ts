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

const SHOPPING =
  /\bsave (up to )?((\$|£|€|a\$)\d|\d+%)|\d+% off\b|(\$|£|€)\d[\d,.]* off\b|\b(lowest|best|record[- ]low) price|\bprice (drop|plunge)s?\b|\b(coupon|promo code|discount code|voucher code)s?\b|\bbest [\w\s'-]{0,40}\b(gifts|deals)\b|\b(black friday|cyber monday|prime day|boxing day)\b[^.]*\b(deals?|sales?)\b|\bdeals? of the (day|week)\b|\b(now|is|are) on sale\b/i;

/** Shopping posts (discounts, gift guides, coupon codes) that feeds mix in with news. */
export function isShopping(title: string): boolean {
  return SHOPPING.test(title);
}

/** Items not matched by the takedown list, and not shopping posts. */
export function applyBlocklist(items: Item[], list: Blocklist): Item[] {
  const urls = new Set(list.urls.map((u) => canonicalUrl(u) ?? u));
  const phrases = list.phrases.map((p) => p.toLowerCase().trim()).filter(Boolean);
  return items.filter((i) => !urls.has(i.key) && !phrases.some((p) => i.title.toLowerCase().includes(p)) && !isShopping(i.title));
}
