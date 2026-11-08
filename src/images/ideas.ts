import { geminiJson } from "../ai/gemini.js";
import type { Story } from "../lib/stories.js";
import type { ImageCache } from "./cache.js";
/** What to look for when picturing a story. */
export interface PhotoIdea {
  /** Exact Wikipedia article title of the story's main subject, or "" when there is none (or it's a court/crime story). */
  subject: string;
  /** Short image-search phrases, most specific first: the place, setting or object at the centre of the story. */
  searches: string[];
  /** A common thing, animal or scene that stands for the story's topic ("wild cat", "Wi-Fi router"); a free photo of it surely exists. */
  theme?: string;
}

/** Small batches: with more stories per request, Flash Lite starts giving one story's places to its neighbours. */
const BATCH = 15;
/**
 * Free tier: each model allows 15 requests a minute and 500 a day, so 12 an hour each (288 a day). When one model's
 * share is used, or it fails, the next takes over. Leftover stories wait an hour.
 */
const FREE_MODELS = ["gemini-3.5-flash-lite", "gemini-3.1-flash-lite"];
const REQUESTS_PER_MODEL = 12;
const REQUEST_GAP_MS = 4_500;
const MAX_SEARCHES = 3;

const SCHEMA = {
  type: "object",
  properties: {
    stories: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: { type: "string" },
          subject: { type: "string" },
          searches: { type: "array", items: { type: "string" }, maxItems: MAX_SEARCHES },
          theme: { type: "string" },
        },
        required: ["id", "subject", "searches", "theme"],
      },
    },
  },
  required: ["stories"],
};

const SYSTEM = `You choose pictures for an Australian news website. Pictures are free-licensed file photos from Wikipedia and Wikimedia Commons, never photos of the event itself.

For each story you get its id, whether it is a court or crime story ("legal"), and its headlines. Return for each story:
- subject: the exact English Wikipedia article title of the one well-known person, organisation, team, product or place the story is mainly about, when a photo of it would suit the story. Examples: "Pope Leo XIV", "Real Madrid CF", "Australia national rugby union team", "Tesla Cybertruck", "Victoria Barracks, Sydney". Use "" when there is no single clear subject, when the subject is a private individual, or when legal is true.
- searches: 1 to 3 short image-search phrases (2 to 4 words, no punctuation), most specific first, for a photo that illustrates the story without showing the event: the place where it happened ("Melbourne skyline", "Main Market Square Kraków", "Walhalla Victoria"), or the setting or object at its centre ("Hawaiian pizza", "open pit gold mine Western Australia", "Parliament House Canberra", "rugby union match").
- theme: always one common thing, animal, food, vehicle, kind of building or landscape (1 to 3 words) that stands for the story's topic, so ordinary that a free photo of it surely exists. Examples: "wild cat", "snake", "racing bicycle", "wine glasses", "Wi-Fi router", "electric pickup truck", "video game controller", "glacier", "sake bottles", "cargo ship", "Australian rules football", "courthouse".
Searches and themes are for places, buildings, landscapes, animals and objects only: never people (no names, no "police officer", "judge" or "crowd"), never incidents ("riot", "protest", "crash", "airstrike"), never logos. Treat each story on its own: only name a place the story's own headlines point to. When legal is true, the place or building is especially important ("Melbourne laneway", "Supreme Court of Victoria building").`;

/**
 * Last resort before artwork: common news topics, each with a hand-picked Wikimedia Commons photo (file name) and
 * how the caption describes it. Checked by eye; no people's faces, nothing showing a particular incident.
 */
