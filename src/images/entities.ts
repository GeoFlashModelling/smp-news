import type { Item } from "../lib/normalise.js";

/** Leading words that are titles or headline furniture, not part of a name ("President Donald Trump" → "Donald Trump"). */
const LEADING =
  /^(?:(?:The|A|An|Watch|Live|Breaking|Exclusive|Video|Photos?|Analysis|Opinion|Explainer|Former|Ex|New|President|Vice|Prime|Minister|Premier|Treasurer|Senator|Sen|Rep|Governor|Gov|Mayor|Chancellor|King|Queen|Prince|Princess|Sir|Dame|Dr|Mr|Mrs|Ms|Coach|Captain|Chief|Leader|Opposition|Deputy|Justice|Judge|Detective|Inspector|Officer|Star|Actor|Singer|Rapper|Billionaire|Tech|CEO|Boss|Defender|Striker|Champion|Superstar|Legend|Veteran|Pop|US|UK|Australian|American|British|Chinese)\s+)+/;

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

const WORD = /^[A-Z][\p{L}'’.-]*$/u;
const JOINERS = new Set(["of", "de", "van", "von", "bin", "al", "la", "le", "da", "du", "del"]);

/** Capitalised runs in a piece of text, e.g. "Stephen Miller", "Zoo Atlanta". Text written In Title Case gives nothing. */
export function capitalisedRuns(text: string): string[] {
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
    if (run.length > 1 || (run.length === 1 && !runAtStart)) runs.push(run.join(" ").replace(/['’]s$/, "").replace(/\.$/, ""));
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
 * Names worth looking up for a story's picture, best first: mentioned by the most reports, multi-word names
 * (people, places, organisations) ahead of single words. A single-report story only offers multi-word names,
 * since one headline's single capitalised word is too often a sentence opener. `singleWords: false` is for
 * sport, where one-word names are mostly team nicknames ("Cats", "Roos").
 */
export function imageCandidates(items: Item[], max = 3, singleWords = true): string[] {
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
  return [...counts]
    .filter(([name, n]) => n >= minReports && name.split(" ").length >= minWords)
    .sort(([a, na], [b, nb]) => nb * (b.includes(" ") ? 1.5 : 1) - na * (a.includes(" ") ? 1.5 : 1))
    .slice(0, max)
    .map(([name]) => name);
}
