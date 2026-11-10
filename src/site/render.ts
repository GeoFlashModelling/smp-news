import { legalMode, SUICIDE } from "../ai/legal-risk.js";
import type { Claim, ClaimList } from "../ai/schema.js";
import { summarisable, type StoryWriteup } from "../ai/summarise.js";
import type { Section, Source } from "../config/sources.js";
import type { Photo } from "../images/wikimedia.js";
import type { Fact, Facts } from "../lib/facts.js";
import type { Item } from "../lib/normalise.js";
import type { Quiz } from "../lib/quiz.js";
import type { Forecast } from "../lib/weather.js";
import { quizBox, weatherStrip } from "./extras.js";
import { coverageGroup, SECTION_HEADLINES, SECTION_LINKS, sectionCards, type CoverageGroup, type FrontPage, type Story } from "../lib/stories.js";
import { CORRECTIONS_EMAIL, NAV_ORDER, SECTION_LABELS, SITE_NAME, SUMMARIES_ON, esc, page, plural, timeTag } from "./html.js";

const GROUP_LABELS: Record<CoverageGroup, string> = {
  left: "Left",
  centre: "Centre",
  right: "Right",
  local: "Local / unrated",
  unrated: "Not politically rated",
  official: "Official statement",
};
const GROUP_HEADINGS: Record<CoverageGroup, string> = {
  left: "Left-leaning sources",
  centre: "Centre sources",
  right: "Right-leaning sources",
  local: "Local and community sources (unrated)",
  unrated: "Specialist sources (not politically rated)",
  official: "Official statements",
};
const BAR_GROUPS: readonly CoverageGroup[] = ["left", "centre", "right", "local"];
/** Shown in the bar only when no rated outlet has covered the story, so every card still shows where its coverage comes from. */
const UNRATED_GROUPS: readonly CoverageGroup[] = ["unrated", "official"];
const LIST_GROUPS: readonly CoverageGroup[] = ["left", "centre", "right", "local", "unrated", "official"];
const SIDE_WORDING = { left: "left-leaning", right: "right-leaning", centre: "centre" } as const;

function coverageBar(story: Story, large = false): string {
  const rated = BAR_GROUPS.filter((g) => story.coverage[g] > 0);
  const groups = rated.length ? rated : UNRATED_GROUPS.filter((g) => story.coverage[g] > 0);
  if (groups.length === 0) return "";
  const counts = groups.map((g) => `${GROUP_LABELS[g]} ${story.coverage[g]}`);
  const segments = groups.map((g) => `<span class="seg seg-${g}" style="flex:${story.coverage[g]}"></span>`).join("");
  return `<div class="cov${large ? " cov-lg" : ""}"><div class="bar" role="img" aria-label="Coverage: ${esc(counts.join(", "))}">${segments}</div><p class="counts">${esc(counts.join(" · "))}</p></div>`;
}

function oneSidedNote(story: Story): string {
  return story.oneSided ? `<p class="onesided">Only covered by ${SIDE_WORDING[story.oneSided]} sources so far.</p>` : "";
}

/** Credit required by the photo's licence: author, licence, and a link to the file page with the full terms. */
function photoCredit(photo: Photo): string {
  return `<a class="credit-link" href="${esc(photo.page)}" rel="noopener">Photo: ${esc(photo.artist)}, ${esc(photo.licence)}, via ${esc(photo.via)}</a>`;
}

/**
 * Portraits and near-square photos lose the face when cropped to 16:9 (often only eyes and forehead remain), so they
 * are shown whole over a blurred copy of themselves instead.
 */
const TALL_RATIO = 1.25;
function isTall(story: Story): boolean {
  return Boolean(story.photo && story.photo.width / story.photo.height < TALL_RATIO);
}

/** Display widths for a picture loaded first: the story page's photo, or the front page's lead story. */
const STORY_SIZES = "(min-width: 800px) 760px, 100vw";
const LEAD_SIZES = "(min-width: 1120px) 1088px, 100vw";

