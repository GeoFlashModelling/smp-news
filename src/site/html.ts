import type { Section } from "../config/sources.js";

export const SITE_NAME = "S.M.P. News";
export const SITE_HOST = "thesmpnews.com";
export const CORRECTIONS_EMAIL = `corrections@${SITE_HOST}`;
export const TIME_ZONE = "Australia/Perth";
/** AI summaries are switched on with SUMMARIES=on (a GitHub repository variable); the site's wording follows. */
export const SUMMARIES_ON = process.env.SUMMARIES === "on";

export const SECTION_LABELS: Record<Section, string> = {
  "local-wa": "Local WA",
  australia: "Australia",
  politics: "Politics",
  world: "World",
  business: "Business",
  "science-tech": "Science & Space",
  tech: "AI, Tech & Gadgets",
  sport: "Sport",
  entertainment: "Entertainment",
  "feel-good": "Feel Good",
};

/** Menu and front-page order: local first (Perth/WA for now), then Australia, the world, then the rest. */
export const NAV_ORDER: readonly Section[] = ["local-wa", "australia", "world", "politics", "business", "science-tech", "tech", "sport", "entertainment", "feel-good"];

const ESCAPES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };

/** Escapes text for HTML content and attribute values. Every piece of feed text goes through this. */
export function esc(value: string | number): string {
  return String(value).replace(/[&<>"']/g, (c) => ESCAPES[c]!);
}

const dateTime = new Intl.DateTimeFormat("en-AU", { timeZone: TIME_ZONE, day: "numeric", month: "short", hour: "numeric", minute: "2-digit", hour12: true });

/** "7 Nov, 8:15 pm AWST", in a <time> element that a small script turns into "3 h ago". */
export function timeTag(d: Date): string {
  const text = `${dateTime.format(d).replace(/\s?([ap])\.?m\.?$/i, " $1m")} AWST`;
  return `<time datetime="${d.toISOString()}" data-rel>${esc(text)}</time>`;
}

export function plural(n: number, word: string, many = `${word}s`): string {
  return `${n} ${n === 1 ? word : many}`;
}

export interface PageOptions {
  title: string;
  description: string;
  /** Path depth from the site root, for relative asset links: "" at root, "../../" for /story/x/. */
  root: string;
  active?: Section | "about" | "weather" | "quiz";
  body: string;
  updated: Date;
}

export function page(o: PageOptions): string {
  const nav = NAV_ORDER.map(
    (s) => `<a href="${o.root}${s}/"${o.active === s ? ' aria-current="page"' : ""}>${esc(SECTION_LABELS[s])}</a>`,
  ).join("");
  const extra = (
    [
      ["weather", "Weather"],
      ["quiz", "Quiz"],
      ["about", "How this works"],
    ] as const
  )
    .map(([path, label]) => `<a href="${o.root}${path}/"${o.active === path ? ' aria-current="page"' : ""}>${label}</a>`)
    .join("");
  return `<!doctype html>
<html lang="en-AU">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>${esc(o.title)}</title>
<meta name="description" content="${esc(o.description)}">
<meta name="theme-color" content="#162939">
<link rel="icon" href="${o.root}assets/favicon.svg" type="image/svg+xml">
<link rel="manifest" href="${o.root}manifest.webmanifest">
<link rel="stylesheet" href="${o.root}assets/site.css">
</head>
<body>
<a class="skip" href="#main">Skip to stories</a>
<header class="masthead">
  <div class="wrap mast-row">
    <a class="brand" href="${o.root}" aria-label="${SITE_NAME} home"><img src="${o.root}assets/smp-wordmark.svg" alt="S.M.P." width="104" height="25"><span>News</span></a>
    <p class="tagline">Every side of the story, side by side</p>
  </div>
  <nav class="sections" aria-label="Sections"><div class="wrap">${nav}${extra}</div></nav>
</header>
<div class="preview" role="note"><div class="wrap"><strong>Preview edition.</strong> Stories are grouped automatically from <a href="${o.root}about/">free news sources</a>. ${SUMMARIES_ON ? "Summaries are written by AI from those sources and checked automatically; open a story to compare every side." : "Written summaries of what every side reports are coming soon; for now you can see who covered each story and read it from several sides."}</div></div>
<main id="main" class="wrap">
${o.body}
</main>
<footer class="foot">
  <div class="wrap">
    <p><img src="${o.root}assets/smp-wordmark.svg" alt="" width="70" height="17"> A product of S.M.P. · <a href="${o.root}about/">How this works</a> · <a href="${o.root}about/#corrections">Corrections</a></p>
    <p class="small">Edition updated ${timeTag(o.updated)}. Headlines and links belong to their publishers; we link to every source.</p>
  </div>
</footer>
<script src="${o.root}assets/site.js" defer></script>
</body>
</html>
`;
}
