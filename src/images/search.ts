import { USER_AGENT } from "../lib/http.js";
import type { ImageCache } from "./cache.js";
import { commonsPhoto, NOT_A_PHOTO, THUMB_WIDTH, type Photo } from "./wikimedia.js";

const COMMONS_API = "https://commons.wikimedia.org/w/api.php";
const OPENVERSE_API = "https://api.openverse.org/v1/images/";
const TIMEOUT_MS = 20_000;
const RESULTS = 10;
const MIN_WIDTH = 800;

/**
 * A found photo of a different event would mislead next to this story (a protest photo on a shooting story), so
 * pictures whose titles describe an incident or show people at one are skipped; places, buildings and things remain.
 */
const EVENT_PHOTO =
  /\b(protests?|protesters?|demonstrations?|demonstrators?|manifestations?|manifestants?|rally|rallies|riots?|funerals?|vigils?|victims?|killed|dead|deaths?|corpses?|bod(y|ies)|murders?|massacre|shootings?|attacks?|(air)?strikes?|bomb(s|ed|ings?)?|missiles?|shelling|explosions?|destroyed|damaged?|ruins|war|battle|injured|wounded|blood|arrests?|arrested|mugshot|crash(es|ed)?|wreck(age)?|accidents?|hostages?|executions?|terror(ism|ist)?|aftermath|cremation|storming|stormed|insurrection|mob|marathon|parade|sponsors?|ceremony|celebrations?|vs|versus)\b/i;

/** Searches are for places and things; a picture of a particular person could be taken for someone in the story. */
const PERSON_PHOTO =
  /\b(man|men|woman|women|boy|girls?|child(ren)?|kids?|portrait|headshot|selfie|judge|senator|minister|president|mayor|officer|actor|actress|singer|speaking|speech|interview|meets|meeting|visits?|visiting|advocate|lawyer|expert|member)\b/i;

/** Old photos, scans and generated images: a 1927 team photo or a scanned catalogue isn't a file photo of today. */
const NOT_CURRENT =
  /\bc?(1[0-8]\d\d|19[0-8]\d)\b|\b(LOC|DALL|Midjourney|Stable Diffusion|AI[- ]generated|catalogue|catalog|page|scan(ned)?|poster|leaflet|brochure|advertisement|newspaper|magazine|cover|screenshot|ranking|graph|table|statistics|infographic|illustration|drawing|painting|engraving|lithograph|postcard|stamp|Wellcome)\b/i;

const STOP = new Set(["the", "and", "of", "in", "on", "at", "for", "with", "from", "a", "an", "to", "by"]);

function fold(text: string): string {
  return text.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
}

/**
 * Search engines also match file descriptions, which can be about anything; the title must carry at least half the
 * query's words ("Walhalla Victoria" needs "walhalla" or "victoria", and a two-word query one of them).
 */
function relevant(query: string, title: string): boolean {
  const words = fold(query).split(/[^\p{L}\p{N}]+/u).filter((w) => w.length >= 3 && !STOP.has(w));
  const have = new Set(fold(title).split(/[^\p{L}\p{N}]+/u));
  const hits = words.filter((w) => have.has(w) || have.has(`${w}s`) || (w.endsWith("s") && have.has(w.slice(0, -1)))).length;
  return words.length > 0 && hits >= Math.ceil(words.length / 2);
}

