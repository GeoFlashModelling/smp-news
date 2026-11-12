import { geminiJson } from "../ai/gemini.js";
import type { Story } from "../lib/stories.js";
import type { ImageCache } from "./cache.js";
import type { Photo } from "./wikimedia.js";

/**
 * Searches and name lookups only match words, so a photo can share a word with a story and still miss its point
 * (owner, 11 Nov 2026: a basketball court on a candidate dropped over remarks to a basketballer). A free model reads
 * each story beside its chosen photo's caption and says whether the photo suits the story as a whole.
 */
const MODELS = ["gemini-3.5-flash-lite", "gemini-3.1-flash-lite"];
const BATCH = 25;
/** Free requests per edition: the first run checks about 200 shown photos, then only new choices need asking. */
export const VET_REQUESTS = 8;
/** All rounds of checking together stop starting requests after this long; a busy model gets one try of up to a minute. */
export const VET_MINUTES = 2;
const CALL_TIMEOUT_MS = 60_000;
const REQUEST_GAP_MS = 4_500;
const REJECTIONS_LOGGED = 25;

const SCHEMA = {
  type: "object",
  properties: {
    photos: {
      type: "array",
      items: {
        type: "object",
        properties: { id: { type: "string" }, fits: { type: "boolean" }, reason: { type: "string" } },
        required: ["id", "fits", "reason"],
      },
    },
  },
  required: ["photos"],
};

const SYSTEM = `You check pictures for an Australian news website. Each picture is a free-licensed file photo, never a photo of the event itself. For each story you get its section, headlines, the start of a report, and the caption of the photo chosen for it.

Answer fits true when a reader would see the photo as a sensible illustration of what the story is about as a whole: its main person, organisation, product or place, the town, city or region where it happens (Gloucester for an arrest in Gloucestershire, Melbourne for a story about Melbourne's north), or its topic (that country's parliament for a political story, a courthouse or gavel for a court case, the ground or the sport for a match, a data centre for an AI story, a telescope or the night sky for an astronomy story).

Answer fits false when the photo shows:
- something only mentioned in passing, or a thing or setting from an allegation (a basketball court on a story about a candidate dropped over remarks to a basketballer): it could look like the scene;
- a different thing that shares a name or a word (cut marks on a bone labelled "anthropic" for a story about the AI company Anthropic; a street address or office block for a story about an AI product);
- a town or city that is only where the researchers, company or people are based, not what the story is about (a city skyline on a story about a distant galaxy);
- something unrelated to the story's subject (a touch screen on an inquiry into the building industry; a courthouse on a story about a TV series that isn't about a court case);
- a particular place (a named building, street, town, city, landmark or shop) in a different country, or a different Australian state or city, from where the story happens: a courthouse in Arkansas for an inquiry in Victoria, a petrol station in India for New Zealand fuel prices, Brisbane for a train stuck in a New Zealand tunnel, bushland in Sydney for a search in Victoria. "taken in", when given, is where the photo was taken. A thing that looks the same anywhere (a laptop, a gavel, a cricket ball, a koala) is not a place;
- anything that could mislead a reader about who or what was involved.
Photos of the people involved or of the event are never used, so never refuse a photo for not showing the person, the suspect, the match or the event itself: a place or topic stands in for them (a parliament for a candidate dropped over a post, a city where an arrest happened). When the photo plainly relates to the story's subject, place or topic, answer true even if a better photo might exist.
reason: up to 8 words.`;

export interface VetItem {
  story: Story;
  photo: Photo;
  /** Where the photo was taken, from its camera position, when known. */
  takenIn?: string;
}

/** Bump when the instructions change, so earlier verdicts are asked again (the rest of the image cache stays). */
const VET_VERSION = 3;
const verdictKey = (id: string, photo: Photo) => `vet${VET_VERSION}:${id}|${photo.src.split("?")[0]}`;

/** The cached verdict on a story's photo: true suits, false refused, undefined not yet asked. */
export function verdict(cache: ImageCache, id: string, photo: Photo): boolean | undefined {
  return cache.get<boolean>(verdictKey(id, photo));
}

function tidy(text: string | undefined, max: number): string {
  return (text ?? "").replace(/["“”]/g, "").replace(/\s+/g, " ").trim().slice(0, max);
}
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Asks about photos with no cached verdict, most prominent first, within the free requests left this edition.
 * Only titles, report descriptions and captions are sent. Photos left unasked are shown and asked about next time.
 * Returns how many were refused.
 */
export async function vetPhotos(items: VetItem[], cache: ImageCache, budget: { requests: number; until: number }): Promise<number> {
  const todo = items.filter((i) => verdict(cache, i.story.id, i.photo) === undefined);
  if (!todo.length || !process.env.GEMINI_API_KEY || process.env.PHOTO_AI === "off") return 0;
  let refused = 0;
  let m = 0;
  for (let i = 0; i < todo.length && budget.requests > 0 && m < MODELS.length && Date.now() < budget.until; ) {
    if (i) await sleep(REQUEST_GAP_MS);
    budget.requests--;
    const batch = todo.slice(i, i + BATCH);
    const lines = batch.map(({ story, photo, takenIn }, n) =>
      JSON.stringify({
        id: String(n + 1),
        section: story.section,
        headlines: [story.headline.title, ...story.items.filter((it) => it !== story.headline).slice(0, 2).map((it) => it.title)],
        report: tidy(story.items.find((it) => it.summary)?.summary, 300),
        photo: tidy([photo.title ?? photo.subject, photo.description].filter(Boolean).join(": "), 200),
        ...(takenIn ? { "taken in": takenIn } : {}),
      }),
    );
    try {
      const reply = await geminiJson(MODELS[m]!, SYSTEM, lines.join("\n"), SCHEMA, { retries: 0, timeoutMs: CALL_TIMEOUT_MS });
      const answers = ((reply.json as { photos?: unknown[] } | null)?.photos ?? []) as Record<string, unknown>[];
      for (const a of answers) {
        const item = batch[Number(String(a.id ?? "").trim()) - 1];
        if (!item || typeof a.fits !== "boolean") continue;
        cache.set(verdictKey(item.story.id, item.photo), a.fits);
        if (!a.fits && refused++ < REJECTIONS_LOGGED) {
          console.log(`Photo refused as off the point: "${item.photo.subject}" for "${item.story.headline.title}" (${tidy(String(a.reason ?? ""), 80)})`);
        }
      }
      i += BATCH;
    } catch (err) {
      console.log(`Photo check by ${MODELS[m]} failed (${batch.length} photos; trying the next model): ${err instanceof Error ? err.message : err}`);
      m++;
    }
  }
  return refused;
}
