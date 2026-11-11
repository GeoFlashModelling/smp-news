import { USER_AGENT } from "../lib/http.js";
import type { ImageCache } from "./cache.js";

/** A free-licensed photo, with everything needed to credit it. Hot-linked from its host, never copied. */
export interface Photo {
  /** What the photo shows: the Wikipedia subject ("Stephen Miller", "Melbourne") or a found photo's own title. */
  subject: string;
  /** "named": the lead photo of a person, organisation or place's Wikipedia article; "search": found by searching. */
  kind: "named" | "search";
  src: string;
  /** 960 px (or larger) version for the story page, when the original is that big. */
  large?: string;
  width: number;
  height: number;
  artist: string;
  licence: string;
  /** Where the photo lives ("Wikimedia Commons", "Flickr"). */
  via: string;
  /** The photo's own page: shows the full licence and author. */
  page: string;
  /** Wikipedia's short description of the subject ("New Zealand comedian"); kept for "person" lookups. */
  description?: string;
  /** A found photo's whole title, when the caption had to be shortened: the place check reads all of it. */
  title?: string;
  /** Where the camera was, when the file records it: tells a Canberra building from one in Savannah, Georgia. */
  lat?: number;
  lon?: number;
}

/** File details asked of Commons: the licence and author for the credit, and the camera's position when recorded. */
export const META_FIELDS = "LicenseShortName|Artist|NonFree|GPSLatitude|GPSLongitude";

/** How strictly a looked-up name must match: see lookupBatch. */
export type LookupMode = "subject" | "named" | "place" | "person";

const API = "https://en.wikipedia.org/w/api.php";
const BATCH = 50;
export const THUMB_WIDTH = 500;
const TIMEOUT_MS = 20_000;

/** Only licences that allow reuse with credit. Anything else (fair use, "all rights reserved", NC/ND) is refused. */
export const FREE_LICENCE = /^(CC0|CC BY(-SA)? \d(\.\d)?( \w+)?|Public domain|PD\b.*|Attribution|GFDL.*|No restrictions)$/i;
/** Lead images and search results that aren't news pictures. */
export const NOT_A_PHOTO = /\b(logo|flag|coat[_ ]of[_ ]arms|seal[_ ]of|emblem|map|locator|location|projection|hemisphere|LamAz|orthographic|signature|diagram|chart|icon|wordmark|banner|svg)\b/i;

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

/**
 * A one-word name is only trusted when Wikipedia's short description says it is a named place, organisation or
 * event: "Kyiv" (capital city), "Qantas" (airline), "Diwali" (festival); not "Arsenal" (military building) or
 * "Television" (telecommunication medium) when the story means the football club or the band.
 */
const NAMED_THING =
  /\b(city|capital|town|suburb|village|country|nation|state|territory|province|region|island|archipelago|peninsula|river|lake|mountain|volcano|strait|gulf|sea|ocean|desert|company|corporation|conglomerate|multinational|airline|carrier|bank|retailer|manufacturer|brand|startup|firm|festival|holiday|celebration|organi[sz]ation|agency|ministry|department|parliament|party|union|university|college|school|hospital|stadium|airport|museum|zoo|newspaper|broadcaster|network|programme|program|mission|spacecraft|telescope|rocket|satellite|league|tournament|championship|competition|cup|games)\b/i;

/** A place worth showing when a story has no photo of its subject: "Walhalla" (town in Victoria), "Kraków" (city in Poland). */
const PLACE =
  /\b(city|capital|town|suburb|village|locality|state of|territory|province|region|island|county|shire|municipality|district|neighbourhood|borough|precinct|square|street|park|harbour|bay|beach|river|lake|mountain|landmark|building|barracks|bridge|stadium|ground|oval|arena|venue|racecourse|racetrack|circuit|velodrome|showground|museum|cathedral|church|temple|palace|castle|monument|airport|port)\b/i;

/**
 * The notorious, whose portrait would offend next to any story: Wikipedia describes them so ("Dictator of Germany from
 * 1933 to 1945", "Australian mass murderer"), or they are named here because their descriptions don't say it.
 */
const NOTORIOUS = /\b(dictator|mass murderer|mass shooter|spree killer|serial killer|terrorists?|war criminal|genocide|Nazi|al-Qaeda|Islamic State)\b/i;
const NOTORIOUS_PEOPLE = new Set([
  "Joseph Stalin", "Mao Zedong", "Benito Mussolini", "Heinrich Himmler", "Joseph Goebbels", "Hermann Göring", "Reinhard Heydrich",
  "Adolf Eichmann", "Josef Mengele", "Idi Amin", "Saddam Hussein", "Slobodan Milošević", "Ratko Mladić", "Radovan Karadžić", "Augusto Pinochet",
]);
/** After this long the pain has worn off: a bushranger or Jack the Ripper can be pictured like any historical figure. */
const WORN_OFF_YEARS = 100;