/** A file or photo title as a caption: "File:Walhalla Victoria 20240722 112153.jpg" → "Walhalla Victoria". */
export function captionFromTitle(title: string): string {
  const text = title
    .replace(/^File:/, "")
    .replace(/\.(jpe?g|png|webp|tiff?|gif)$/i, "")
    .replace(/\s*-\s*geograph\.org\.uk.*$/i, "")
    .replace(/\(\d{6,}\)/g, "")
    .replace(/[_]+/g, " ")
    .replace(/\b(IMG|DSC|DSCF|P)\s?\d+\b/gi, "")
    .replace(/\b\d{6,}\b/g, "")
    .replace(/\b\d{1,3}\b(?=\s*$)/, "")
    .replace(/\s{2,}/g, " ")
    .replace(/^[\s,.\-–]+|[\s,.\-–(]+$/g, "")
    .trim();
  return text.length > 90 ? `${text.slice(0, 87)}…` : text;
}

function usableTitle(query: string, title: string): boolean {
  const text = title.replace(/_/g, " ");
  return !NOT_A_PHOTO.test(text) && !EVENT_PHOTO.test(text) && !PERSON_PHOTO.test(text) && !NOT_CURRENT.test(text) && relevant(query, text);
}

/** A query that asks for an incident or a person would find the wrong kind of picture whatever the filters. */
export function usableQuery(query: string): boolean {
  return !EVENT_PHOTO.test(query) && !PERSON_PHOTO.test(query) && !/\b(police|polic[ií]a)\b.*\b(tape|line)\b/i.test(query);
}

/** Landscape pictures fill the 16:9 card; a portrait one is only used when nothing else fits. */
function best(photos: Photo[]): Photo | null {
  return photos.find((p) => p.width >= p.height) ?? photos[0] ?? null;
}

/** The host refused us (HTTP 429, or 403 from Openverse's anonymous limit): stop searching it for the rest of this edition. */
class SlowDown extends Error {}

async function getJson(url: string): Promise<any> {
  const res = await fetch(url, { headers: { "user-agent": USER_AGENT }, signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (res.status === 429 || res.status === 403) throw new SlowDown(`${new URL(url).host} refused (${res.status})`);
  if (!res.ok) throw new Error(`${new URL(url).host} ${res.status}`);
  return res.json();
}

/** Photos Commons reviewers have judged well made: preferred, since they are sharper and better framed. */
const REVIEWED = ["Category:Quality images", "Category:Valued images", "Category:Featured pictures on Wikimedia Commons"];

/** Wikimedia Commons file search: large bitmaps, reviewed photos first, otherwise in the search engine's ranking order. */
async function commonsSearch(query: string): Promise<Photo | null> {
  const params = new URLSearchParams({
    action: "query", format: "json", formatversion: "2", generator: "search", gsrnamespace: "6", gsrlimit: String(RESULTS),
    gsrsearch: `${query} filetype:bitmap filew:>${MIN_WIDTH - 1}`, prop: "imageinfo|categories", iiprop: "url|extmetadata|mime|size",
    iiurlwidth: String(THUMB_WIDTH), iiextmetadatafilter: "LicenseShortName|Artist|NonFree", clcategories: REVIEWED.join("|"), cllimit: "max",
  });
  const body = await getJson(`${COMMONS_API}?${params}`);
  const pages = ((body.query?.pages ?? []) as any[]).sort((a, b) => Number(!!b.categories?.length) - Number(!!a.categories?.length) || a.index - b.index);
  const photos: Photo[] = [];
  for (const p of pages) {
    if (!usableTitle(query, p.title)) continue;
    const photo = commonsPhoto(captionFromTitle(p.title), "search", p.imageinfo?.[0]);
    if (photo) photos.push(photo);
  }
  return best(photos);
}

const OPENVERSE_LICENCE: Record<string, string> = { by: "CC BY", "by-sa": "CC BY-SA", cc0: "CC0", pdm: "Public domain" };

/**
 * Openverse (openly licensed photos from Flickr and other collections). Only licences that allow changes and any use;
 * Commons results are skipped since Commons was searched first.
 */
async function openverseSearch(query: string): Promise<Photo | null> {
  const params = new URLSearchParams({ q: query, license_type: "commercial,modification", page_size: String(RESULTS), mature: "false" });
  const body = await getJson(`${OPENVERSE_API}?${params}`);
  const photos: Photo[] = [];
  for (const r of (body.results ?? []) as any[]) {
    const licence = OPENVERSE_LICENCE[r.license];
    if (!licence || r.source === "wikimedia" || !r.url?.startsWith("https://") || !r.foreign_landing_url) continue;
    if ((r.width ?? 0) < MIN_WIDTH || !r.height || !usableTitle(query, r.title ?? "")) continue;
    // Flickr serves the same photo at 640 px with a "_z" suffix in place of the 1024 px "_b".
    const small = /_b\.jpg$/.test(r.url) ? r.url.replace(/_b\.jpg$/, "_z.jpg") : null;
    const scale = small ? 640 / r.width : 1;
    photos.push({
      subject: captionFromTitle(r.title),
      kind: "search",
      src: small ?? r.url,
      large: small ? r.url : undefined,
      width: Math.round(r.width * scale),
      height: Math.round(r.height * scale),
      artist: (r.creator ?? "").slice(0, 60) || "Unknown photographer",
      licence: r.license_version && r.license !== "cc0" && r.license !== "pdm" ? `${licence} ${r.license_version}` : licence,
      via: r.source === "flickr" ? "Flickr" : r.provider ?? r.source,
      page: r.foreign_landing_url,
    });
  }
  return best(photos);
}

/**
 * Searches each edition may make. Commons and Openverse both limit how fast anonymous clients may search, so a cold
 * start (empty cache) is spread over a few hourly editions; after that most answers come from the cache.
 */
export interface SearchBudget {
  commons: number;
  openverse: number;
}

/** Pause between Commons searches; Wikimedia asks API clients to make requests one at a time. */
const COMMONS_GAP_MS = 250;

/**
 * Searches Commons, then (budget allowing) Openverse, for one query. Answers, including "nothing found", are cached
 * for a week; a failure or an exhausted budget is not cached, so the next edition tries again.
 */
export async function searchPhoto(query: string, cache: ImageCache, budget: SearchBudget): Promise<Photo | null> {
  if (!usableQuery(query)) return null;
  const key = `search:${fold(query)}`;
  if (cache.has(key)) return cache.get<Photo | null>(key) ?? null;
  if (budget.commons <= 0) return null;
  try {
    budget.commons--;
    await new Promise((r) => setTimeout(r, COMMONS_GAP_MS));
    let photo = await commonsSearch(query);
    if (!photo) {
      if (budget.openverse <= 0) return null;
      budget.openverse--;
      photo = await openverseSearch(query);
    }
    cache.set(key, photo);
    return photo;
  } catch (err) {
    if (err instanceof SlowDown) {
      if (err.message.startsWith("commons")) budget.commons = 0;
      else budget.openverse = 0;
    }
    console.log(`Photo search failed for "${query}": ${err instanceof Error ? err.message : err}`);
    return null;
  }
}
