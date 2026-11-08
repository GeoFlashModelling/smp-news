import type { Section, Source } from "../config/sources.js";
import type { Photo } from "../images/wikimedia.js";
import type { Item } from "../lib/normalise.js";
import { coverageGroup, SECTION_HEADLINES, type CoverageGroup, type FrontPage, type Story } from "../lib/stories.js";
import { CORRECTIONS_EMAIL, NAV_ORDER, SECTION_LABELS, SITE_NAME, esc, page, plural, timeTag } from "./html.js";

const GROUP_LABELS: Record<CoverageGroup, string> = {
  left: "Left",
  centre: "Centre",
  right: "Right",
  local: "Local / unrated",
  unrated: "Not rated",
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
const LIST_GROUPS: readonly CoverageGroup[] = ["left", "centre", "right", "local", "unrated", "official"];
const SIDE_WORDING = { left: "left-leaning", right: "right-leaning", centre: "centre" } as const;

function coverageBar(story: Story, large = false): string {
  const total = BAR_GROUPS.reduce((n, g) => n + story.coverage[g], 0);
  const counts = BAR_GROUPS.filter((g) => story.coverage[g] > 0).map((g) => `${GROUP_LABELS[g]} ${story.coverage[g]}`);
  if (total === 0) return "";
  const segments = BAR_GROUPS.filter((g) => story.coverage[g] > 0)
    .map((g) => `<span class="seg seg-${g}" style="flex:${story.coverage[g]}"></span>`)
    .join("");
  return `<div class="cov${large ? " cov-lg" : ""}"><div class="bar" role="img" aria-label="Coverage: ${esc(counts.join(", "))}">${segments}</div><p class="counts">${esc(counts.join(" · "))}</p></div>`;
}

function oneSidedNote(story: Story): string {
  return story.oneSided ? `<p class="onesided">Only covered by ${SIDE_WORDING[story.oneSided]} sources so far.</p>` : "";
}

/** Credit required by the photo's licence: author, licence, and a link to the file page with the full terms. */
function photoCredit(photo: Photo): string {
  return `<a class="credit-link" href="${esc(photo.page)}" rel="noopener">Photo: ${esc(photo.artist)}, ${esc(photo.licence)}, via ${esc(photo.via)}</a>`;
}

/** The story's picture: a free-licensed photo, or the section artwork (decorative, so no alt text). */
function picture(story: Story, root: string, cls: string, eager = false): string {
  const loading = eager ? `fetchpriority="high"` : `loading="lazy"`;
  const p = story.photo;
  if (!p) return `<img class="${cls}" src="${root}assets/sections/${story.section}.svg" alt="" width="640" height="360" ${loading} decoding="async">`;
  const large = eager && p.large ? ` srcset="${esc(p.src)} 500w, ${esc(p.large)} 960w" sizes="(min-width: 800px) 760px, 100vw"` : "";
  return `<img class="${cls}${p.height > p.width ? " portrait" : ""}" src="${esc(p.src)}"${large} alt="${esc(p.subject)}" width="${p.width}" height="${p.height}" ${loading} decoding="async">`;
}

function storyCard(story: Story, root: string, showSection = true): string {
  const sources = new Set(story.items.map((i) => i.source.id)).size;
  return `<article class="card">
  <div class="pic">${picture(story, root, "pic-img")}${story.photo ? `<p class="pic-credit">${photoCredit(story.photo)}</p>` : ""}</div>
  ${showSection ? `<p class="kicker">${esc(SECTION_LABELS[story.section])}</p>` : ""}
  <h3><a href="${root}story/${story.id}/">${esc(story.headline.title)}</a></h3>
  ${coverageBar(story)}${oneSidedNote(story)}
  <p class="meta">${plural(sources, "source")} · ${plural(story.independent, "independent owner")} · updated ${timeTag(story.last)}</p>
</article>`;
}

function headlineList(stories: Story[], limit: number, root: string): string {
  if (stories.length === 0) return "";
  const rows = stories.slice(0, limit).map((s) => {
    const i = s.headline;
    return `<li>${picture(s, root, "thumb")}<div><a href="${esc(i.url)}" rel="noopener">${esc(i.title)}</a> <span class="src">${esc(i.source.name)}${i.source.paywall === "paywalled" ? " · Paywall" : ""} · ${timeTag(i.published)}</span>${s.photo ? `<span class="thumb-credit">${photoCredit(s.photo)}</span>` : ""}</div></li>`;
  });
  return `<ul class="headlines">${rows.join("")}</ul>`;
}

export function renderFront(front: FrontPage, updated: Date): string {
  const root = "";
  const top = front.top.map((s) => storyCard(s, root)).join("");
  const sections = NAV_ORDER.map((sec) => {
    const all = front.bySection.get(sec) ?? [];
    const multi = all.filter((s) => s.independent >= 2 && !front.top.includes(s)).slice(0, 4);
    const singles = all.filter((s) => s.independent < 2);
    if (multi.length === 0 && singles.length === 0) return "";
    return `<section class="sec" aria-labelledby="h-${sec}">
  <h2 id="h-${sec}"><a href="${sec}/">${esc(SECTION_LABELS[sec])}</a></h2>
  ${multi.length ? `<div class="grid">${multi.map((s) => storyCard(s, root, false)).join("")}</div>` : ""}
  ${singles.length ? `<h3 class="more">More ${esc(SECTION_LABELS[sec])} headlines</h3>${headlineList(singles, multi.length ? 5 : 8, root)}` : ""}
  <p class="all"><a href="${sec}/">All ${esc(SECTION_LABELS[sec])} →</a></p>
</section>`;
  }).join("");
  const body = `<h1 class="visually-hidden">${SITE_NAME}</h1>
<section aria-labelledby="h-top"><h2 id="h-top">Top stories</h2><div class="grid">${top}</div></section>
${sections}`;
  return page({ title: `${SITE_NAME}: every side of the story`, description: "Free Australian news that shows how left, centre and right sources cover the same event.", root, body, updated });
}

export function renderSection(section: Section, stories: Story[], updated: Date): string {
  const root = "../";
  const multi = stories.filter((s) => s.independent >= 2);
  const singles = stories.filter((s) => s.independent < 2);
  const body = `<h1>${esc(SECTION_LABELS[section])}</h1>
${multi.length ? `<div class="grid">${multi.map((s) => storyCard(s, root, false)).join("")}</div>` : `<p>No stories covered by more than one outlet yet.</p>`}
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

export function renderStory(story: Story, updated: Date): string {
  const root = "../../";
  const groups = LIST_GROUPS.map((g) => {
    const items = story.items.filter((i) => coverageGroup(i) === g);
    return items.length ? `<section class="group group-${g}"><h2>${esc(GROUP_HEADINGS[g])} <span class="n">${items.length}</span></h2><ul class="sources">${items.map(sourceRow).join("")}</ul></section>` : "";
  }).join("");
  const sources = new Set(story.items.map((i) => i.source.id)).size;
  const body = `<article class="story">
<p class="kicker"><a href="${root}${story.section}/">${esc(SECTION_LABELS[story.section])}</a></p>
<h1>${esc(story.headline.title)}</h1>
<p class="credit">Headline from ${esc(story.headline.source.name)}</p>
<figure class="hero">${picture(story, root, "hero-img", true)}${
    story.photo
      ? `<figcaption>${story.photo.kind === "named" ? `File photo of ${esc(story.photo.subject)}` : `File photo: ${esc(story.photo.subject)}`}, not taken at this event. ${photoCredit(story.photo)}.</figcaption>`
      : ""
  }</figure>
${coverageBar(story, true)}${oneSidedNote(story)}
<p class="facts">${plural(story.items.length, "report")} from ${plural(sources, "outlet")} and ${plural(story.independent, "independent owner")}. First reported ${timeTag(story.first)}; latest ${timeTag(story.last)}.</p>
<div class="callout">Our written summary of what every side reports is coming soon. Until then, compare the coverage below. Grouping is automatic and can make mistakes: <a href="${root}about/#corrections">tell us</a> if a report doesn't belong here.</div>
${groups}
</article>`;
  return page({ title: `${story.headline.title} | ${SITE_NAME}`, description: `How ${sources} outlets covered this story.`, root, active: story.section, body, updated });
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
<p>${SITE_NAME} collects headlines from ${enabled.length} news outlets every hour, groups reports about the same event, and shows how outlets from across the political spectrum covered it. It is free, has no ads and no tracking.</p>
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
<h2>Preview edition</h2>
<p>This is an early preview. Stories are grouped automatically and can include a report that doesn't belong. Written summaries of what all sides report, where coverage differs and what only one side mentions are being built next; they will be machine-written from the linked sources, with every fact cited.</p>
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
