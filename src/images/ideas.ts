import { geminiJson } from "../ai/gemini.js";
import type { Story } from "../lib/stories.js";
import type { ImageCache } from "./cache.js";
/** What to look for when picturing a story. */
export interface PhotoIdea {
  /** Exact Wikipedia article title of the story's main subject, or "" when there is none (or it's a court/crime story). */
  subject: string;
  /** Short image-search phrases, most specific first: the key object or setting the story discusses. */
  searches: string[];
  /** A common thing, animal or scene that broadly stands for the story's topic ("wild cat", "Wi-Fi router"); a free photo of it surely exists. */
  theme?: string;
  /** Exact Wikipedia article title of the specific place where the story happens (a ground, venue, building or site), or "". */
  venue?: string;
}

/** Small batches: with more stories per request, Flash Lite starts giving one story's places to its neighbours. */
const BATCH = 15;
/**
 * Free tier: each model allows 15 requests a minute and 500 a day, so 12 an hour each (288 a day). When one model's
 * share is used, or it fails, the next takes over. Leftover stories wait an hour.
 */
const FREE_MODELS = ["gemini-3.5-flash-lite", "gemini-3.1-flash-lite"];
const REQUESTS_PER_MODEL = 12;
/**
 * When the free share runs out (by early morning on busy days), the paid key takes over for a few requests a run:
 * about A$0.005 each, so at most a couple of cents an hour.
 */
const PAID_REQUESTS = 4;
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
          venue: { type: "string" },
        },
        required: ["id", "subject", "searches", "theme", "venue"],
      },
    },
  },
  required: ["stories"],
};

const SYSTEM = `You choose pictures for an Australian news website. Pictures are free-licensed file photos from Wikipedia and Wikimedia Commons, never photos of the event itself.

Pictures are chosen most specific first: who or where the story is about, then a key object it discusses, then a broad picture of its topic. For each story you get its id, whether it is a court or crime story ("legal"), its headlines and the start of a report. Return for each story:
- subject: the exact English Wikipedia article title of the one well-known person, organisation, team, product or place the story is mainly about, when a photo of it would suit the story. Examples: "Pope Leo XIV", "Real Madrid CF", "Australia national rugby union team", "Tesla Cybertruck", "Victoria Barracks, Sydney". Use "" when there is no single clear subject, when the subject is a private individual, or when legal is true.
- venue: the exact English Wikipedia article title of the specific place where the story happens: the ground, stadium, course or circuit of a match or race; the venue of a concert, festival or show; the building, landmark, mine, port, hospital, court or other site at the centre of any other story. Examples: "Sydney Cricket Ground", "Perth Stadium", "Flemington Racecourse", "Royal Perth Hospital", "Supreme Court of Victoria", "Port Hedland", "Main Square, Kraków". Use the place the headlines or report name. For a sports match where they name none, use the home ground of the home (first-named) team when it is well known. Otherwise use "".
- searches: 1 to 3 short image-search phrases (2 to 4 words, no punctuation), most specific first, for the key object or setting the report discusses: "Hawaiian pizza", "open pit gold mine Western Australia", "lithium battery cells", "Boeing 737 MAX", "Walhalla Victoria", "Melbourne skyline".
- theme: always one common thing, animal, food, vehicle, kind of building or landscape (1 to 3 words) that broadly stands for the story's topic, so ordinary that a free photo of it surely exists. Examples: "wild cat", "snake", "racing bicycle", "wine glasses", "Wi-Fi router", "electric pickup truck", "video game controller", "glacier", "sake bottles", "cargo ship", "Australian rules football", "courthouse".
Searches and themes are for places, buildings, landscapes, animals and objects only: never people (no names, no "police officer", "judge" or "crowd"), never incidents or their effects ("riot", "protest", "crash", "airstrike", "earthquake damage", "collapsed building", "rubble", "flood victims"): photos of those are rejected, because a photo of a different event would mislead. For a disaster, use the instrument, natural feature or setting instead ("seismograph", "volcano Indonesia", "river in flood", "bushfire smoke over hills", "Tokyo skyline"). Never logos. Treat each story on its own: only name a place the story's own headlines point to. When legal is true, the place or building is especially important ("Melbourne laneway", "Supreme Court of Victoria building").`;

/**
 * Last resort before artwork: common news topics, each with a hand-picked Wikimedia Commons photo (file name) and
 * how the caption describes it. Checked by eye; no people's faces, nothing showing a particular incident.
 */