/** The story's picture: a free-licensed photo, or the section artwork (decorative, so no alt text). */
function picture(story: Story, root: string, cls: string, eagerSizes?: string): string {
  const loading = eagerSizes ? `fetchpriority="high"` : `loading="lazy"`;
  const p = story.photo;
  if (!p) return `<img class="${cls}" src="${root}assets/sections/${story.section}.svg" alt="" width="640" height="360" ${loading} decoding="async">`;
  const large = eagerSizes && p.large ? ` srcset="${esc(p.src)} 500w, ${esc(p.large)} 960w" sizes="${eagerSizes}"` : "";
  return `<img class="${cls}${isTall(story) ? " portrait" : ""}" src="${esc(p.src)}"${large} alt="${esc(p.subject)}" width="${p.width}" height="${p.height}" ${loading} decoding="async">`;
}

/** Our neutral AI headline when the story has a checked summary, otherwise the most representative outlet headline. */
function storyTitle(story: Story): string {
  return story.writeup?.summary?.headline ?? story.headline.title;
}

/** A story card; the front page's lead story is the same card, wide, with its headline over the picture. */
function storyCard(story: Story, root: string, showSection = true, label?: string, lead = false): string {
  const sources = new Set(story.items.map((i) => i.source.id)).size;
  const dek = story.writeup?.summary?.summary[0]?.text;
  const kicker = [label, showSection ? SECTION_LABELS[story.section] : undefined].filter(Boolean).join(" · ");
  const heading = lead ? "h2" : "h3";
  const text = `${kicker ? `<p class="kicker">${esc(kicker)}</p>` : ""}
  <${heading}><a href="${root}story/${story.id}/">${esc(storyTitle(story))}</a></${heading}>
  ${dek ? `<p class="dek">${esc(dek)}</p>` : ""}
  ${coverageBar(story)}${oneSidedNote(story)}
  <p class="meta">${story.independent < 2 ? `Only ${esc(story.headline.source.name)} so far` : `${plural(sources, "source")} · ${plural(story.independent, "independent owner")}`} · updated ${timeTag(story.last)}</p>`;
  return `<article class="card${lead ? " lead" : ""}">
  <div class="pic${isTall(story) ? " tall" : ""}">${isTall(story) ? `<img class="pic-bg" src="${esc(story.photo!.src)}" alt="" aria-hidden="true" loading="lazy" decoding="async">` : ""}${picture(story, root, "pic-img", lead ? LEAD_SIZES : undefined)}${story.photo ? `<p class="pic-credit">${photoCredit(story.photo)}</p>` : ""}</div>
  ${lead ? `<div class="lead-text">${text}</div>` : text}
</article>`;
}

/** Shown as a card: stories we've written, plus multi-source ones when summaries are switched off. */
function isCard(story: Story): boolean {
  if (story.writeup?.summary) return true;
  return story.independent >= 2 && !SUMMARIES_ON;
}

function headlineList(stories: Story[], limit: number, root: string): string {
  if (stories.length === 0) return "";
  const rows = stories.slice(0, limit).map((s) => {
    const i = s.headline;
    return `<li>${picture(s, root, "thumb")}<div><a href="${esc(i.url)}" rel="noopener">${esc(i.title)}</a> <span class="src">${esc(i.source.name)}${i.source.paywall === "paywalled" ? " · Paywall" : ""} · ${timeTag(i.published)}</span>${s.photo ? `<span class="thumb-credit">${photoCredit(s.photo)}</span>` : ""}</div></li>`;
  });
  return `<ul class="headlines">${rows.join("")}</ul>`;
}

