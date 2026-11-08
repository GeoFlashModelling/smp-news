import { copyFile, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { SECTIONS, type Source } from "../config/sources.js";
import type { Facts } from "../lib/facts.js";
import { frontPage, type Story } from "../lib/stories.js";
import { sectionArtwork } from "./artwork.js";
import { SITE_HOST, SITE_NAME } from "./html.js";
import { renderAbout, renderFront, renderNotFound, renderSection, renderStory } from "./render.js";

const ASSETS = ["site.css", "site.js", "favicon.svg", "smp-wordmark.svg"];

async function put(dir: URL, path: string, content: string): Promise<void> {
  const file = new URL(path, dir);
  await mkdir(new URL(".", file), { recursive: true });
  await writeFile(file, content);
}

/** Writes the whole static site into `dir` (emptied first). Returns the number of files written. */
export async function generateSite(dir: URL, stories: Story[], sources: Source[], updated: Date, facts: Facts): Promise<number> {
  await mkdir(dir, { recursive: true });
  for (const entry of await readdir(dir)) await rm(new URL(entry, dir), { recursive: true, force: true });
  await mkdir(new URL("assets/", dir), { recursive: true });
  for (const a of ASSETS) await copyFile(new URL(`../../assets/${a}`, import.meta.url), new URL(`assets/${a}`, dir));

  const front = frontPage(stories, updated);
  let files = ASSETS.length;
  const write = async (path: string, content: string) => {
    await put(dir, path, content);
    files++;
  };

  for (const sec of SECTIONS) await write(`assets/sections/${sec}.svg`, sectionArtwork(sec));
  await write("index.html", renderFront(front, updated, facts));
  for (const sec of SECTIONS) await write(`${sec}/index.html`, renderSection(sec, front.bySection.get(sec) ?? [], updated));
  for (const story of stories.filter((s) => s.independent >= 2)) await write(`story/${story.id}/index.html`, renderStory(story, updated));
  await write("about/index.html", renderAbout(sources, updated));
  await write("404.html", renderNotFound(updated));
  await write("robots.txt", "User-agent: *\nDisallow: /\n");
  await write("CNAME", `${SITE_HOST}\n`);
  await write(
    "manifest.webmanifest",
    JSON.stringify({ name: SITE_NAME, short_name: "SMP News", start_url: "/", display: "standalone", background_color: "#ffffff", theme_color: "#162939", icons: [{ src: "/assets/favicon.svg", sizes: "any", type: "image/svg+xml" }] }, null, 2),
  );
  await write(
    "edition.json",
    JSON.stringify(
      {
        updated: updated.toISOString(),
        stories: stories
          .filter((s) => s.independent >= 2)
          .map((s) => ({ id: s.id, section: s.section, headline: s.headline.title, independent: s.independent, coverage: s.coverage, photo: s.photo ? { subject: s.photo.subject, kind: s.photo.kind, via: s.photo.via, page: s.photo.page } : null, first: s.first, last: s.last, links: s.items.map((i) => ({ source: i.source.id, url: i.url })) })),
      },
      null,
      1,
    ),
  );
  return files;
}