export const TOPICS: { match: RegExp; file: string; caption: string }[] = [
  { match: /\bbushfires?\b|\bwildfires?\b|\bfirefighters?\b/i, file: "Fesa 669 01 gnangarra.jpg", caption: "a firefighting helicopter in Western Australia" },
  { match: /\bfloods?\b|\bflooding\b/i, file: "Flooded fields in Keralup, Western Australia, August 2021 01.jpg", caption: "flooded fields in Keralup, Western Australia" },
  { match: /\bearthquakes?\b|\bquakes?\b|\btremors?\b|\bseismic\b|\baftershocks?\b/i, file: "Kinemetrics seismograph.jpg", caption: "a seismograph" },
  { match: /\btsunamis?\b/i, file: "Tsunami evacuation route sign on the road, Kamakura, 2016.jpg", caption: "a tsunami evacuation route sign in Kamakura, Japan" },
  { match: /\bvolcan(o|oes|ic)\b|\beruptions?\b|\berupts?\b/i, file: "Bromo and Semeru volcanoes, Java, Indonesia, 20220820 0718 9524.jpg", caption: "the Bromo and Semeru volcanoes, Indonesia" },
  { match: /\bcyclones?\b|\btyphoons?\b|\bhurricanes?\b|\btropical (storm|low)\b/i, file: "Staring Down Hurricane Florence.jpg", caption: "a tropical cyclone seen from the International Space Station" },
  { match: /\btornado(es)?\b|\bsupercells?\b/i, file: "Supercell-thunderstorm-in-Kansas.jpg", caption: "a supercell thunderstorm" },
  { match: /\bstorms?\b|\bcold front\b|\bthunderstorms?\b|\bwild weather\b/i, file: "Storm clouds rolling over the Australian Capital Territory.jpg", caption: "storm clouds over the ACT" },
  { match: /\bheatwave\b|\bheat wave\b|\bscorcher\b/i, file: "Cottesloe Beach from the south, March 2022.jpg", caption: "Cottesloe Beach, Perth" },
  { match: /\bdrought\b/i, file: "Drought, Hughenden, Queensland, Australia 2014-08-09 11-19.jpg", caption: "drought near Hughenden, Queensland" },
  { match: /\bcourt\b|\btrial\b|\bsentenced?\b|\bguilty\b|\bjury\b|\bcharged\b|\bmagistrates?\b|\baccused\b|\babus(e|ed|ing)\b/i, file: "Legal Gavel (27571702173).jpg", caption: "a judge's gavel" },
  { match: /\bpolice\b|\bdetectives?\b|\bstabbed\b|\bstabbing\b|\bmissing\b|\bcrash\b|\bdrink[- ]driv(ing|er)\b/i, file: "NSW Police car 2006 NYE.jpg", caption: "a police car at night" },
  { match: /\bReserve Bank\b|\bRBA\b|\binterest rates?\b|\binflation\b|\brate (cut|rise|hike)s?\b/i, file: "RBA Building August 2025.jpg", caption: "the Reserve Bank of Australia, Sydney" },
  { match: /\bASX\b|\bsharemarket\b|\bshare market\b|\bstocks?\b|\bshares\b|\binvestors\b/i, file: "Australian Securities Exchange entrance.jpg", caption: "the Australian Securities Exchange" },
  { match: /\boil (price|prices|slips|falls|rises|jumps)\b|\bcrude\b|\bBrent\b|\bOPEC\b|\boil(field)?s?\b.*\bbarrel/i, file: "Pumpjacks Inglewood Oil Field seen from Baldwin Hills Scenic Overlook.jpg", caption: "oil pumpjacks in Los Angeles" },
  { match: /\bmedicines?\b|\bdrugs? (watchdog|regulator|maker)\b|\bpharmac(y|ies|ists?|eutical)\b|\bTGA\b|\bFDA\b|\bweight-loss (drug|jab)s?\b|\bOzempic\b|\bprescriptions?\b/i, file: "Prescription antibiotic pills used to treat a broad range of bacterial infections - 44.jpg", caption: "prescription pills" },
  { match: /\bEVs?\b|\belectric (cars?|vehicles?)\b|\bBYD\b|\bTesla\b|\bcarmakers?\b|\bcar makers?\b|\btop speed\b/i, file: "Electric car charging points - geograph.org.uk - 7322507.jpg", caption: "electric car charging points" },
  { match: /\bWhite House\b|\bTrump\b|\bUS president\b/i, file: "The White House June 2024.jpg", caption: "the White House, Washington" },
  { match: /\bmidterms?\b|\bCongress\b|\bUS Senate\b|\bRepublicans?\b|\bDemocrats?\b|\bCapitol\b/i, file: "United States Capitol west front edit2 (cropped).jpg", caption: "the United States Capitol, Washington" },
  { match: /\bhousing\b|\brents?\b|\brenters\b|\bhouse prices?\b|\bmortgages?\b|\bhome loans?\b/i, file: "Walking around the suburb of Kelso, Townsville, Australia 05.jpg", caption: "a suburban street in Kelso, Townsville" },
  { match: /\bhospitals?\b|\bnurses?\b|\bdoctors?\b|\bpatients?\b|\bemergency department\b|\bramping\b/i, file: "Royal Perth Hospital, 2023.jpg", caption: "Royal Perth Hospital" },
  { match: /\bschools?\b|\bteachers?\b|\bprincipals?\b/i, file: "Fairfield Public School classrooms.jpg", caption: "school classrooms in Fairfield, NSW" },
  { match: /\buniversit(y|ies)\b|\bTAFE\b/i, file: "Edith Cowan University, City Campus, May 2026 01.jpg", caption: "Edith Cowan University's city campus, Perth" },
  { match: /\bmines?\b|\bmining\b|\bminers?\b|\bgold price\b|\biron ore\b|\blithium\b/i, file: "Kalgoorlie Super Pit, October 2023 01.jpg", caption: "the Super Pit gold mine, Kalgoorlie" },
  { match: /\btrade (war|deal|talks|pledges?|deficit|surplus)\b|\btariffs?\b|\bexports?\b|\bimports?\b/i, file: "MSC Meline, Fremantle, 2021 (06).jpg", caption: "a container ship at Fremantle" },
  { match: /\bpetrol\b|\bfuel prices?\b|\bdiesel\b/i, file: "Shell Service Station, Upper Swan, WA.jpg", caption: "a service station in Upper Swan, WA" },
  { match: /\belections?\b|\bvoters?\b|\bpolling\b|\bballots?\b|\bby-election\b/i, file: "Democracy Sausage.jpg", caption: "a democracy sausage at a polling place" },
  { match: /\bFederal Parliament\b|\bAlbanese\b|\bCanberra\b|\bSenate\b|\bfederal budget\b/i, file: "Parliament House at dusk, Canberra ACT.jpg", caption: "Parliament House, Canberra" },
  // Alternatives, so several political stories on one page don't share a photo.
  { match: /\bSenate\b|\bsenators?\b/i, file: "Australian Senate - Parliament of Australia.jpg", caption: "the Senate chamber, Parliament House, Canberra" },
  { match: /\bFederal Parliament\b|\bAlbanese\b|\bCanberra\b|\bfederal budget\b|\bQuestion Time\b|\bMPs?\b/i, file: "Australian House of Representatives - Parliament of Australia.jpg", caption: "the House of Representatives chamber, Canberra" },
  { match: /\bFederal Parliament\b|\bAlbanese\b|\bCanberra\b|\bSenate\b|\bfederal budget\b/i, file: "Canberra (AU), Parliament House -- 2019 -- 1745.jpg", caption: "Parliament House, Canberra" },
  { match: /\bFederal Parliament\b|\bAlbanese\b|\bCanberra\b|\bSenate\b|\bfederal budget\b/i, file: "Canberra (AU), Parliament House -- 2019 -- 1754.jpg", caption: "the flag above Parliament House, Canberra" },
  { match: /\bNASA\b|\bastronauts?\b|\brockets?\b|\bspace(craft|X)?\b/i, file: "SES-10 Launch - world's first reflight of an orbital class rocket (33361035200).jpg", caption: "a rocket launch" },
  { match: /\bAI\b|\bartificial intelligence\b|\bdata cent(re|er)s?\b|\bchatbots?\b/i, file: "BalticServers data center.jpg", caption: "a data centre" },
  { match: /\bairlines?\b|\bflights?\b|\bairports?\b|\bQantas\b|\bVirgin Australia\b/i, file: "Perth Airport Qantas terminal, July 2022, 01.jpg", caption: "Perth Airport" },
  { match: /\btrains?\b|\brailway\b|\bmetro\b|\bpublic transport\b/i, file: "Transperth B-series train at Thornlie Station, September 2026 (cropped).jpg", caption: "a Transperth train at Thornlie" },
  { match: /\broad toll\b|\bhighway\b|\bfreeway\b|\btraffic\b|\bcongestion\b/i, file: "Perth skyline and Kwinana Freeway 2009.jpg", caption: "the Kwinana Freeway, Perth" },
  { match: /\bAFLW?\b|\bBrownlow\b|\bCarlton\b|\bCollingwood\b|\bEssendon\b|\bHawthorn\b|\bGeelong Cats\b|\bDockers\b|\bWest Coast Eagles\b|\bSt Kilda\b|\bWestern Bulldogs\b|\bMelbourne Demons\b|\bSydney Swans\b|\bBrisbane Lions\b|\bAdelaide Crows\b|\bPort Adelaide\b|\bGWS Giants\b|\bGold Coast Suns\b|\bRichmond Tigers\b|\bNorth Melbourne\b/i, file: "AFL Grand Final 2010 on the Melbourne Cricket Ground.jpg", caption: "an AFL match at the MCG" },
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
  { match: /\bretail(ers?)?\b|\bdepartment stores?\b|\bshoppers?\b|\bshopping\b|\bBlack Friday\b|\bCyber Monday\b|\bBoxing Day sales\b/i, file: "The Downs Shopping Centre, February 2026.jpg", caption: "a shopping centre" },
];

