import type { Item } from "../lib/normalise.js";

/** Leading words that are titles or headline furniture, not part of a name ("President Donald Trump" → "Donald Trump"). */
const LEADING =
  /^(?:(?:The|A|An|Watch|Live|Breaking|Exclusive|Video|Photos?|Analysis|Opinion|Explainer|Former|Ex|President|Vice|Prime|Minister|Premier|Treasurer|Senator|Sen|Rep|Governor|Gov|Mayor|Chancellor|King|Queen|Prince|Princess|Sir|Dame|Dr|Mr|Mrs|Ms|Coach|Captain|Chief|Leader|Opposition|Deputy|Justice|Judge|Detective|Inspector|Officer|Star|Actor|Singer|Rapper|Billionaire|CEO|Boss|Defender|Striker|Champion|Superstar|Legend|Veteran)\s+)+/;

/** Too broad to illustrate a story, or not a subject at all. */
const GENERIC = new Set(
  [
    "Australia", "Australian", "Australians", "Aussie", "Aussies", "US", "U.S.", "USA", "United States", "America", "UK", "Britain", "Europe", "European",
    "WA", "NSW", "Queensland", "Victoria", "Western Australia", "Perth", "Sydney", "Melbourne", "World", "International",
    "Government", "Federal", "Labor", "Coalition", "Liberal", "Liberals", "Greens", "Parliament", "Senate", "House", "Congress", "Police", "Court", "Democrats", "Republicans", "Midterms",
    "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday",
    "January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December",
    "I", "It", "This", "That", "What", "Why", "How", "Who", "When", "Where", "Here", "There", "We", "You", "He", "She", "They", "His", "Her",
    "AI", "Covid", "COVID", "Breaking", "Watch", "Live", "Update", "Updates", "Report", "News", "Today",
    // AFL / NRL / A-League nicknames: Wikipedia's article for the word is about the animal or thing
    "Cats", "Roos", "Blues", "Swans", "Eagles", "Dockers", "Crows", "Power", "Tigers", "Hawks", "Magpies", "Pies", "Bombers", "Dons", "Demons", "Dees",
    "Saints", "Suns", "Giants", "Lions", "Bulldogs", "Dogs", "Kangaroos", "Storm", "Broncos", "Rabbitohs", "Bunnies", "Roosters", "Sharks", "Panthers",
    "Eels", "Raiders", "Knights", "Cowboys", "Titans", "Warriors", "Dragons", "Dolphins", "Victory", "Glory", "Mariners", "Jets", "Phoenix", "Wanderers",
  ].map((w) => w.toLowerCase()),
);

/** In GENERIC because they are too broad to be a story's subject, but fine as the place a story happened. */
const BROAD_PLACES = new Set(["australia", "us", "usa", "united states", "america", "uk", "britain", "europe", "wa", "nsw", "queensland", "victoria", "western australia", "perth", "sydney", "melbourne"]);

