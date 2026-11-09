import type { Item } from "../lib/normalise.js";

/**
 * Legal-risk rules (step 2.5). Court and crime stories are written in "careful" mode: every allegation attributed,
 * nobody named, nobody presented as guilty unless convicted (see CAREFUL_RULES in prompt.ts and the checks in validate.ts).
 * Sexual offences (identifying a victim is a crime in every state), young people in crime stories, suicide and
 * self-harm, and anything mentioning a suppression order get "brief" mode: at most three factual sentences, with no
 * relationships, places or methods that could identify anyone (BRIEF_RULES in prompt.ts).
 */
const CRIME =
  /\b(court|courts|trial|tribunal|judge|jury|charged|charges|accused|alleged(ly)?|allegations?|guilty|convicted|sentenced|jailed|prison|bail|remand|murder(ed|er)?|manslaughter|stabb(ed|ing)|shooting|shot dead|homicide|assault(ed)?|inquest|coroner|arrest(ed)?|police|detectives?|custody|defamation|defamed|sued|lawsuit)\b/i;
const SENSITIVE =
  /\b(rape[ds]?|sexual(ly)? (assault\w*|abuse\w*|offen\w+|touch\w*)|sex (abuse|offen\w+|crimes?)|indecent\w*|child abuse|abuse (images|material)|child exploitation|paedophil\w*|pedophil\w*|grooming|incest|suicide|self-harm|suppression orders?|suppressed|cannot be (legally )?named|can't be (legally )?named|children's court|youth (detention|justice)|juveniles?|young offenders?)\b/i;
/** A child or teenager in a crime story: they may not be identified. */
const YOUTH = /\b(teen(ager)?s?|schoolboy|schoolgirl|minors?|([1-9]|1[0-7])-year-old)\b/i;
/** Stories about suicide or self-harm show support line details (Mindframe guidelines). */
export const SUICIDE = /\b(suicid\w*|self-harm|took (his|her|their) own life)\b/i;
const CRIME_SHARE = 0.3;

export type LegalMode = "normal" | "careful" | "brief";

export function legalMode(items: Item[]): LegalMode {
  if (items.length === 0) return "normal";
  const text = items.map((i) => `${i.title} ${i.summary}`);
  const crime = text.filter((t) => CRIME.test(t)).length / items.length >= CRIME_SHARE;
  if (text.some((t) => SENSITIVE.test(t)) || (crime && text.some((t) => YOUTH.test(t)))) return "brief";
  return crime ? "careful" : "normal";
}

/** Court, crime and the sensitive kinds: no photos of people, not in "Worth a look". */
export function isLegalRisk(items: Item[]): boolean {
  return legalMode(items) !== "normal";
}