/** Someone's death (owner, 10 Nov 2026): a searched photo of a person may be someone else, so a medical photo is shown instead. */
const DEATH = /\b(dies|died|has died|death of|dead at \d+|passes away|passed away|obituary|tributes? (flow|paid|pour)|mourn(s|ed|ing)?)\b/i;

/** Medical photos for death stories, by cause; the last one is the default. Checked by eye: no people. */
export const MEDICAL: { match: RegExp; file: string; caption: string }[] = [
  { match: /\binjur(y|ies|ed)\b|\bfall\b|\bfell\b|\bcrash(ed)?\b|\baccident\b|\bcollision\b|\bdrown(s|ed|ing)?\b|\bstruck\b/i, file: "2017 Mercedes-Benz Sprinter (W 906) 313 CDI MWB van, St John Ambulance (2017-12-09).jpg", caption: "a St John ambulance in Perth" },
  { match: /\bcancer\b|\btumou?r\b|\bleuka?emia\b|\blymphoma\b|\bmelanoma\b/i, file: "Linear Accelerator - Elekta Compact model.jpg", caption: "a radiotherapy machine" },
  { match: /\bheart\b|\bcardiac\b|\bstroke\b/i, file: "Vital signs monitor display.jpg", caption: "a hospital vital signs monitor" },
  { match: /./, file: "Stethoscope-2.jpg", caption: "a stethoscope" },
];