export const TOPICS: { match: RegExp; file: string; caption: string }[] = [
  { match: /\bbushfires?\b|\bwildfires?\b|\bfirefighters?\b/i, file: "Fesa 669 01 gnangarra.jpg", caption: "a firefighting helicopter in Western Australia" },
  { match: /\bfloods?\b|\bflooding\b/i, file: "Flooded fields in Keralup, Western Australia, August 2021 01.jpg", caption: "flooded fields in Keralup, Western Australia" },
  { match: /\bcyclones?\b|\bstorms?\b|\bcold front\b|\bthunderstorms?\b|\bwild weather\b/i, file: "Storm clouds rolling over the Australian Capital Territory.jpg", caption: "storm clouds over the ACT" },
  { match: /\bheatwave\b|\bheat wave\b|\bscorcher\b/i, file: "Cottesloe Beach from the south, March 2022.jpg", caption: "Cottesloe Beach, Perth" },
  { match: /\bdrought\b/i, file: "Drought, Hughenden, Queensland, Australia 2014-08-09 11-19.jpg", caption: "drought near Hughenden, Queensland" },
  { match: /\bcourt\b|\btrial\b|\bsentenced?\b|\bguilty\b|\bjury\b|\bcharged\b|\bmagistrates?\b/i, file: "Legal Gavel (27571702173).jpg", caption: "a judge's gavel" },
  { match: /\bpolice\b|\bdetectives?\b|\bstabbed\b|\bstabbing\b|\bmissing\b|\bcrash\b/i, file: "NSW Police car 2006 NYE.jpg", caption: "a police car at night" },
  { match: /\bReserve Bank\b|\bRBA\b|\binterest rates?\b|\binflation\b|\brate (cut|rise|hike)s?\b/i, file: "RBA Building August 2025.jpg", caption: "the Reserve Bank of Australia, Sydney" },
  { match: /\bASX\b|\bsharemarket\b|\bshare market\b|\bstocks?\b/i, file: "Australian Securities Exchange entrance.jpg", caption: "the Australian Securities Exchange" },
  { match: /\bhousing\b|\brents?\b|\brenters\b|\bhouse prices?\b|\bmortgages?\b|\bhome loans?\b/i, file: "Walking around the suburb of Kelso, Townsville, Australia 05.jpg", caption: "a suburban street in Kelso, Townsville" },
  { match: /\bhospitals?\b|\bnurses?\b|\bdoctors?\b|\bpatients?\b|\bemergency department\b|\bramping\b/i, file: "Royal Perth Hospital, 2023.jpg", caption: "Royal Perth Hospital" },
  { match: /\bschools?\b|\bteachers?\b|\bprincipals?\b/i, file: "Fairfield Public School classrooms.jpg", caption: "school classrooms in Fairfield, NSW" },
  { match: /\buniversit(y|ies)\b|\bTAFE\b/i, file: "Edith Cowan University, City Campus, May 2026 01.jpg", caption: "Edith Cowan University's city campus, Perth" },
  { match: /\bmines?\b|\bmining\b|\bminers?\b|\bgold price\b|\biron ore\b|\blithium\b/i, file: "Kalgoorlie Super Pit, October 2023 01.jpg", caption: "the Super Pit gold mine, Kalgoorlie" },
  { match: /\bpetrol\b|\bfuel prices?\b|\bdiesel\b/i, file: "Shell Service Station, Upper Swan, WA.jpg", caption: "a service station in Upper Swan, WA" },
  { match: /\belections?\b|\bvoters?\b|\bpolling\b|\bballots?\b|\bby-election\b/i, file: "Democracy Sausage.jpg", caption: "a democracy sausage at a polling place" },
  { match: /\bFederal Parliament\b|\bAlbanese\b|\bCanberra\b|\bSenate\b|\bfederal budget\b/i, file: "Parliament House at dusk, Canberra ACT.jpg", caption: "Parliament House, Canberra" },
  { match: /\bNASA\b|\bastronauts?\b|\brockets?\b|\bspace(craft|X)?\b/i, file: "SES-10 Launch - world's first reflight of an orbital class rocket (33361035200).jpg", caption: "a rocket launch" },
  { match: /\bAI\b|\bartificial intelligence\b|\bdata cent(re|er)s?\b|\bchatbots?\b/i, file: "BalticServers data center.jpg", caption: "a data centre" },
  { match: /\bairlines?\b|\bflights?\b|\bairports?\b|\bQantas\b|\bVirgin Australia\b/i, file: "Perth Airport Qantas terminal, July 2022, 01.jpg", caption: "Perth Airport" },
  { match: /\btrains?\b|\brailway\b|\bmetro\b|\bpublic transport\b/i, file: "Transperth B-series train at Thornlie Station, September 2026 (cropped).jpg", caption: "a Transperth train at Thornlie" },
  { match: /\broad toll\b|\bhighway\b|\bfreeway\b|\btraffic\b|\bcongestion\b/i, file: "Perth skyline and Kwinana Freeway 2009.jpg", caption: "the Kwinana Freeway, Perth" },
  { match: /\bAFLW?\b|\bBrownlow\b/i, file: "AFL Grand Final 2010 on the Melbourne Cricket Ground.jpg", caption: "an AFL match at the MCG" },
  { match: /\bNRLW?\b|\brugby league\b|\bState of Origin\b/i, file: "2013 Rugby League World Cup, Scotland vs. Italy in Workington.jpg", caption: "a rugby league match" },
  { match: /\brugby\b|\bWallabies\b|\bSpringboks\b|\bAll Blacks\b|\bWallaroos\b/i, file: "Rugby Lineout.jpg", caption: "a rugby union lineout" },
  { match: /\bcricket\b|\bAshes\b|\bTest match\b|\bBig Bash\b/i, file: "Ashes 2010-11 3rd Test at the WACA day2.jpg", caption: "a Test match at the WACA, Perth" },
  { match: /\bA-League\b|\bSocceroos\b|\bMatildas\b|\bPremier League\b|\bsoccer\b|\bChampions League\b/i, file: "A-League Men match between Wellington Phoenix and Brisbane Roar on 31 March 2024..jpg", caption: "an A-League match" },
  { match: /\btennis\b|\bAustralian Open\b|\bWimbledon\b/i, file: "Rod Laver Arena 2015 Australian Open.jpg", caption: "Rod Laver Arena, Melbourne" },
  { match: /\bbasketball\b|\bNBA\b|\bNBL\b|\bWNBL\b/i, file: "Canberra Capitals vs Logan Thunder 7 - Australian Institute of Sport Training Hall.jpg", caption: "a WNBL basketball game" },
  { match: /\bnetball\b|\bDiamonds\b/i, file: "Netball court - Panorama (Dimitrios Savva and Jarod Guest via Poly Haven).jpg", caption: "a netball court" },
  { match: /\bgolf\b|\bgolfers?\b/i, file: "Kangaroos on golf course.jpg", caption: "kangaroos on a golf course" },
  { match: /\bracing\b|\bMelbourne Cup\b|\bjockeys?\b|\bracecourse\b/i, file: "Flemington-race-course-180-degree.jpg", caption: "Flemington Racecourse, Melbourne" },
  { match: /\bstadium\b|\bgrand final\b|\bOlympics?\b/i, file: "Optus Stadium at night from Burswood Foreshore - October 2024.jpg", caption: "Optus Stadium, Perth" },
  { match: /\bconcerts?\b|\bband\b|\bmusicians?\b|\bguitarist\b|\bsinger\b|\bfestival\b|\btour\b/i, file: "Live rock band performance under stage lights during an outdoor festival in the evening.jpg", caption: "a band on stage" },
  { match: /\bfilm\b|\bmovies?\b|\bcinemas?\b|\bbox office\b/i, file: "Europa Cinema Auditorium, February 2025.jpg", caption: "a cinema" },
  { match: /\bwhales?\b/i, file: "001 Humpback whale breaching in Ballena Marine National Park Photo by Giles Laurent.jpg", caption: "a humpback whale" },
  { match: /\bsharks?\b/i, file: "White shark.jpg", caption: "a great white shark" },
  { match: /\bkoalas?\b/i, file: "Koala climbing tree.jpg", caption: "a koala" },
  { match: /\bdogs?\b|\bpupp(y|ies)\b/i, file: "Portrait of a labrador retriever.jpg", caption: "a labrador" },
  { match: /\bretail(ers?)?\b|\bdepartment stores?\b|\bshoppers?\b|\bshopping\b/i, file: "The Downs Shopping Centre, February 2026.jpg", caption: "a shopping centre" },
];

