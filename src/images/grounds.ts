import type { Story } from "../lib/stories.js";

/**
 * Australian clubs and the Wikipedia article of their main home ground. Used when the reports don't say where a match
 * was played: the photo is captioned as the ground, which is where the club plays, not a claim about this match.
 * `name` always identifies the club; `nickname` only counts when the story mentions the club's competition, since
 * "Bulldogs", "Tigers" and "Kangaroos" are teams in more than one code.
 */
interface Club {
  name: RegExp;
  nickname?: RegExp;
  ground: string;
}

const AFL: Club[] = [
  { name: /\bAdelaide Crows\b/i, nickname: /\bCrows\b/, ground: "Adelaide Oval" },
  { name: /\bBrisbane Lions\b/i, nickname: /\bLions\b/, ground: "The Gabba" },
  { name: /\bCarlton\b/, nickname: /\bBlues\b/, ground: "Melbourne Cricket Ground" },
  { name: /\bCollingwood\b/, nickname: /\b(Magpies|Pies)\b/, ground: "Melbourne Cricket Ground" },
  { name: /\bEssendon\b/, nickname: /\bBombers\b/, ground: "Docklands Stadium" },
  { name: /\bFremantle\b/, nickname: /\bDockers\b/, ground: "Perth Stadium" },
  { name: /\bGeelong\b/, nickname: /\bCats\b/, ground: "Kardinia Park (stadium)" },
  { name: /\bGold Coast Suns\b/i, nickname: /\bSuns\b/, ground: "Carrara Stadium" },
  { name: /\b(GWS|Greater Western Sydney)\b/, nickname: /\bGiants\b/, ground: "Sydney Showground Stadium" },
  { name: /\bHawthorn\b/, nickname: /\bHawks\b/, ground: "Melbourne Cricket Ground" },
  { name: /\bMelbourne Demons\b/i, nickname: /\b(Demons|Dees)\b/, ground: "Melbourne Cricket Ground" },
  { name: /\bNorth Melbourne\b/, nickname: /\b(Kangaroos|Roos)\b/, ground: "Docklands Stadium" },
  { name: /\bPort Adelaide\b/, nickname: /\bPower\b/, ground: "Adelaide Oval" },
  { name: /\bRichmond Tigers\b/i, nickname: /\bTigers\b/, ground: "Melbourne Cricket Ground" },
  { name: /\bSt Kilda\b/, nickname: /\bSaints\b/, ground: "Docklands Stadium" },
  { name: /\bSydney Swans\b/i, nickname: /\bSwans\b/, ground: "Sydney Cricket Ground" },
  { name: /\bWest Coast\b/, nickname: /\bEagles\b/, ground: "Perth Stadium" },
  { name: /\bWestern Bulldogs\b/i, nickname: /\b(Bulldogs|Dogs)\b/, ground: "Docklands Stadium" },
];

const NRL: Club[] = [
  { name: /\bBrisbane Broncos\b/i, nickname: /\bBroncos\b/, ground: "Lang Park" },
  { name: /\bCanberra Raiders\b/i, nickname: /\bRaiders\b/, ground: "Canberra Stadium" },
  { name: /\bCanterbury(-Bankstown)? Bulldogs\b/i, nickname: /\bBulldogs\b/, ground: "Stadium Australia" },
  { name: /\bCronulla\b/, nickname: /\bSharks\b/, ground: "Shark Park" },
  { name: /\bRedcliffe Dolphins\b/i, nickname: /\bDolphins\b/, ground: "Lang Park" },
  { name: /\bGold Coast Titans\b/i, nickname: /\bTitans\b/, ground: "Robina Stadium" },
  { name: /\bManly\b/, nickname: /\bSea Eagles\b/, ground: "Brookvale Oval" },
  { name: /\bMelbourne Storm\b/i, nickname: /\bStorm\b/, ground: "Melbourne Rectangular Stadium" },
  { name: /\bNewcastle Knights\b/i, nickname: /\bKnights\b/, ground: "Newcastle International Sports Centre" },
  { name: /\bNorth Queensland Cowboys\b/i, nickname: /\bCowboys\b/, ground: "North Queensland Stadium" },
  { name: /\bParramatta\b/, nickname: /\bEels\b/, ground: "Western Sydney Stadium" },
  { name: /\bPenrith\b/, nickname: /\bPanthers\b/, ground: "Penrith Stadium" },
  { name: /\bSouth Sydney\b|\bSouths\b/, nickname: /\bRabbitohs\b/, ground: "Stadium Australia" },
  { name: /\bSt George Illawarra\b/i, nickname: /\bDragons\b/, ground: "WIN Stadium" },
  { name: /\bSydney Roosters\b/i, nickname: /\bRoosters\b/, ground: "Sydney Football Stadium (2022)" },
  { name: /\bNew Zealand Warriors\b/i, nickname: /\bWarriors\b/, ground: "Mount Smart Stadium" },
  { name: /\bWests Tigers\b/i, ground: "Leichhardt Oval" },
];