/** Stories of either kind as one list: multi-source ones open our story page, single reports open the outlet. */
function mixedList(stories: Story[], root: string, showSection = true): string {
  const rows = stories.map((s) => {
    const ours = s.independent >= 2 || Boolean(s.writeup?.summary);
    const href = ours ? `${root}story/${s.id}/` : s.headline.url;
    const from = s.independent >= 2 ? plural(new Set(s.items.map((i) => i.source.id)).size, "source") : `${s.headline.source.name}${s.headline.source.paywall === "paywalled" ? " · Paywall" : ""}`;
    return `<li>${picture(s, root, "thumb")}<div><a href="${esc(href)}"${ours ? "" : ' rel="noopener"'}>${esc(storyTitle(s))}</a> <span class="src">${showSection ? `${esc(SECTION_LABELS[s.section])} · ` : ""}${esc(from)} · ${timeTag(s.last)}</span>${s.photo ? `<span class="thumb-credit">${photoCredit(s.photo)}</span>` : ""}</div></li>`;
  });
  return `<ul class="headlines">${rows.join("")}</ul>`;
}

const WIKIPEDIA_CREDIT = `<a href="https://creativecommons.org/licenses/by-sa/4.0/" rel="noopener license">CC BY-SA 4.0</a>`;

/** "On this day" (changes daily) and "Fun fact" (changes hourly), from Wikipedia; a box is left out when its fact is missing. */
function factsStrip(facts: Facts, quiz: Quiz | null): string {
  const credit = (fact: Fact) => `<p class="fact-credit"><a href="${esc(fact.url)}" rel="noopener">More on Wikipedia</a> · ${WIKIPEDIA_CREDIT}</p>`;
  const day = facts.onThisDay;
  const fun = facts.funFact;
  const boxes =
    (day ? `<div class="fact fact-day"><p class="fact-label">On this day</p><p class="fact-year">${day.year}</p><p class="fact-text">${esc(day.text)}</p>${credit(day)}</div>` : "") +
    (fun ? `<div class="fact fact-fun"><p class="fact-label">Fun fact</p><p class="fact-title">Did you know?</p><p class="fact-text">${esc(fun.text)}</p>${credit(fun)}</div>` : "") +
    quizBox(quiz, "");
  return boxes ? `<section class="facts" aria-label="Facts">${boxes}</section>` : "";
}

/** Sections shown before "Worth a look": the day's news in the reader's order (local, national, world). */
const NEWS_FIRST: readonly Section[] = ["local-wa", "australia", "new-zealand", "world"];

export function renderFront(front: FrontPage, updated: Date, facts: Facts, weather: Forecast[] | null, quiz: Quiz | null): string {
  const root = "";
  const [lead, ...others] = front.top;
  const top = others.map((s) => storyCard(s, root, true, s === front.finale ? "And finally" : undefined)).join("");
  const sectionBlock = (sec: Section) => {
    const all = front.bySection.get(sec) ?? [];
    const cards = sectionCards(all, front.top, isCard);
    const links = all.filter((s) => !front.top.includes(s) && !cards.includes(s)).slice(0, SECTION_LINKS);
    if (cards.length === 0 && links.length === 0) return "";
    return `<section class="sec" aria-labelledby="h-${sec}">
  <h2 id="h-${sec}"><a href="${sec}/">${esc(SECTION_LABELS[sec])}</a></h2>
  ${cards.length ? `<div class="grid">${cards.map((s) => storyCard(s, root, false)).join("")}</div>` : ""}
  ${links.length ? `<h3 class="more">More ${esc(SECTION_LABELS[sec])} headlines</h3>${mixedList(links, root, false)}` : ""}
  <p class="all"><a href="${sec}/">All ${esc(SECTION_LABELS[sec])} →</a></p>
</section>`;
  };
  const news = NAV_ORDER.filter((sec) => NEWS_FIRST.includes(sec)).map(sectionBlock).join("");
  const rest = NAV_ORDER.filter((sec) => !NEWS_FIRST.includes(sec)).map(sectionBlock).join("");
  const body = `<h1 class="visually-hidden">${SITE_NAME}</h1>
${weatherStrip(weather, root)}
<div class="front-top">
${factsStrip(facts, quiz)}
${lead ? storyCard(lead, root, true, lead === front.finale ? "And finally" : undefined, true) : ""}
</div>
${top ? `<section aria-labelledby="h-top"><h2 id="h-top">Top stories</h2><div class="grid">${top}</div></section>` : ""}
${front.alsoLeading.length ? `<section class="sec" aria-labelledby="h-leading"><h2 id="h-leading">Also in the headlines</h2><p class="note">Leading on major Australian news sites; only one outlet has reported it so far.</p>${headlineList(front.alsoLeading, front.alsoLeading.length, root)}</section>` : ""}
${news}
${front.interesting.length ? `<section class="sec" aria-labelledby="h-worth"><h2 id="h-worth">Worth a look</h2><p class="note">Less prominent stories from science, good news, tech, business and entertainment.</p>${mixedList(front.interesting, root)}</section>` : ""}
${rest}`;
  return page({ title: `${SITE_NAME}: Our Country, Our Stories. No Agenda.`, description: "Free Australian news, made in Australia for Australians, showing how left, centre and right sources cover the same event.", root, body, updated });
}

