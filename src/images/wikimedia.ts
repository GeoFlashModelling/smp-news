import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { USER_AGENT } from "../lib/http.js";

/** A free-licensed photo from Wikimedia Commons, with everything needed to credit it. */
export interface Photo {
  /** Wikipedia article the photo illustrates (the subject, e.g. "Stephen Miller"). */
  subject: string;
  src: string;
  /** 960 px version for the story page, when the original is that big. */
  large?: string;
  width: number;
  height: number;
  artist: string;
  licence: string;
  /** File description page: shows the full licence and author. */
  page: string;
}

const API = "https://en.wikipedia.org/w/api.php";
const BATCH = 50;
const THUMB_WIDTH = 500;
const TIMEOUT_MS = 20_000;
const CACHE_DAYS = 7;

/** Only licences that allow reuse with credit. Anything else (fair use, "all rights reserved", NC/ND) is refused. */
const FREE_LICENCE = /^(CC0|CC BY(-SA)? \d(\.\d)?( \w+)?|Public domain|PD\b.*|Attribution|GFDL.*)$/i;
/** Lead images that aren't news pictures. */
const NOT_A_PHOTO = /\b(logo|flag|coat[_ ]of[_ ]arms|seal[_ ]of|emblem|map|locator|location|signature|diagram|chart|icon|wordmark|banner)\b/i;

const SMALL_WORDS = new Set(["of", "in", "the", "and", "de", "to", "for", "a", "an", "on", "at", "du", "la", "le", "van", "von", "da", "del", "y", "und", "bin", "al"]);

/**
 * Articles about named things have capitalised titles; "World cup", a slogan, a list, or "Native Americans in the
 * United States" is a topic, not a subject.
 */
function properTitle(title: string): boolean {
  const base = title.replace(/\s*\(.*\)$/, "");
  if (/^List of /i.test(base) || / in (the )?\p{Lu}/u.test(base)) return false;
  return base.split(/[\s,]+/).filter(Boolean).every((w) => SMALL_WORDS.has(w) || !/^\p{Ll}/u.test(w));
}

/** A single word may only redirect to an article that still contains it ("Cybertruck" → "Tesla Cybertruck", not "Cats" → "Cat"). */
function redirectOk(name: string, title: string): boolean {
  if (name === title || name.includes(" ")) return true;
  return title.toLowerCase().split(/[\s,()]+/).includes(name.toLowerCase());
}

type CacheEntry = { photo: Photo | null; checked: string };
type Cache = Record<string, CacheEntry>;
/** Bump when the matching rules change, so cached answers from older rules are discarded. */
const RULES_VERSION = 4;

async function api(params: Record<string, string>): Promise<any> {
  const url = `${API}?${new URLSearchParams({ action: "query", format: "json", formatversion: "2", ...params })}`;
  const res = await fetch(url, { headers: { "user-agent": USER_AGENT }, signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!res.ok) throw new Error(`Wikipedia API ${res.status}`);
  return res.json();
}

function plainText(html: string): string {
  return html.replace(/<[^>]+>/g, "").replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/\s+/g, " ").trim();
}

function artistName(raw: string): string {
  const text = plainText(raw);
  if (!text || /see file history|unknown author/i.test(text)) return "Wikimedia Commons contributors";
  return text.length > 60 ? `${text.slice(0, 57)}…` : text;
}

/** Looks up a batch of names: article (following redirects, skipping disambiguation pages) → free lead image → licence. */
async function lookupBatch(names: string[]): Promise<Map<string, Photo | null>> {
  const found = new Map<string, Photo | null>(names.map((n) => [n, null]));
  const pages = await api({ titles: names.join("|"), redirects: "1", prop: "pageimages|pageprops", piprop: "name", pilicense: "free", ppprop: "disambiguation" });
  const target = new Map<string, string>(names.map((n) => [n, n]));
  for (const step of [...(pages.query?.normalized ?? []), ...(pages.query?.redirects ?? [])] as { from: string; to: string }[]) {
    for (const [name, t] of target) if (t === step.from) target.set(name, step.to);
  }
  const fileOf = new Map<string, string>();
  for (const p of pages.query?.pages ?? []) {
    if (p.missing || p.pageprops?.disambiguation !== undefined || !p.pageimage) continue;
    if (NOT_A_PHOTO.test(p.pageimage.replace(/_/g, " "))) continue;
    fileOf.set(p.title, `File:${p.pageimage}`);
  }
  if (fileOf.size === 0) return found;

  const files = await api({ titles: [...new Set(fileOf.values())].join("|"), prop: "imageinfo", iiprop: "url|extmetadata|mime|size", iiurlwidth: String(THUMB_WIDTH), iiextmetadatafilter: "LicenseShortName|Artist|NonFree" });
  const info = new Map<string, any>();
  for (const p of files.query?.pages ?? []) info.set(p.title.replace(/_/g, " "), p.imageinfo?.[0]);
  for (const [name, title] of target) {
    if (!properTitle(title) || !redirectOk(name, title)) continue;
    const file = fileOf.get(title);
    const ii = file ? info.get(file.replace(/_/g, " ")) : undefined;
    if (!ii || !/^image\/(jpeg|png|webp)$/.test(ii.mime) || !ii.thumburl) continue;
    const meta = ii.extmetadata ?? {};
    const licence = plainText(meta.LicenseShortName?.value ?? "");
    if (meta.NonFree?.value || !FREE_LICENCE.test(licence)) continue;
    const large = ii.width >= 960 && ii.thumburl.includes(`/${THUMB_WIDTH}px-`) ? ii.thumburl.replace(`/${THUMB_WIDTH}px-`, "/960px-") : undefined;
    found.set(name, { subject: title, src: ii.thumburl, large, width: ii.thumbwidth, height: ii.thumbheight, artist: artistName(meta.Artist?.value ?? ""), licence, page: ii.descriptionurl });
  }
  return found;
}

/**
 * Finds free photos for many names at once, reusing results checked in the last week (cache file kept between runs).
 * Network problems never fail the edition: the story just gets its section artwork.
 */
export async function findPhotos(names: string[], cacheFile: string, now: Date): Promise<Map<string, Photo | null>> {
  let cache: Cache = {};
  try {
    const saved = JSON.parse(await readFile(cacheFile, "utf8")) as { version: number; entries: Cache };
    if (saved.version === RULES_VERSION) cache = saved.entries;
  } catch {
    // first run or unreadable cache: start empty
  }
  const fresh = (e: CacheEntry | undefined) => e && now.getTime() - Date.parse(e.checked) < CACHE_DAYS * 86_400_000;
  const unique = [...new Set(names)];
  const todo = unique.filter((n) => !fresh(cache[n]));
  for (let i = 0; i < todo.length; i += BATCH) {
    const batch = todo.slice(i, i + BATCH);
    try {
      for (const [name, photo] of await lookupBatch(batch)) cache[name] = { photo, checked: now.toISOString() };
    } catch (err) {
      console.log(`Image lookup failed for ${batch.length} names: ${err instanceof Error ? err.message : err}`);
    }
  }
  for (const [name, e] of Object.entries(cache)) if (!fresh(e)) delete cache[name];
  await mkdir(dirname(cacheFile), { recursive: true });
  await writeFile(cacheFile, JSON.stringify({ version: RULES_VERSION, entries: cache }));
  return new Map(unique.map((n) => [n, cache[n]?.photo ?? null]));
}