/** Whether the story is about someone's death: its headline, or most of its reports' titles, say so. */
export function isDeathStory(story: Story): boolean {
  const titles = story.items.slice(0, 5).map((i) => i.title);
  return DEATH.test(story.headline.title) || titles.filter((t) => DEATH.test(t)).length * 2 > titles.length;
}

const NAME = String.raw`\p{Lu}[\p{L}'’.-]+(?:\s+(?:de|van|von|da|del|bin|al|le|la)?\s*\p{Lu}[\p{L}'’.-]+){1,3}`;
const NAME_BEFORE = new RegExp(String.raw`(${NAME})(?:,[^,]{1,80},)?\s+(?:dies|died|has died|passes away|passed away|dead at)\b`, "u");
const NAME_AFTER = new RegExp(String.raw`\bdeath of\b.*?(${NAME})`, "u");

/** The full name of the person a death headline is about ("Dai Henwood"), or null when it names nobody. */
export function deceasedName(title: string): string | null {
  const name = (title.match(NAME_BEFORE) ?? title.match(NAME_AFTER))?.[1] ?? null;
  // The run of capitals can start with a description ("New Zealand comedian Dai Henwood" → keep "Dai Henwood").
  return name ? name.split(/\s+/).slice(-3).join(" ").replace(/^(New|South|North|West|East|Zealand|Australian?|American|British) /, "") : null;
}

const STOP = new Set(["the", "and", "of", "in", "for", "from", "with", "who", "was", "has", "his", "her", "former", "born"]);

/**
 * Certain enough to show a famous person's own photo on news of their death (the article already has exactly their
 * full name): any age in the reports fits the birth year Wikipedia gives, and either the ages agree or the
 * description shares a describing word with the reports ("comedian", "actor").
 */