export function renderSection(section: Section, stories: Story[], updated: Date): string {
  const root = "../";
  const cards = stories.filter((s) => s.independent >= 2 || s.writeup?.summary);
  const singles = stories.filter((s) => !cards.includes(s));
  const body = `<h1>${esc(SECTION_LABELS[section])}</h1>
${cards.length ? `<div class="grid">${cards.map((s) => storyCard(s, root, false)).join("")}</div>` : `<p>No stories written yet.</p>`}
${singles.length ? `<h2 class="more">More headlines</h2><p class="note">Reported by one outlet so far.</p>${headlineList(singles, SECTION_HEADLINES, root)}` : ""}`;
  return page({ title: `${SECTION_LABELS[section]} | ${SITE_NAME}`, description: `${SECTION_LABELS[section]} stories from many sources.`, root, active: section, body, updated });
}

function sourceRow(item: Item): string {
  const s = item.source;
  const tags = [
    s.paywall === "paywalled" ? "Paywall" : s.paywall === "partial" ? "Some paywalled" : "Free",
    s.content_type === "opinion" ? "Opinion" : s.content_type === "analysis" ? "Analysis" : null,
  ].filter(Boolean);
  const note = s.reliability_note ? `<span class="note">${esc(s.reliability_note)}</span>` : "";
  return `<li><p class="outlet">${esc(s.name)} ${tags.map((t) => `<span class="tag">${esc(t!)}</span>`).join("")}</p><a href="${esc(item.url)}" rel="noopener">${esc(item.title)}</a><p class="meta">${timeTag(item.published)}${note ? " · " : ""}${note}</p></li>`;
}

const CLAIM_HEADINGS: Record<Exclude<ClaimList, "summary">, string> = {
  agreed: "What all sides report",
  differences: "How the coverage differs",
  only_reported_by: "Only reported by one outlet",
  conflicts: "Conflicting details",
};

/** Each claim ends with links to the reports it came from. */
function claimText(claim: Claim, writeup: StoryWriteup): string {
  const outlets = new Map<string, string>();
  for (const c of claim.cites) {
    const s = writeup.sources[c.source];
    if (s && !outlets.has(s.name)) outlets.set(s.name, s.url);
  }
  const links = [...outlets].map(([name, url]) => `<a href="${esc(url)}" rel="noopener">${esc(name)}</a>`).join(", ");
  return `${esc(claim.text)}${links ? ` <span class="cites">(${links})</span>` : ""}`;
}

/** Someone has been charged, accused or brought before a court: the presumption-of-innocence note applies. */
const ACCUSATION = /\b(charged|charges|accused|alleged(ly)?|allegations?|arrested|court|trial|bail|remand(ed)?|custody|pleaded|suspects?)\b/i;

/** Summary sentences in up to three paragraphs of two or three, in the order written (what happened, details, what next). */
function paragraphs(claims: Claim[]): Claim[][] {
  const count = Math.min(3, Math.max(1, Math.floor(claims.length / 2)));
  return Array.from({ length: count }, (_, p) => claims.slice(Math.round((p * claims.length) / count), Math.round(((p + 1) * claims.length) / count)));
}

