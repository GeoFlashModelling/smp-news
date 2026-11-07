/** Minimal RSS 2.0 / Atom item extractor. Reads only title, link, summary, date and id. */

export interface FeedItem {
  id: string;
  title: string;
  link: string;
  summary: string;
  published: string | null;
}

/** Full article bodies (`content:encoded`, Atom `<content>`) are never read here, even for sources with full_text_allowed. */
const SUMMARY_MAX_CHARS = 800;

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", ndash: "–", mdash: "—",
  lsquo: "‘", rsquo: "’", ldquo: "“", rdquo: "”", hellip: "…", eacute: "é",
};

function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, code: string) => {
    if (code[0] === "#") {
      const n = code[1] === "x" || code[1] === "X" ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
      return Number.isFinite(n) && n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : whole;
    }
    return NAMED_ENTITIES[code.toLowerCase()] ?? whole;
  });
}

function unwrapCdata(text: string): string {
  return text.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1");
}

/** Feed text → plain text: unwraps CDATA, decodes entity-escaped HTML, strips tags, collapses whitespace. */
export function toPlainText(raw: string): string {
  let text = unwrapCdata(raw);
  if (/&lt;\/?[a-z]/i.test(text)) text = decodeEntities(text);
  text = text.replace(/<(script|style)[\s\S]*?<\/\1>/gi, " ").replace(/<[^>]+>/g, " ");
  // Some publishers double-escape (`&amp;apos;`), so decode a second time.
  return decodeEntities(decodeEntities(text)).replace(/\s+/g, " ").trim();
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function tagText(block: string, names: string[]): string | null {
  for (const name of names) {
    const tag = escapeRegExp(name);
    const match = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, "i").exec(block);
    if (match?.[1] !== undefined) {
      const text = toPlainText(match[1]);
      if (text) return text;
    }
  }
  return null;
}

function atomLink(block: string): string | null {
  const links = [...block.matchAll(/<link\b([^>]*?)\/?>/gi)].map((m) => m[1] ?? "");
  const pick = links.find((a) => /rel=["']alternate["']/i.test(a)) ?? links.find((a) => !/rel=/i.test(a));
  const href = pick && /href=["']([^"']+)["']/i.exec(pick)?.[1];
  return href ? decodeEntities(href) : null;
}

function toIsoDate(text: string | null): string | null {
  if (!text) return null;
  const time = Date.parse(text);
  return Number.isNaN(time) ? null : new Date(time).toISOString();
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  return `${cut.slice(0, Math.max(cut.lastIndexOf(" "), max - 40))}…`;
}

export function parseFeed(xml: string): FeedItem[] {
  const blocks = [...xml.matchAll(/<item[\s>][\s\S]*?<\/item>/gi), ...xml.matchAll(/<entry[\s>][\s\S]*?<\/entry>/gi)].map((m) => m[0]);
  const items: FeedItem[] = [];
  for (const block of blocks) {
    const title = tagText(block, ["title"]) ?? "";
    const link = tagText(block, ["link"]) ?? atomLink(block) ?? tagText(block, ["guid"]) ?? "";
    if (!title && !link) continue;
    items.push({
      id: tagText(block, ["guid", "id"]) ?? link,
      title,
      link,
      summary: truncate(tagText(block, ["description", "summary", "media:description"]) ?? "", SUMMARY_MAX_CHARS),
      published: toIsoDate(tagText(block, ["pubDate", "published", "updated", "dc:date"])),
    });
  }
  return items;
}
