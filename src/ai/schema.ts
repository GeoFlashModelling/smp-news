/** What the model must return for one story (full-comparison format, step 2.2). */
export interface Citation {
  source: string;
  quote: string;
}

export interface Claim {
  text: string;
  cites: Citation[];
}

export interface StorySummary {
  headline: string;
  summary: Claim[];
  agreed: Claim[];
  differences: Claim[];
  only_reported_by: Claim[];
  conflicts: Claim[];
}

export const CLAIM_LISTS = ["summary", "agreed", "differences", "only_reported_by", "conflicts"] as const;
export type ClaimList = (typeof CLAIM_LISTS)[number];

const claimSchema = {
  type: "object",
  properties: {
    text: { type: "string" },
    cites: {
      type: "array",
      minItems: 1,
      maxItems: 4,
      items: {
        type: "object",
        properties: { source: { type: "string" }, quote: { type: "string" } },
        required: ["source", "quote"],
      },
    },
  },
  required: ["text", "cites"],
} as const;

const claims = (min: number, max: number) => ({ type: "array", minItems: min, maxItems: max, items: claimSchema });

/** JSON schema passed to the model as its required output format. */
export const SUMMARY_JSON_SCHEMA = {
  type: "object",
  properties: {
    headline: { type: "string" },
    summary: claims(2, 4),
    agreed: claims(0, 5),
    differences: claims(0, 4),
    only_reported_by: claims(0, 4),
    conflicts: claims(0, 3),
  },
  required: ["headline", ...CLAIM_LISTS],
} as const;