const WORD = /^[A-Z][\p{L}'’.-]*$/u;
const JOINERS = new Set(["of", "de", "van", "von", "bin", "al", "la", "le", "da", "du", "del"]);

/**
 * Capitalised runs in a piece of text, e.g. "Stephen Miller", "Zoo Atlanta". Text written In Title Case gives nothing.
 * A lone capitalised first word is dropped unless `keepFirst` (place names: "Sydney wakes to…").
 */
export function capitalisedRuns(text: string, keepFirst = false): string[] {
  const words = text.replace(/[“”"‘’:;,!?()[\]|–—]/g, (c) => (c === "’" || c === "‘" ? "'" : " , ")).split(/\s+/).filter(Boolean);
  const alpha = words.filter((w) => /^\p{L}/u.test(w));
  if (alpha.length >= 5 && alpha.filter((w) => WORD.test(w)).length / alpha.length > 0.6) return [];
  const runs: string[] = [];
  let run: string[] = [];
  let runAtStart = false;
  let sentenceStart = true;
  const flush = () => {
    while (run.length && JOINERS.has(run[run.length - 1]!)) run.pop();
    // A lone capitalised first word ("Scientists find…") is usually just grammar, not a name.
    if (run.length > 1 || (run.length === 1 && (keepFirst || !runAtStart))) runs.push(run.join(" ").replace(/['’]s$/, "").replace(/\.$/, ""));
    run = [];
  };
  for (const w of words) {
    if (WORD.test(w)) {
      if (run.length === 0) runAtStart = sentenceStart;
      run.push(w);
    } else if (run.length && JOINERS.has(w)) run.push(w);
    else flush();
    sentenceStart = w === "," ? sentenceStart : /[.!?]$/.test(w);
    if (/[.!?]$/.test(w) && run.length) flush();
  }
  flush();
  return runs;
}

function clean(run: string): string {
  return run.replace(LEADING, "").trim();
}

function usable(name: string): boolean {
  if (name.length < 3 || GENERIC.has(name.toLowerCase())) return false;
  const words = name.split(" ");
  return words.length <= 4 && !words.every((w) => GENERIC.has(w.toLowerCase()));
}

/**
 * Names worth looking up for a story's picture, best first: named in the story's headline, mentioned by the most
 * reports, multi-word names (people, places, organisations) ahead of single words. A single-report story only offers multi-word names,
 * since one headline's single capitalised word is too often a sentence opener. `singleWords: false` is for
 * sport, where one-word names are mostly team nicknames ("Cats", "Roos").
 */
export function imageCandidates(items: Item[], max = 3, singleWords = true, headline = ""): string[] {
  const counts = new Map<string, number>();
  for (const item of items) {
    const seen = new Set<string>();
    for (const text of [item.title, item.summary.slice(0, 300)]) {
      for (const run of capitalisedRuns(text)) {
        const name = clean(run);
        if (usable(name)) seen.add(name);
      }
    }
    for (const name of seen) counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  const minWords = items.length === 1 || !singleWords ? 2 : 1;
  const minReports = items.length === 1 ? 1 : 2;
  const weight = (name: string, n: number) => n * (name.includes(" ") ? 1.5 : 1) * (headline.includes(name) ? 3 : 1);
  return [...counts]
    .filter(([name, n]) => (n >= minReports || headline.includes(name)) && name.split(" ").length >= minWords)
    .sort(([a, na], [b, nb]) => weight(b, nb) - weight(a, na))
    .slice(0, max)
    .map(([name]) => name);
}

/**
 * Names in a story's report titles that might be where it happened, most likely first (named in the headline, then
 * by the most reports). Whether each really is a place is decided by its Wikipedia description.
 */
export function placeCandidates(items: Item[], headline: string, max = 3): string[] {
  const counts = new Map<string, number>();
  const ok = (name: string) => name.length >= 3 && name.split(" ").length <= 4 && (BROAD_PLACES.has(name.toLowerCase()) || !GENERIC.has(name.toLowerCase()));
  for (const item of items) {
    const seen = new Set<string>();
    for (const run of capitalisedRuns(item.title, true)) if (ok(clean(run))) seen.add(clean(run));
    for (const name of seen) counts.set(name, (counts.get(name) ?? 0) + 1);
    // Places named only in the description ("struck in Shizuoka Prefecture") count half; multi-word names only, since
    // a lone capitalised word in running text is too often something else.
    for (const run of new Set(capitalisedRuns(item.summary.slice(0, 250)).map(clean))) {
      if (!seen.has(run) && run.includes(" ") && ok(run)) counts.set(run, (counts.get(run) ?? 0) + 0.5);
    }
  }
  const weight = (name: string, n: number) => n * (headline.includes(name) ? 3 : 1) / (BROAD_PLACES.has(name.toLowerCase()) ? 2 : 1);
  return [...counts]
    .sort(([a, na], [b, nb]) => weight(b, nb) - weight(a, na))
    .slice(0, max)
    .map(([name]) => name);
}