function writeupBlock(story: Story, root: string): string {
  const w = story.writeup;
  const s = w?.summary;
  if (!w || !s) {
    const why = story.items.every((i) => i.source.content_type === "opinion")
      ? "This is opinion or commentary. We summarise news reports only, so compare the pieces below."
      : !story.items.some((i) => i.source.ai_input_allowed && i.source.content_type !== "opinion")
        ? "The outlets covering this story don't allow their reports to be used for machine-written summaries, so we show their headlines only."
        : SUMMARIES_ON && !summarisable(story)
          ? "The outlets' descriptions of this story are too short to write a fair summary from. Compare the coverage below."
          : "A written summary isn't ready for this story yet. Until then, compare the coverage below.";
    return `<div class="callout">${why} Grouping is automatic and can make mistakes: <a href="${root}about/#corrections">tell us</a> if a report doesn't belong here.</div>`;
  }
  const lists = (Object.keys(CLAIM_HEADINGS) as (keyof typeof CLAIM_HEADINGS)[])
    .filter((l) => s[l].length > 0)
    .map((l) => `<h2>${CLAIM_HEADINGS[l]}</h2><ul class="claims">${s[l].map((c) => `<li>${claimText(c, w)}</li>`).join("")}</ul>`)
    .join("");
  const mode = legalMode(story.items);
  const text = story.items.map((i) => `${i.title} ${i.summary}`);
  const notes = [
    mode !== "normal" && text.some((t) => ACCUSATION.test(t)) ? "Charges and allegations are not findings of guilt. Everyone is presumed innocent unless proven guilty in court." : "",
    mode === "brief" ? "To protect the people involved, this summary is kept brief and leaves out names and identifying details." : "",
  ].filter(Boolean);
  const callout = notes.length ? `<p class="callout">${notes.join(" ")}</p>` : "";
  const support = text.some((t) => SUICIDE.test(t))
    ? `<p class="callout">If this story raises concerns for you, support is available from Lifeline on <a href="tel:131114">13 11 14</a> or Beyond Blue on <a href="tel:1300224636">1300 22 4636</a>.</p>`
    : "";
  return `<section class="writeup" aria-label="Summary">
${callout}${paragraphs(s.summary).map((p) => `<p>${p.map((c) => claimText(c, w)).join(" ")}</p>`).join("")}
${support}${lists}
<p class="ai-note">Written by AI from the outlets' headlines and descriptions${w.articles ? `, and the full text of ${w.articles === 1 ? "one article whose publisher allows" : `${w.articles} articles whose publishers allow`} it` : ""}, then checked automatically against them; updated ${timeTag(new Date(w.written))}. Mistakes are possible: email <a href="mailto:${CORRECTIONS_EMAIL}">${CORRECTIONS_EMAIL}</a>.</p>
</section>`;
}

export function renderStory(story: Story, updated: Date): string {
  const root = "../../";
  const groups = LIST_GROUPS.map((g) => {
    const items = story.items.filter((i) => coverageGroup(i) === g);
    return items.length ? `<section class="group group-${g}"><h2>${esc(GROUP_HEADINGS[g])} <span class="n">${items.length}</span></h2><ul class="sources">${items.map(sourceRow).join("")}</ul></section>` : "";
  }).join("");
  const sources = new Set(story.items.map((i) => i.source.id)).size;
  const body = `<article class="story">
<p class="kicker"><a href="${root}${story.section}/">${esc(SECTION_LABELS[story.section])}</a></p>
<h1>${esc(storyTitle(story))}</h1>
<p class="credit">${story.writeup?.summary ? `Summary of ${plural(Object.keys(story.writeup.sources).length, "report")}${story.independent < 2 ? `: only ${esc(story.headline.source.name)} has reported this so far` : ""}` : `Headline from ${esc(story.headline.source.name)}`}</p>
<figure class="hero">${picture(story, root, "hero-img", STORY_SIZES)}${
    story.photo
      ? `<figcaption>${story.photo.kind === "named" ? `File photo of ${esc(story.photo.subject)}` : `File photo: ${esc(story.photo.subject)}`}, not taken at this event. ${photoCredit(story.photo)}.</figcaption>`
      : ""
  }</figure>
${coverageBar(story, true)}${oneSidedNote(story)}
${writeupBlock(story, root)}
${story.writeup?.summary ? `<h2>All coverage</h2>` : ""}
${groups}
<p class="story-stats">${plural(story.items.length, "report")} from ${plural(sources, "outlet")} and ${plural(story.independent, "independent owner")}. First reported ${timeTag(story.first)}; latest ${timeTag(story.last)}.</p>
</article>`;
  return page({ title: `${storyTitle(story)} | ${SITE_NAME}`, description: `How ${plural(sources, "outlet")} covered this story.`, root, active: story.section, body, updated });
}

