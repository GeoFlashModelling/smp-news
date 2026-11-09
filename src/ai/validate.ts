import type { LegalMode } from "./legal-risk.js";
import { summarySentences, type SourceBlock } from "./prompt.js";
import { CLAIM_LISTS, type Claim, type ClaimList, type StorySummary } from "./schema.js";

/**
 * Support check (step 2.4 draft). A claim passes only if every citation quotes its source, and every number
 * and name in the claim appears in one of the cited sources. Anything with a link or markup is rejected.
 */
export interface ValidationResult {
  summary: StorySummary | null;
  errors: string[];
  dropped: number;
  kept: number;
}

const MAX_HEADLINE_CHARS = 110;
const MAX_CLAIM_CHARS = 360;
const MIN_QUOTE_WORDS = 4;
const QUOTE_MATCH = 0.8;
const MAX_DROPPED_SHARE = 0.3;
const FORBIDDEN = /https?:|www\.|<[a-z/!]|\]\(|\*\*|`|#{2,}/i;

/** Lower-case words with quote marks, dashes and punctuation evened out, so a near-exact copy still matches. */
function words(text: string): string[] {
  return text
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u2018\u2019\u201B']/g, "")
    .replace(/[^\p{L}\p{N}%$.]+/gu, " ")
    .replace(/\.(?!\d)/g, " ")
    .split(" ")
    .filter(Boolean);
}

/** Length of the longest unbroken run of words that `a` and `b` share. */
function longestRun(a: string[], b: string[]): number {
  let best = 0;
  let prev = new Array<number>(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i++) {
    const row = new Array<number>(b.length + 1).fill(0);
    for (let j = 1; j <= b.length; j++) {
      if (a[i - 1] === b[j - 1]) {
        row[j] = prev[j - 1]! + 1;
        if (row[j]! > best) best = row[j]!;
      }
    }
    prev = row;
  }
  return best;
}

/** Our sentences must be our own words: this many consecutive words shared with a source counts as copying. */
const COPY_RUN_WORDS = 9;
/** Stricter when one outlet's report is the only source, so the result can't read as a reworded copy of it. */
const COPY_RUN_WORDS_SINGLE = 7;
const PROFANITY = /\b(fuck\w*|shit\w*|cunt\w*|bitch\w*|motherf\w*)\b/i;

/** Finds a cited source by its label (S1) or, failing that, by outlet name, which small models often write instead. */
function findBlock(ref: string | undefined, blocks: SourceBlock[]): SourceBlock | undefined {
  const r = (ref ?? "").trim().replace(/^\[|\]$/g, "").toLowerCase();
  if (!r) return undefined;
  return (
    blocks.find((b) => b.id.toLowerCase() === r) ??
    blocks.find((b) => b.item.source.name.toLowerCase() === r) ??
    blocks.find((b) => b.item.source.name.toLowerCase().startsWith(r) || r.startsWith(b.item.source.name.toLowerCase()))
  );
}

const NUMBER = /\d[\d,.]*/g;
/** Capitalised words that are not names (sentence openers, months, common title words). */
const NOT_NAMES = new Set(
  "the a an and but or in on at of for to from by with after before during as it its this that these those he she they his her their there here when while where what who which why how however meanwhile both all some several other others outlets outlet reports reported report according said says also more most only one two three four five six seven eight nine ten first second third new monday tuesday wednesday thursday friday saturday sunday january february march april may june july august september october november december mr mrs ms dr prime minister president premier government police court federal state national".split(
    " ",
  ),
);

/** Runs of capitalised words (e.g. "Donald Trump"), skipping sentence openers and common non-name words. */
function names(text: string): string[][] {
  const out: string[][] = [];
  for (const sentence of text.split(/(?<=[.!?])\s+/)) {
    let run: string[] = [];
    const flush = () => {
      if (run.length) out.push(run);
      run = [];
    };
    sentence.split(/\s+/).forEach((raw, n) => {
      const word = raw.replace(/^[^\p{L}]+|[^\p{L}]+$/gu, "").replace(/['\u2019]s$/u, "");
      const isName = n > 0 && word.length >= 2 && /^\p{Lu}/u.test(word) && !NOT_NAMES.has(word.toLowerCase());
      if (isName) run.push(word);
      else flush();
      if (/[,;:)]$/.test(raw)) flush();
    });
    flush();
  }
  return out;
}

const DEMONYMS: Record<string, string> = {
  australian: "australia", australians: "australia", aussie: "australia", chinese: "china", american: "us", americans: "us",
  british: "uk", european: "europe", europeans: "europe", irish: "ireland", iranian: "iran", israeli: "israel", palestinian: "palestine",
  palestinians: "gaza", russian: "russia", ukrainian: "ukraine", italian: "italy", french: "france", german: "germany", japanese: "japan",
  indian: "india", canadian: "canada", kiwi: "zealand", kiwis: "zealand", "west australian": "wa", "western australia": "wa",
};

/**
 * A name passes if its last word (usually the surname) appears in the support text, so "Donald Trump" passes when
 * the sources say "Trump". Nationality words pass when the country is mentioned ("Australian" for "Australia").
 */
function nameSupported(name: string[], support: Set<string>): boolean {
  const last = words(name[name.length - 1]!);
  if (last.every((w) => support.has(w))) return true;
  const phrase = name.join(" ").toLowerCase();
  const country = DEMONYMS[phrase] ?? DEMONYMS[last.join(" ")];
  return country !== undefined && (support.has(country) || (country === "wa" && support.has("western")));
}

/** "CNA (Channel NewsAsia)" may be written as "CNA" or "Channel NewsAsia". */
function outletNames(name: string): string[] {
  const m = /^(.*?)\s*\((.+)\)$/.exec(name);
  return m ? [name, m[1]!, m[2]!] : [name];
}

/** Small models sometimes leave source labels such as "[S2]" or "(S1, S3)" inside the sentence. */
export function stripLabels(text: string): string {
  return text
    .replace(/\s*[[(]\s*S\d+(\s*[,;&]\s*S\d+)*\s*[\])]/g, "")
    .replace(/\s+([.,;:])/g, "$1")
    .trim();
}

/**
 * Court and crime stories: a sentence saying someone did something criminal, or is accused or suspected of it, must
 * say who says so; and no one may be labelled as an offender. Plain facts (where, when, how many hurt) need neither.
 */
const ACCUSING =
  /\b(stabb?(ed|ing)|shot|shoot(s|ing)? at|killed|kills|murder(ed|s)?|assault(ed|s)?|attack(ed|s)|robb(ed|s)|stole|steal(s|ing)|kidnapp\w*|abduct\w*|set fire|torched|rammed|opened fire|fired at|punch(ed|es)|threaten(ed|s)|defraud\w*|embezzl\w*|brib(ed|es|ery)|smuggl\w*|traffick\w*|charged|accused|suspect(s|ed)?|offend(ed|er|ers)|confess\w*|responsible for|carried out|gunman|attacker|assailant)\b/i;
const ATTRIBUTION =
  /\b(police|court|alleg\w*|accused|charged|charges?|reported|reports?|said|says|told|according|heard|prosecut\w*|magistrate|judge|jury|claim\w*|pleaded|plea|convicted|found guilty|sentenced|investigat\w*|detectives?|authorities|officials?|inquiry|coroner|inquest)\b/i;
const OFFENDER_LABEL = /\b(murderers?|killers?|perpetrators?|criminals?|thugs?|monsters?|rapists?|predators?|culprits?)\b/i;

/** The model talking about its task instead of the news ("the provided sources do not…"): never publishable. */
const META = /\b(provided (sources?|reports?|material|text)|the sources? (do|does|did) not|no (relevant )?(news )?event|not enough information|cannot (determine|summari[sz]e)|as an AI|source material)\b/i;

/**
 * People involved in a crime or court story, as named in its reports: a capitalised name next to an age, an honorific
 * or a charge ("John Smith, 34,", "Mr Smith", "Smith pleaded"). Their surnames must not appear in our text.
 */
const NAME_THEN_CUE = /^\s*(,?\s*\(?\d{1,2}\)?\s*,|,?\s*aged \d|('s)?\s*(lawyer|family|body|death)|\s+(has |had |was |is )?(been )?(pleaded|charged|accused|arrested|jailed|sentenced|convicted|acquitted|appeared|faced|allegedly|died|killed|stabbed|shot|murdered|denie[sd]|admitted|refused bail|granted bail|remanded|told the court))/i;
const CUE_THEN_NAME = /\b(Mr|Mrs|Ms|Miss|named as|identified as|victim|accused|offender|alleged|deceased|late)[,:]?\s*$/i;
/** Capitalised at the start of a headline ("Man charged…"), but describing someone rather than naming them. */
const DESCRIBING = new Set("man men woman women boy boys girl girls teen teens teenager teenagers youth person people pair couple driver drivers rider motorist pedestrian father mother dad mum son daughter husband wife partner brother sister police officer officers worker workers student students resident residents tourist tourists victim victims suspect suspects accused gunman attacker".split(" "));

export function peopleInvolved(blocks: SourceBlock[]): Set<string> {
  const people = new Set<string>();
  for (const b of blocks) {
    const text = `${b.item.title}. ${b.text}`;
    for (const m of text.matchAll(/\b\p{Lu}[\p{L}'’-]+(?:\s+\p{Lu}[\p{L}'’-]+){0,3}/gu)) {
      const before = text.slice(Math.max(0, m.index! - 20), m.index);
      const after = text.slice(m.index! + m[0].length, m.index! + m[0].length + 40);
      if (!NAME_THEN_CUE.test(after) && !CUE_THEN_NAME.test(before)) continue;
      const surname = m[0].split(/\s+/).pop()!.replace(/['’]s$/, "").toLowerCase();
      if (surname.length >= 3 && !NOT_NAMES.has(surname) && !DESCRIBING.has(surname)) people.add(surname);
    }
  }
  return people;
}

function namesPerson(text: string, people: Set<string>): string | undefined {
  return words(text).find((w) => people.has(w));
}

/** Brief-mode stories (legal-risk.ts): relationships, places and methods that could identify a victim or cause harm. */
const IDENTIFYING =
  /\b(daughters?|sons?|step\w+|niece|nephew|grand(daughter|son|child\w*)|wife|husband|partner|girlfriend|boyfriend|mother|father|mum|dad|brother|sister|uncle|aunt|cousin|relatives?|teacher|coach|school|street|road|suburb|home in)\b/i;
const SUICIDE_METHOD = /\b(hang\w*|overdos\w*|jump\w*|fell from|poison\w*|gunshot|shot (him|her|them)self|drown\w*|method)\b/i;

function checkClaim(claim: Claim, list: ClaimList, blocks: SourceBlock[], storyWords: Set<string>, mode: LegalMode, people = new Set<string>()): string[] {
  const careful = mode !== "normal";
  const errors: string[] = [];
  const text = typeof claim.text === "string" ? stripLabels(claim.text) : "";
  claim.text = text;
  if (!text) return ["empty text"];
  if (text.length > MAX_CLAIM_CHARS) errors.push("text too long");
  if (FORBIDDEN.test(text)) errors.push("link or markup in text");
  if (PROFANITY.test(text)) errors.push("profanity");
  if (careful && ACCUSING.test(text) && !ATTRIBUTION.test(text)) errors.push("crime story: say who says so (police allege, the court heard, ... reported)");
  if (careful && OFFENDER_LABEL.test(text)) errors.push("crime story: don't label anyone as an offender");
  const named = careful ? namesPerson(text, people) : undefined;
  if (named) errors.push(`crime story: don't name people involved ("${named}"); describe them instead`);
  if (mode === "brief" && IDENTIFYING.test(text)) errors.push("sensitive story: leave out relationships, schools, workplaces and places that could identify anyone");
  if (mode === "brief" && SUICIDE_METHOD.test(text)) errors.push("sensitive story: never describe how or where someone died or was harmed");
  if (META.test(text)) errors.push("talks about the sources instead of the news");
  if (!Array.isArray(claim.cites) || claim.cites.length === 0) return [...errors, "no citations"];

  const textWords = words(text);
  const copyRun = blocks.length === 1 ? COPY_RUN_WORDS_SINGLE : COPY_RUN_WORDS;
  for (const block of blocks) {
    if (longestRun(textWords, words(`${block.item.title} ${block.text}`)) >= copyRun) errors.push(`copies wording from ${block.id}`);
  }

  const cited: SourceBlock[] = [];
  for (const cite of claim.cites) {
    const block = findBlock(cite.source, blocks);
    if (!block) {
      errors.push(`unknown source ${cite.source}`);
      continue;
    }
    cite.source = block.id;
    cited.push(block);
    const quote = words(cite.quote ?? "");
    if (quote.length < MIN_QUOTE_WORDS) errors.push(`${block.id} quote too short`);
    else if (longestRun(quote, words(`${block.item.title} ${block.text}`)) / quote.length < QUOTE_MATCH) errors.push(`${block.id} quote not found in source`);
  }
  if (cited.length === 0) return errors;

  const support = cited.map((b) => `${b.item.title} ${b.text} ${b.item.source.name}`).join(" ");
  const supportWords = new Set(words(support));
  for (const num of text.match(NUMBER) ?? []) {
    const plain = num.replace(/[.,]+$/, "");
    if (!support.replace(/,/g, "").includes(plain.replace(/,/g, ""))) errors.push(`number ${plain} not in cited sources`);
  }
  for (const name of names(text)) {
    if (!nameSupported(name, supportWords) && !nameSupported(name, storyWords)) errors.push(`name "${name.join(" ")}" not in the story's reports`);
  }

  const owners = new Set(cited.map((b) => b.item.source.owner_group));
  if (list === "agreed" && owners.size < 2) errors.push("agreed fact needs two independent outlets");
  const namesOutlet = cited.some((b) => outletNames(b.item.source.name).some((n) => text.includes(n)));
  if ((list === "differences" || list === "only_reported_by" || list === "conflicts") && !namesOutlet) errors.push("does not name the outlet");
  if (list === "only_reported_by" && owners.size > 1) errors.push("only-reported-by cites several outlets");
  return errors;
}