/** Library photos (file names) that suit a story, best match first, from its report titles. */
export function topicFiles(story: Story): string[] {
  const text = story.items.slice(0, 5).map((i) => i.title).join(" ");
  return TOPICS.filter((t) => t.match.test(text)).map((t) => t.file).slice(0, 2);
}

function tidy(text: unknown, max: number): string {
  return typeof text === "string" ? text.replace(/["“”]/g, "").replace(/\s+/g, " ").trim().slice(0, max) : "";
}
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Asks Gemini (one request per 15 stories) what to look for, for stories it hasn't been asked about in the last week.
 * Off when GEMINI_API_KEY is missing or PHOTO_AI=off; stories no model could answer are left to the fallbacks.
 */
export async function photoIdeas(stories: Story[], legal: Set<string>, cache: ImageCache): Promise<Map<string, PhotoIdea>> {
  const key = (id: string) => `idea:${id}`;
  const todo = stories.filter((s) => !cache.has(key(s.id)));
  const models = process.env.PHOTO_AI_MODEL ? [process.env.PHOTO_AI_MODEL] : FREE_MODELS;
  if (todo.length && process.env.GEMINI_API_KEY && process.env.PHOTO_AI !== "off") {
    let m = 0;
    let used = 0;
    for (let i = 0; i < todo.length && m < models.length; ) {
      if (used === REQUESTS_PER_MODEL) [m, used] = [m + 1, 0];
      const model = models[m];
      if (!model) break;
      if (i) await sleep(REQUEST_GAP_MS);
      used++;
      const batch = todo.slice(i, i + BATCH);
      // Numbered 1..15 rather than story ids: easier for the model to keep its answers lined up.
      const lines = batch.map((s, n) =>
        JSON.stringify({ id: String(n + 1), legal: legal.has(s.id), headlines: [s.headline.title, ...s.items.filter((it) => it !== s.headline).slice(0, 2).map((it) => it.title)] }),
      );
      try {
        const reply = await geminiJson(model, SYSTEM, lines.join("\n"), SCHEMA);
        const answers = ((reply.json as { stories?: unknown[] } | null)?.stories ?? []) as Record<string, unknown>[];
        for (const a of answers) {
          const story = batch[Number(tidy(a.id, 3)) - 1];
          if (!story) continue;
          const searches = Array.isArray(a.searches)
            ? a.searches.map((q) => tidy(q, 60)).filter((q) => q.length >= 3).slice(0, MAX_SEARCHES)
            : [];
          const theme = tidy(a.theme, 40);
          cache.set(key(story.id), { subject: legal.has(story.id) ? "" : tidy(a.subject, 100), searches, theme: theme.length >= 3 ? theme : "" } satisfies PhotoIdea);
        }
        i += BATCH;
      } catch (err) {
        console.log(`Photo ideas from ${model} failed (${batch.length} stories; trying the next model): ${err instanceof Error ? err.message : err}`);
        [m, used] = [m + 1, 0];
      }
    }
  }
  const ideas = new Map<string, PhotoIdea>();
  for (const s of stories) {
    const idea = cache.get<PhotoIdea>(key(s.id));
    if (idea) ideas.set(s.id, idea);
  }
  return ideas;
}
