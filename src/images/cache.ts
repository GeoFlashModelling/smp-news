import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

const CACHE_DAYS = 7;
/** Bump when the matching rules change, so cached answers from older rules are discarded. */
const RULES_VERSION = 7;

type Entry = { value: unknown; checked: string };

/**
 * Answers from earlier editions (photo lookups, searches, suggested search words), kept for a week in one JSON file
 * that GitHub Actions carries between runs, so each hourly edition only asks about new names and stories.
 */
export class ImageCache {
  private constructor(
    private readonly file: string,
    private readonly now: Date,
    private entries: Record<string, Entry>,
  ) {}

  static async open(file: string, now: Date): Promise<ImageCache> {
    let entries: Record<string, Entry> = {};
    try {
      const saved = JSON.parse(await readFile(file, "utf8")) as { version: number; entries: Record<string, Entry> };
      if (saved.version === RULES_VERSION) entries = saved.entries;
    } catch {
      // first run or unreadable cache: start empty
    }
    const cache = new ImageCache(file, now, entries);
    for (const key of Object.keys(entries)) if (!cache.has(key)) delete entries[key];
    return cache;
  }

  has(key: string): boolean {
    const e = this.entries[key];
    return e !== undefined && this.now.getTime() - Date.parse(e.checked) < CACHE_DAYS * 86_400_000;
  }

  get<T>(key: string): T | undefined {
    return this.has(key) ? (this.entries[key]!.value as T) : undefined;
  }

  delete(key: string): void {
    delete this.entries[key];
  }

  set(key: string, value: unknown): void {
    this.entries[key] = { value, checked: this.now.toISOString() };
  }

  async save(): Promise<void> {
    await mkdir(dirname(this.file), { recursive: true });
    await writeFile(this.file, JSON.stringify({ version: RULES_VERSION, entries: this.entries }));
  }
}
