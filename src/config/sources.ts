import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

export const LEANS = ["left", "centre-left", "centre", "centre-right", "right"] as const;
export const CONTENT_TYPES = ["news", "analysis", "opinion", "feel-good"] as const;
export const PAYWALLS = ["free", "partial", "paywalled"] as const;
export const RATING_REGIONS = ["AU", "US", "UK"] as const;
export const FEED_VIA = ["direct"] as const;
export const SECTIONS = [
  "local-wa",
  "australia",
  "world",
  "politics",
  "business",
  "sport",
  "science-tech",
  "entertainment",
  "feel-good",
] as const;
/** Sections where a source may have no political lean (it is then left out of the coverage bar). */
export const NON_POLITICAL_SECTIONS: readonly Section[] = ["sport", "science-tech", "entertainment", "feel-good"];

export type Lean = (typeof LEANS)[number];
export type BarLean = "left" | "centre" | "right";
export type Section = (typeof SECTIONS)[number];

export interface Feed {
  url: string;
  sections: Section[];
  via: (typeof FEED_VIA)[number];
}

export interface Source {
  id: string;
  name: string;
  homepage: string;
  lean: Lean | null;
  content_type: (typeof CONTENT_TYPES)[number];
  owner_group: string;
  paywall: (typeof PAYWALLS)[number];
  region_of_rating: (typeof RATING_REGIONS)[number];
  enabled: boolean;
  /** Whether article text beyond the feed's title + description may be fetched and processed (step 0.5). */
  full_text_allowed: boolean;
  /** Whether this source's titles/descriptions may be sent to AI models (embeddings, summaries). False = headline + link only. */
  ai_input_allowed: boolean;
  feeds: Feed[];
  notes?: string;
}

export interface SourcesConfig {
  version: number;
  checked: string;
  sources: Source[];
}

export const SOURCES_PATH = new URL("../../config/sources.json", import.meta.url);

export function toBarLean(lean: Lean): BarLean {
  if (lean === "left" || lean === "centre-left") return "left";
  if (lean === "right" || lean === "centre-right") return "right";
  return "centre";
}

function isOneOf<T extends string>(values: readonly T[], value: unknown): value is T {
  return typeof value === "string" && (values as readonly string[]).includes(value);
}

function isHttpsUrl(value: unknown): boolean {
  if (typeof value !== "string") return false;
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}

/** Returns a list of human-readable problems; an empty list means the config is valid. */
export function validateSources(config: unknown): string[] {
  const problems: string[] = [];
  const cfg = config as Partial<SourcesConfig> | null;
  if (!cfg || typeof cfg !== "object" || !Array.isArray(cfg.sources)) {
    return ["config must be an object with a `sources` array"];
  }

  const ids = new Set<string>();
  const urls = new Set<string>();
  cfg.sources.forEach((s, i) => {
    const at = `sources[${i}]${s?.id ? ` (${s.id})` : ""}`;
    if (!s || typeof s !== "object") return problems.push(`${at}: not an object`);
    if (typeof s.id !== "string" || !/^[a-z0-9-]+$/.test(s.id)) problems.push(`${at}: id must be lowercase-kebab`);
    else if (ids.has(s.id)) problems.push(`${at}: duplicate id`);
    else ids.add(s.id);
    if (typeof s.name !== "string" || !s.name) problems.push(`${at}: name missing`);
    if (!isHttpsUrl(s.homepage)) problems.push(`${at}: homepage must be an https URL`);
    if (!isOneOf(CONTENT_TYPES, s.content_type)) problems.push(`${at}: content_type must be one of ${CONTENT_TYPES.join(", ")}`);
    if (s.lean === null) {
      const political = (s.feeds ?? []).flatMap((f) => f?.sections ?? []).filter((x) => !NON_POLITICAL_SECTIONS.includes(x));
      if (political.length > 0) problems.push(`${at}: lean is required for sources in ${[...new Set(political)].join(", ")}`);
    } else if (!isOneOf(LEANS, s.lean)) {
      problems.push(`${at}: lean must be one of ${LEANS.join(", ")} or null`);
    }
    if (typeof s.owner_group !== "string" || !s.owner_group) problems.push(`${at}: owner_group missing`);
    if (!isOneOf(PAYWALLS, s.paywall)) problems.push(`${at}: paywall must be one of ${PAYWALLS.join(", ")}`);
    if (!isOneOf(RATING_REGIONS, s.region_of_rating)) problems.push(`${at}: region_of_rating must be one of ${RATING_REGIONS.join(", ")}`);
    if (typeof s.enabled !== "boolean") problems.push(`${at}: enabled must be true or false`);
    if (typeof s.full_text_allowed !== "boolean") problems.push(`${at}: full_text_allowed must be true or false`);
    if (typeof s.ai_input_allowed !== "boolean") problems.push(`${at}: ai_input_allowed must be true or false`);
    if (s.full_text_allowed && !s.ai_input_allowed) problems.push(`${at}: full_text_allowed requires ai_input_allowed`);
    if (!Array.isArray(s.feeds)) return problems.push(`${at}: feeds must be an array`);
    if (s.enabled && s.feeds.length === 0) problems.push(`${at}: enabled source has no feeds (set enabled to false and note why)`);
    s.feeds.forEach((f, j) => {
      const fat = `${at}.feeds[${j}]`;
      if (!isHttpsUrl(f?.url)) problems.push(`${fat}: url must be an https URL`);
      else if (urls.has(f.url)) problems.push(`${fat}: duplicate url`);
      else urls.add(f.url);
      if (!isOneOf(FEED_VIA, f?.via)) problems.push(`${fat}: via must be one of ${FEED_VIA.join(", ")}`);
      if (!Array.isArray(f?.sections) || f.sections.length === 0 || !f.sections.every((x) => isOneOf(SECTIONS, x))) {
        problems.push(`${fat}: sections must be a non-empty list of ${SECTIONS.join(", ")}`);
      }
    });
    return undefined;
  });
  return problems;
}

export async function loadSources(path: URL = SOURCES_PATH): Promise<SourcesConfig> {
  const config: unknown = JSON.parse(await readFile(path, "utf8"));
  const problems = validateSources(config);
  if (problems.length > 0) {
    throw new Error(`Invalid ${fileURLToPath(path)}:\n  - ${problems.join("\n  - ")}`);
  }
  return config as SourcesConfig;
}