/** Everyone else may be shown, living or historical. */
export function notToShow(title: string, description: string, year: number): boolean {
  if (!NOTORIOUS.test(description) && !NOTORIOUS_PEOPLE.has(title)) return false;
  const years = (description.match(/\b\d{3,4}\b/g) ?? []).map(Number);
  return /\bsince\b/i.test(description) || !years.length || Math.max(...years) > year - WORN_OFF_YEARS;
}

async function api(params: Record<string, string>): Promise<any> {
  const url = `${API}?${new URLSearchParams({ action: "query", format: "json", formatversion: "2", ...params })}`;
  const res = await fetch(url, { headers: { "user-agent": USER_AGENT }, signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!res.ok) throw new Error(`Wikipedia API ${res.status}`);
  return res.json();
}

export function plainText(html: string): string {
  return html.replace(/<[^>]+>/g, "").replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/\s+/g, " ").trim();
}

export function artistName(raw: string): string {
  const text = plainText(raw);
  if (!text || /see file history|unknown author/i.test(text)) return "Wikimedia Commons contributors";
  return text.length > 60 ? `${text.slice(0, 57)}…` : text;
}

/** The year a Commons photo was taken ("circa 1955" → 1955), or null when the file doesn't say. */
export function yearTaken(ii: any): number | null {
  const year = plainText(ii?.extmetadata?.DateTimeOriginal?.value ?? "").match(/\b(1[89]\d\d|20\d\d)\b/);
  return year ? Number(year[1]) : null;
}

/**
 * A Commons file's details (from imageinfo with url|extmetadata|mime|size) as a Photo, or null when it isn't a
 * free-licensed photo.
 */
export function commonsPhoto(subject: string, kind: Photo["kind"], ii: any): Photo | null {
  if (!ii || !/^image\/(jpeg|png|webp)$/.test(ii.mime) || !ii.thumburl) return null;
  const meta = ii.extmetadata ?? {};
  const licence = plainText(meta.LicenseShortName?.value ?? "");
  if (meta.NonFree?.value || !FREE_LICENCE.test(licence)) return null;
  const large = ii.width >= 960 && ii.thumburl.includes(`/${THUMB_WIDTH}px-`) ? ii.thumburl.replace(`/${THUMB_WIDTH}px-`, "/960px-") : undefined;
  const lat = Number.parseFloat(plainText(meta.GPSLatitude?.value ?? ""));
  const lon = Number.parseFloat(plainText(meta.GPSLongitude?.value ?? ""));
  const where = Number.isFinite(lat) && Number.isFinite(lon) && (lat !== 0 || lon !== 0) ? { lat, lon } : {};
  return { subject, kind, src: ii.thumburl, large, width: ii.thumbwidth, height: ii.thumbheight, artist: artistName(meta.Artist?.value ?? ""), licence, via: "Wikimedia Commons", page: ii.descriptionurl, ...where };
}

/**
 * Looks up a batch of names: article (following redirects, skipping disambiguation pages) → free lead image → licence.
 * "subject" names come from headline wording, so one-word names must be described as a named thing; "named" names are
 * exact article titles suggested for the story; "place" names must be described as a place; "person" names (someone
 * who died) must be a full name whose article has exactly that title, and keep the description for checking.
 */
