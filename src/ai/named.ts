import type { Item } from "../lib/normalise.js";
import type { LegalMode } from "./legal-risk.js";
import type { SourceBlock } from "./prompt.js";

/**
 * People the outlets themselves name (owner, 11 Nov 2026: "Allegations … made against a British author" reads like
 * clickbait when every outlet's headline names him). Court, crime and sensitive stories may name a person once at least
 * two independent outlets name them: the outlets have already made the name public, and two of them make a mistake or a
 * since-suppressed name unlikely. In sexual-offence stories only names in the outlets' own headlines count: victims
 * may never be identified, and outlets don't put them in headlines.
 *
 * Never named: anyone in a story mentioning a suppression order, someone who "cannot be named", a children's or youth
 * court, young offenders, or suicide; anyone in a story where a child is involved together with a family relationship
 * (naming an adult would identify the child); and anyone the reports call a victim or complainant in a sensitive story.
 * Where a child or teenager is involved otherwise (an adult accused of grooming teenagers), a name counts only when at
 * least three outlets put it in their own headlines: a young accused is never named in mainstream headlines.
 */
const NEVER_NAME =
  /\b(suppression orders?|suppressed|cannot be (legally )?(named|identified)|can't be (legally )?(named|identified)|not be named|children's court|youth (court|detention|justice)|juveniles?|young offenders?|suicid\w*|self-harm|took (his|her|their) own life)\b/i;
const YOUNG = /\b(child(ren)?|kids?|minors?|schoolboy|schoolgirl|schoolchildren|students?|teen(ager)?s?|girls?|boys?|([1-9]|1[0-7])-year-olds?|underage)\b/i;
const FAMILY = /\b(daughters?|sons?|step\w+|niece|nephew|grand(daughter|son|child\w*)|father|mother|dad|mum|uncle|aunt|cousin|brother|sister|relatives?|family member)\b/i;
const VICTIM_BEFORE = /\b(victims?|complainants?|survivors?|accusers?|alleged victims?|the woman|the girl|the boy)\b[^.]{0,25}$/i;

/** Capitalised words that start names of places and organisations, or common words, rather than people. */
const NOT_PERSON = new Set(
  "the a an and of in on at for to by with from new south north east west australian australia federal state supreme high district county magistrates court courts police government council parliament university department service services news minister premier prime president labor liberal greens national party city street road house senate police's ministry office commission tribunal hospital school club league cup inquiry royal united kingdom states his her their after before over under former allegations alleged accused man woman mr mrs ms dr sir dame against made says said claims amid faces denies charged sexual misconduct assault abuse".split(" "),
);

/** Two to four capitalised words: "Neil Gaiman", "Mary Anne Smith". */
const NAME_RUN = /\b\p{Lu}[\p{Ll}'’-]+(?:\s+\p{Lu}[\p{Ll}'’-]+){1,3}\b/gu;

function candidates(text: string): Map<string, string> {
  const found = new Map<string, string>();
  for (const m of text.matchAll(NAME_RUN)) {
    const words = m[0].split(/\s+/);
    // Trim non-name words from either end ("Against Neil Gaiman" → "Neil Gaiman").
    while (words.length && NOT_PERSON.has(words[0]!.toLowerCase())) words.shift();
    while (words.length && NOT_PERSON.has(words.at(-1)!.replace(/['’]s$/, "").toLowerCase())) words.pop();
    // Title Case headlines run other words into the name ("Misconduct Made Against Neil Gaiman").
    if (words.length > 3) words.splice(0, words.length - 2);
    if (words.length < 2 || words.some((w) => NOT_PERSON.has(w.toLowerCase()))) continue;
    const before = text.slice(Math.max(0, m.index! - 40), m.index! + m[0].indexOf(words[0]!));
    if (VICTIM_BEFORE.test(before)) continue;
    const surname = words.at(-1)!.replace(/['’]s$/, "");
    found.set(surname.toLowerCase(), [...words.slice(0, -1), surname].join(" "));
  }
  return found;
}

/** Whether anyone in this story may be named: "no", "headlines" (three outlets' headlines, a child involved) or "yes". */
export function mayName(items: Item[]): "no" | "headlines" | "yes" {
  const text = items.map((i) => `${i.title} ${i.summary}`);
  if (text.some((t) => NEVER_NAME.test(t))) return "no";
  if (!text.some((t) => YOUNG.test(t))) return "yes";
  return text.some((t) => FAMILY.test(t)) ? "no" : "headlines";
}

/** Surname → full name, for people several independent outlets name (careful and brief stories only). */
export function namedByOutlets(blocks: SourceBlock[], mode: LegalMode): Map<string, string> {
  const named = new Map<string, string>();
  const allowed = mode === "normal" ? "no" : mayName(blocks.map((b) => b.item));
  if (allowed === "no") return named;
  const titlesOnly = mode === "brief" || allowed === "headlines";
  const needed = allowed === "headlines" ? 3 : 2;
  const owners = new Map<string, Set<string>>();
  const full = new Map<string, string>();
  for (const b of blocks) {
    const text = titlesOnly ? b.item.title : `${b.item.title}. ${b.text}`;
    for (const [surname, name] of candidates(text)) {
      owners.set(surname, (owners.get(surname) ?? new Set()).add(b.item.source.owner_group));
      if (!full.has(surname) || name.length < full.get(surname)!.length) full.set(surname, name);
    }
  }
  for (const [surname, groups] of owners) if (groups.size >= needed) named.set(surname, full.get(surname)!);
  return named;
}