export const GROUNDS = [...new Set([...AFL, ...NRL].map((c) => c.ground))];

/** Where in the text a club is first mentioned, or -1. */
function firstMention(club: Club, text: string, nicknamesOk: boolean): number {
  const at = [club.name, ...(nicknamesOk && club.nickname ? [club.nickname] : [])].map((re) => text.search(re)).filter((i) => i >= 0);
  return at.length ? Math.min(...at) : -1;
}

/** Words that don't identify a venue on their own: "Melbourne" appears in reports about many things besides the MCG. */
const NOT_DISTINCTIVE = new Set([
  "the", "stadium", "ground", "park", "oval", "cricket", "football", "sports", "centre", "arena", "field", "international", "national", "memorial", "showground", "rectangular",
  "melbourne", "sydney", "perth", "adelaide", "brisbane", "canberra", "hobart", "darwin", "newcastle", "gold", "coast", "geelong", "western", "north", "south", "east", "west", "queensland", "victoria", "australia",
  "auckland", "wellington", "london", "cardiff", "dublin", "edinburgh", "paris",
  "hospital", "court", "supreme", "district", "county", "magistrates", "royal", "port", "airport", "station", "square", "main", "old", "new", "town", "city", "hall", "house",
  "parliament", "state", "library", "museum", "gallery", "university", "college", "school", "bridge", "beach", "river", "lake", "mine", "harbour", "bay", "island", "street", "road", "tower", "church", "cathedral", "palace", "high", "great", "saint",
]);

/**
 * Whether the reports name a suggested venue, rather than the model guessing it: its full name, its initials ("MCG")
 * or a distinctive word ("Ikon", "Twickenham").
 */
export function venueMentioned(venue: string, story: Story): boolean {
  const name = venue.replace(/\s*\(.*\)/, "");
  const text = story.items.map((i) => `${i.title} ${i.summary}`).join(" ");
  const lower = text.toLowerCase();
  const words = name.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((w) => w.length >= 3);
  const initials = name.split(/\s+/).filter((w) => /^\p{Lu}/u.test(w)).map((w) => w[0]).join("");
  return (
    lower.includes(name.toLowerCase()) ||
    (initials.length >= 3 && new RegExp(`\\b${initials}\\b`).test(text)) ||
    words.some((w) => !NOT_DISTINCTIVE.has(w) && new RegExp(`\\b${w}\\b`).test(lower))
  );
}

/**
 * The home ground of the first club named in a sport story's headlines (the home side is usually named first), or null.
 * The summary's headline comes first: it is the one shown, and a story can wrongly hold reports of two matches.
 */
export function homeGround(story: Story): string | null {
  const titles = [...(story.writeup?.summary ? [story.writeup.summary.headline] : []), story.headline.title, ...story.items.filter((i) => i !== story.headline).map((i) => i.title)];
  const all = titles.concat(story.items.map((i) => i.summary)).join(" ");
  const leagues: [Club[], boolean][] = [
    [AFL, /\bAFLW?\b|\bfooty\b/i.test(all)],
    [NRL, /\bNRLW?\b/.test(all)],
  ];
  for (const title of titles) {
    let best: { at: number; ground: string } | null = null;
    for (const [clubs, nicknamesOk] of leagues) {
      for (const club of clubs) {
        const at = firstMention(club, title, nicknamesOk);
        if (at >= 0 && (!best || at < best.at)) best = { at, ground: club.ground };
      }
    }
    if (best) return best.ground;
  }
  return null;
}