async function lookupBatch(names: string[], mode: LookupMode): Promise<Map<string, Photo | null>> {
  const found = new Map<string, Photo | null>(names.map((n) => [n, null]));
  const pages = await api({ titles: names.join("|"), redirects: "1", prop: "pageimages|pageprops|description", piprop: "name", pilicense: "free", ppprop: "disambiguation" });
  const target = new Map<string, string>(names.map((n) => [n, n]));
  for (const step of [...(pages.query?.normalized ?? []), ...(pages.query?.redirects ?? [])] as { from: string; to: string }[]) {
    for (const [name, t] of target) if (t === step.from) target.set(name, step.to);
  }
  const fileOf = new Map<string, string>();
  const description = new Map<string, string>();
  for (const p of pages.query?.pages ?? []) {
    if (p.missing || p.pageprops?.disambiguation !== undefined || !p.pageimage) continue;
    description.set(p.title, p.description ?? "");
    // Run-together place names ("ChinaDaqingLindian.png") are locator maps.
    if (NOT_A_PHOTO.test(p.pageimage.replace(/_/g, " ")) || /^(\p{Lu}\p{Ll}+){3,}\.(png|gif)$/u.test(p.pageimage)) continue;
    fileOf.set(p.title, `File:${p.pageimage}`);
  }
  if (fileOf.size === 0) return found;

  const files = await api({ titles: [...new Set(fileOf.values())].join("|"), prop: "imageinfo", iiprop: "url|extmetadata|mime|size", iiurlwidth: String(THUMB_WIDTH), iiextmetadatafilter: META_FIELDS });
  const info = new Map<string, any>();
  for (const p of files.query?.pages ?? []) info.set(p.title.replace(/_/g, " "), p.imageinfo?.[0]);
  for (const [name, title] of target) {
    const desc = description.get(title) ?? "";
    if (mode === "place" ? !PLACE.test(desc) : !properTitle(title) || notToShow(title, desc, new Date().getFullYear())) continue;
    if (mode === "subject" && (!redirectOk(name, title) || (!name.includes(" ") && !NAMED_THING.test(desc)))) continue;
    if (mode === "person" && (title.replace(/\s*\(.*\)$/, "") !== name || !name.includes(" ") || !desc)) continue;
    const file = fileOf.get(title);
    const photo = commonsPhoto(title, "named", file ? info.get(file.replace(/_/g, " ")) : undefined);
    if (photo) found.set(name, mode === "person" ? { ...photo, description: desc } : photo);
  }
  return found;
}

/**
 * Hand-picked Commons files (name → caption), re-checked weekly so a file that is deleted or relicensed drops out.
 */
export async function findFiles(files: Map<string, string>, cache: ImageCache): Promise<Map<string, Photo | null>> {
  const key = (f: string) => `file2:${f}`;
  const todo = [...files.keys()].filter((f) => !cache.has(key(f)));
  for (let i = 0; i < todo.length; i += BATCH) {
    const batch = todo.slice(i, i + BATCH);
    try {
      const params = new URLSearchParams({ action: "query", format: "json", formatversion: "2", titles: batch.map((f) => `File:${f}`).join("|"), prop: "imageinfo", iiprop: "url|extmetadata|mime|size", iiurlwidth: String(THUMB_WIDTH), iiextmetadatafilter: META_FIELDS });
      const res = await fetch(`https://commons.wikimedia.org/w/api.php?${params}`, { headers: { "user-agent": USER_AGENT }, signal: AbortSignal.timeout(TIMEOUT_MS) });
      if (!res.ok) throw new Error(`Commons API ${res.status}`);
      const pages = ((await res.json()).query?.pages ?? []) as any[];
      const info = new Map(pages.map((p) => [p.title.replace(/^File:/, "").replace(/_/g, " "), p.imageinfo?.[0]]));
      for (const f of batch) cache.set(key(f), commonsPhoto(files.get(f)!, "search", info.get(f.replace(/_/g, " "))));
    } catch (err) {
      console.log(`Library photo check failed: ${err instanceof Error ? err.message : err}`);
    }
  }
  // Today's caption, so a reworded caption shows at once rather than when the cached answer expires.
  return new Map([...files.keys()].map((f) => {
    const photo = cache.get<Photo | null>(key(f)) ?? null;
    return [f, photo && { ...photo, subject: files.get(f)! }];
  }));
}

/**
 * Finds free photos for many names at once, reusing answers from the last week. Network problems never fail the
 * edition: the story just falls through to the next kind of picture.
 */
export async function findPhotos(names: string[], mode: LookupMode, cache: ImageCache): Promise<Map<string, Photo | null>> {
  // "wiki4": answers from before camera positions were kept are looked up again rather than kept for the rest of the week.
  const key = (n: string) => `wiki4:${mode}:${n}`;
  const unique = [...new Set(names)];
  const todo = unique.filter((n) => !cache.has(key(n)));
  for (let i = 0; i < todo.length; i += BATCH) {
    const batch = todo.slice(i, i + BATCH);
    try {
      for (const [name, photo] of await lookupBatch(batch, mode)) cache.set(key(name), photo);
    } catch (err) {
      console.log(`Image lookup failed for ${batch.length} names: ${err instanceof Error ? err.message : err}`);
    }
  }
  return new Map(unique.map((n) => [n, cache.get<Photo | null>(key(n)) ?? null]));
}