/** `headlines` are every report's headline for the story; the new headline may use names and numbers from them. */
export function validateSummary(raw: unknown, blocks: SourceBlock[], headlines: string[] = [], mode: LegalMode = "normal"): ValidationResult {
  const careful = mode !== "normal";
  const result: ValidationResult = { summary: null, errors: [], dropped: 0, kept: 0 };
  if (typeof raw !== "object" || raw === null) return { ...result, errors: ["not a JSON object"] };
  const draft = raw as Partial<StorySummary>;
  const allText = [...blocks.map((b) => `${b.item.title} ${b.text} ${b.item.source.name}`), ...headlines].join(" ");
  const allWords = new Set(words(allText));
  const people = careful ? peopleInvolved(blocks) : new Set<string>();

  const headline = typeof draft.headline === "string" ? stripLabels(draft.headline) : "";
  if (!headline) result.errors.push("headline missing");
  else {
    if (headline.length > MAX_HEADLINE_CHARS) result.errors.push("headline too long");
    if (FORBIDDEN.test(headline) || PROFANITY.test(headline)) result.errors.push("headline has a link, markup or profanity");
    if (careful && OFFENDER_LABEL.test(headline)) result.errors.push("headline labels someone as an offender");
    if (careful && namesPerson(headline, people)) result.errors.push("headline names a person involved in a crime story");
    if (mode === "brief" && (IDENTIFYING.test(headline) || SUICIDE_METHOD.test(headline))) result.errors.push("headline has identifying or harmful detail in a sensitive story");
    if (META.test(headline)) result.errors.push("headline talks about the sources instead of the news");
    for (const name of names(`X ${headline}`)) if (!nameSupported(name, allWords)) result.errors.push(`headline name "${name.join(" ")}" not in sources`);
    for (const num of headline.match(NUMBER) ?? []) if (!allText.replace(/,/g, "").includes(num.replace(/,/g, "").replace(/[.,]+$/, ""))) result.errors.push(`headline number ${num} not in sources`);
  }

  const clean: StorySummary = { headline, summary: [], agreed: [], differences: [], only_reported_by: [], conflicts: [] };
  // With one report there is nothing to compare, and a sensitive story gets no detail beyond its brief summary.
  const single = blocks.length === 1;
  const maxSentences = summarySentences(blocks, mode);
  for (const list of single || mode === "brief" ? (["summary"] as const) : CLAIM_LISTS) {
    const all = Array.isArray(draft[list]) ? (draft[list] as Claim[]) : [];
    const claims = list === "summary" ? all.slice(0, maxSentences) : all;
    for (const claim of claims) {
      const errors = checkClaim(claim, list, blocks, allWords, mode, people);
      if (errors.length === 0) {
        clean[list].push({ text: claim.text, cites: claim.cites });
        result.kept++;
      } else {
        result.dropped++;
        result.errors.push(`${list}: "${String(claim.text).slice(0, 60)}…": ${errors.join("; ")}`);
      }
    }
  }

  const total = result.kept + result.dropped;
  const failed = !headline || result.errors.some((e) => e.startsWith("headline") || e.startsWith("link")) || clean.summary.length < (single ? 1 : 2) || (total > 0 && result.dropped / total > MAX_DROPPED_SHARE);
  return { ...result, summary: failed ? null : clean };
}
