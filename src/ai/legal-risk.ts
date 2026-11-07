import type { Item } from "../lib/normalise.js";

/**
 * Legal-risk filter (step 2.5 draft). Court, crime, sexual-offence, youth and suicide stories are never rewritten
 * by AI: they stay headline + links only. Deliberately broad; a false positive only costs a summary.
 */
const RISK_WORDS =
  /\b(court|courts|trial|tribunal|judge|jury|charged|charges|accused|alleged(ly)?|allegations?|guilty|convicted|sentenced|jailed|prison|bail|remand|murder(ed|er)?|manslaughter|stabb(ed|ing)|shooting|shot dead|homicide|rape|raped|sexual|sex abuse|child abuse|abuse images|paedophil\w*|pedophil\w*|grooming|assault(ed)?|suicide|self-harm|inquest|coroner|arrest(ed)?|police|detectives?|juvenile|teenager|teen|schoolboy|schoolgirl|youth detention|custody|defamation|defamed|sued|lawsuit)\b/i;

const RISK_SHARE = 0.3;

export function isLegalRisk(items: Item[]): boolean {
  if (items.length === 0) return false;
  const hits = items.filter((i) => RISK_WORDS.test(`${i.title} ${i.summary}`)).length;
  return hits / items.length >= RISK_SHARE;
}
