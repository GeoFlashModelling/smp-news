import { readFile } from "node:fs/promises";
import { saveState } from "./state-file.js";
import type { Story } from "./stories.js";

/**
 * Story identity (plan 1.4). A story's ID starts as a hash of its earliest report, but that report can leave the feeds
 * or the time window, or an older one can join, and a new ID would lose the story's summary, photo and web address
 * (owner, 11 Nov 2026: about ten written stories an hour were being written again). So each edition matches its
 * stories to the previous editions' by the reports they share, and a matched story keeps its ID.
 */

/** Longer than summaries are kept (3 days), so a story that pauses for a day still finds its summary. */
const KEEP_DAYS = 4;
/** Report keys remembered per story: enough for a big story's coverage over a couple of days. */
const MAX_KEYS = 400;
const VERSION = 1;

interface Known {
  /** Report keys seen in this story, newest first. */
  keys: string[];
  firstSeen: string;
  lastSeen: string;
}

interface State {
  version: number;
  stories: Record<string, Known>;
}

async function load(file: string): Promise<State> {
  try {
    const saved = JSON.parse(await readFile(file, "utf8")) as State;
    if (saved.version === VERSION) return saved;
  } catch {
    // first run or unreadable: every story keeps its hashed ID
  }
  return { version: VERSION, stories: {} };
}

/**
 * Gives each story the ID it had before, where it shares reports with a story from an earlier edition. The pairs that
 * share the most reports are matched first, and each old ID goes to one story only: when two stories merge the bigger
 * share keeps its ID, and when one splits the part with most of the old reports keeps it. Returns when each story was
 * first seen.
 */
export async function keepStoryIds(stories: Story[], file: string, now: Date): Promise<Map<string, Date>> {
  const state = await load(file);
  const idOfKey = new Map<string, string>();
  for (const [id, known] of Object.entries(state.stories)) for (const key of known.keys) idOfKey.set(key, id);

  const pairs: { story: Story; id: string; shared: number }[] = [];
  for (const story of stories) {
    const shared = new Map<string, number>();
    for (const item of story.items) {
      const id = idOfKey.get(item.key);
      if (id) shared.set(id, (shared.get(id) ?? 0) + 1);
    }
    for (const [id, n] of shared) pairs.push({ story, id, shared: n });
  }
  pairs.sort((a, b) => b.shared - a.shared || b.story.score - a.story.score);

  const matched = new Map<Story, string>();
  const claimed = new Set<string>();
  for (const { story, id } of pairs) {
    if (matched.has(story) || claimed.has(id)) continue;
    matched.set(story, id);
    claimed.add(id);
  }
  for (const story of stories) {
    const old = matched.get(story);
    if (old) story.id = old;
    else {
      // A new story's hashed ID must not be one that another story kept (or one still remembered from before).
      let id = story.id;
      for (let n = 2; claimed.has(id) || state.stories[id]; n++) id = `${story.id.slice(0, 8)}${n.toString(36).padStart(2, "0")}`;
      story.id = id;
      claimed.add(id);
    }
  }

  const firstSeen = new Map<string, Date>();
  for (const story of stories) {
    const known = state.stories[story.id];
    const keys = [...new Set([...story.items.map((i) => i.key), ...(known?.keys ?? [])])].slice(0, MAX_KEYS);
    const first = known?.firstSeen ?? now.toISOString();
    state.stories[story.id] = { keys, firstSeen: first, lastSeen: now.toISOString() };
    firstSeen.set(story.id, new Date(first));
  }
  for (const [id, known] of Object.entries(state.stories)) {
    if (now.getTime() - Date.parse(known.lastSeen) > KEEP_DAYS * 86_400_000) delete state.stories[id];
  }
  await saveState(file, state);
  return firstSeen;
}