export function confirmedPerson(story: Story, description: string, now: Date): boolean {
  const text = story.items.slice(0, 5).map((i) => `${i.title} ${i.summary}`).join(" ").toLowerCase();
  const born = description.match(/(?:\bborn |\()(1[89]\d\d|20[0-2]\d)\b/);
  const age = text.match(/\b(?:dies at|died at|dead at|aged|age of) (\d{1,3})\b/);
  if (born && age) return Math.abs(now.getFullYear() - Number(born[1]) - Number(age[1])) <= 1;
  const words = description.toLowerCase().match(/\p{L}{4,}/gu) ?? [];
  return words.some((w) => !STOP.has(w) && new RegExp(`\\b${w}`).test(text));
}

/** The medical photo (file name) for a death story, by the cause its reports give. */
export function medicalFile(story: Story): string {
  const text = story.items.slice(0, 5).map((i) => `${i.title} ${i.summary}`).join(" ");
  return MEDICAL.find((m) => m.match.test(text))!.file;
}

/** Other library photos of the same place, tried before a story repeats a photo another story already shows. */
const STAND_INS: { match: RegExp; files: string[] }[] = [
  {
    match: /\bParliament House\b.*\bCanberra\b|\bParliament of Australia\b|\bAustralian Parliament House\b/i,
    files: [
      "Parliament House at dusk, Canberra ACT.jpg",
      "Canberra (AU), Parliament House -- 2019 -- 1745.jpg",
      "Australian House of Representatives - Parliament of Australia.jpg",
      "Australian Senate - Parliament of Australia.jpg",
      "Canberra (AU), Parliament House -- 2019 -- 1754.jpg",
    ],
  },
];

/** Library photos (file names) showing the same place as a photo (by what it shows), for when that one is taken. */
export function standIns(subject: string): string[] {
  return STAND_INS.find((s) => s.match.test(subject))?.files ?? [];
}

/** Library photos (file names) that suit a story, best match first, from its report titles. */
export function topicFiles(story: Story): string[] {
  const text = story.items.slice(0, 5).map((i) => i.title).join(" ");
  return TOPICS.filter((t) => t.match.test(text)).map((t) => t.file).slice(0, 5);
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
  // Ideas from before venues were asked for are asked again (new stories first); until then the old idea is used.
  const fresh = stories.filter((s) => !cache.has(key(s.id)));
  const todo = [...fresh, ...stories.filter((s) => cache.has(key(s.id)) && cache.get<PhotoIdea>(key(s.id))?.venue === undefined)];
  const models = (process.env.PHOTO_AI_MODEL ? [process.env.PHOTO_AI_MODEL] : FREE_MODELS).map((name) => ({ name, paid: false }));
  if (process.env.GEMINI_PAID_API_KEY) models.push({ name: process.env.SUMMARY_PAID_MODEL || "gemini-3.1-flash-lite", paid: true });
  if (todo.length && process.env.GEMINI_API_KEY && process.env.PHOTO_AI !== "off") {
    let m = 0;
    let used = 0;
    for (let i = 0; i < todo.length && m < models.length; ) {
      if (used === (models[m]?.paid ? PAID_REQUESTS : REQUESTS_PER_MODEL)) [m, used] = [m + 1, 0];
      const current = models[m];
      if (!current) break;
      const model = current.name;
      if (i) await sleep(REQUEST_GAP_MS);
      used++;
      const batch = todo.slice(i, i + BATCH);
      // Numbered 1..15 rather than story ids: easier for the model to keep its answers lined up.
      const lines = batch.map((s, n) =>
        JSON.stringify({
          id: String(n + 1),
          legal: legal.has(s.id),
          headlines: [s.headline.title, ...s.items.filter((it) => it !== s.headline).slice(0, 2).map((it) => it.title)],
          report: tidy(s.items.find((it) => it.summary)?.summary, 300),
        }),
      );
      try {
        const reply = await geminiJson(model, SYSTEM, lines.join("\n"), SCHEMA, current.paid ? { keyEnv: "GEMINI_PAID_API_KEY" } : {});
        if (current.paid) console.log(`Photo ideas for ${batch.length} stories from ${model} on the paid key`);
        const answers = ((reply.json as { stories?: unknown[] } | null)?.stories ?? []) as Record<string, unknown>[];
        for (const a of answers) {
          const story = batch[Number(tidy(a.id, 3)) - 1];
          if (!story) continue;
          const searches = Array.isArray(a.searches)
            ? a.searches.map((q) => tidy(q, 60)).filter((q) => q.length >= 3).slice(0, MAX_SEARCHES)
            : [];
          const theme = tidy(a.theme, 40);
          const venue = tidy(a.venue, 100);
          cache.set(key(story.id), { subject: legal.has(story.id) ? "" : tidy(a.subject, 100), searches, theme: theme.length >= 3 ? theme : "", venue: venue.length >= 3 ? venue : "" } satisfies PhotoIdea);
        }
        i += BATCH;
      } catch (err) {
        console.log(`Photo ideas from ${model}${current.paid ? " (paid)" : ""} failed (${batch.length} stories; trying the next model): ${err instanceof Error ? err.message : err}`);
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