const LEAN_TEXT: Record<string, string> = { left: "Left", "centre-left": "Centre-left", centre: "Centre", "centre-right": "Centre-right", right: "Right" };

export function renderAbout(sources: Source[], updated: Date): string {
  const root = "../";
  const enabled = sources.filter((s) => s.enabled).sort((a, b) => a.name.localeCompare(b.name));
  const rows = enabled
    .map(
      (s) =>
        `<tr><td><a href="${esc(s.homepage)}" rel="noopener">${esc(s.name)}</a></td><td>${esc(s.lean ? LEAN_TEXT[s.lean]! : s.content_type === "official" ? "Official" : s.content_type === "community" ? "Local / unrated" : "Not rated")}</td><td>${esc(s.owner_group)}</td><td>${esc(s.paywall === "free" ? "Free" : s.paywall === "partial" ? "Partly" : "Paywall")}</td></tr>`,
    )
    .join("");
  const body = `<article class="prose">
<h1>How this works</h1>
<p>${SITE_NAME} collects headlines from ${enabled.length} news outlets, groups reports about the same event, and shows how outlets from across the political spectrum covered it. It is made in Australia, is free, and has no ads and no tracking.</p>
<p>The site is rebuilt every hour during the day. Between midnight and 6 am (Sydney time) it is rebuilt once, at about 4 am, because little changes overnight.</p>
<h2>The front page</h2>
<ul>
<li><strong>Top stories:</strong> the events leading on major Australian news sites right now and covered by the most independent outlets, with fresher news ranked higher. Two places go to local stories. The last top story, marked "And finally", is chosen to end on a lighter note.</li>
<li><strong>Sections:</strong> local news first (Western Australia for now), then Australia, New Zealand and the world, then politics, business, science, tech, sport, entertainment and good news. Each shows stories with our written summary, then more headlines.</li>
<li><strong>Weather:</strong> seven-day forecasts for every capital city from <a href="https://open-meteo.com/" rel="noopener">Open-Meteo</a> (CC BY 4.0). The front page shows your capital, guessed from your device's time zone; choose another with "Change". For official warnings, see the <a href="https://www.bom.gov.au/australia/warnings/" rel="noopener">Bureau of Meteorology</a>.</li>
<li><strong>On this day and Did you know?:</strong> from Wikipedia's selected anniversaries and "Did you know" facts (CC BY-SA 4.0).</li>
<li><strong>Daily quiz:</strong> ten general-knowledge questions a day from the <a href="https://opentdb.com/" rel="noopener">Open Trivia Database</a> (CC BY-SA 4.0).</li>
</ul>
<p>Your weather city and quiz answers are kept in your own browser only; nothing is sent to us.</p>
<h2>What you see on a story</h2>
<ul>
<li><strong>Coverage bar:</strong> how many independent owners on the left, centre and right reported the story. Outlets owned by the same company count once. Opinion pieces are listed but not counted.</li>
<li><strong>"Only covered by … sources so far":</strong> shown when three or more independent rated outlets cover a story and all are on one side.</li>
<li><strong>Every source, linked:</strong> read the original reports and compare them yourself. Each link is marked Free or Paywall.</li>
</ul>
<h2>Pictures</h2>
<p>We never use photos from news outlets. Every picture is a free-licensed file photo from <a href="https://commons.wikimedia.org/" rel="noopener">Wikimedia Commons</a> or <a href="https://openverse.org/" rel="noopener">Openverse</a> (mostly Flickr), shown with its photographer and licence. They are not pictures of the event itself. We look, in order, for a photo of the story's main person, organisation or thing; then the place or object at the centre of the story; then a place named in the reports; then the story's broad topic. Search words are suggested by an AI model (Google Gemini) and every photo is checked by our software for its licence and that its title matches. If nothing suitable turns up, the story shows S.M.P. artwork for its section. Court and crime stories never show a person, only places, buildings or objects, so no one is pictured next to an allegation. If a picture is wrong for a story, <a href="#corrections">tell us</a>.</p>
<h2>Where the lean ratings come from</h2>
<p>Ratings are opinions, not facts. They come from <a href="https://www.allsides.com/media-bias/ratings" rel="noopener">AllSides</a> and <a href="https://mediabiasfactcheck.com/" rel="noopener">Media Bias/Fact Check</a> where available; otherwise they are our editorial judgement. World outlets are rated on a US/UK axis, which doesn't map exactly onto Australian politics. Local, community and student outlets aren't rated; official sources (government, universities) are listed separately.</p>
${
    SUMMARIES_ON
      ? `<h2>Summaries</h2>
<p>Story summaries, and the plain headline above them, are written by an AI model (Google Gemini) from the linked outlets' headlines and short descriptions. For the few outlets whose licence or terms allow it (such as The Conversation and government media releases), it also reads the full free article, checked against the outlet's robots.txt; that text is used only to write the summary and is never stored or republished. It is told to use only what those reports say, in its own words, and to attribute disputed claims. Every sentence lists the outlets it came from. Before anything is published, our software checks each sentence: the cited outlets must contain the quoted words, every name and number must appear in their reports, and no sentence may copy an outlet's wording. Sentences that fail are dropped; if too many fail, the story shows headlines only. A summary is as long as the reports allow, up to three paragraphs, and is rewritten when several new outlets join a story. Court and crime stories are written with extra care: nobody involved is named, every allegation is attributed to the police, the court or the outlet reporting it, and nobody is described as guilty unless convicted. Stories involving sexual offences, young people, suicide or suppression orders get a brief factual summary only, without names, relationships, places or other details that could identify anyone. Mistakes are still possible: please <a href="#corrections">tell us</a>.</p>
<h2>Preview edition</h2>
<p>This is an early preview. Stories are grouped automatically and can include a report that doesn't belong.</p>`
      : `<h2>Preview edition</h2>
<p>This is an early preview. Stories are grouped automatically and can include a report that doesn't belong. Written summaries of what all sides report, where coverage differs and what only one side mentions are being built next; they will be machine-written from the linked sources, with every fact cited.</p>`
  }
<h2 id="corrections">Corrections and takedowns</h2>
<p>Email <a href="mailto:${CORRECTIONS_EMAIL}">${CORRECTIONS_EMAIL}</a> if a report is wrongly grouped, a picture is wrong for a story, an outlet's details are out of date, or you want something taken down. Please include the story's web address. We reply within 48 hours.</p>
<h2>Sources</h2>
<div class="table-wrap"><table><thead><tr><th>Outlet</th><th>Lean</th><th>Owner</th><th>Access</th></tr></thead><tbody>${rows}</tbody></table></div>
</article>`;
  return page({ title: `How this works | ${SITE_NAME}`, description: "How S.M.P. News groups stories and rates sources.", root, active: "about", body, updated });
}

export function renderNotFound(updated: Date): string {
  const body = `<h1>Story not found</h1><p>Stories leave the site after a few days. <a href="/">See today's top stories</a>.</p>`;
  return page({ title: `Not found | ${SITE_NAME}`, description: "Page not found", root: "/", body, updated });
}
