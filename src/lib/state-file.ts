import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

/**
 * Writes a state file whole or not at all (a temporary file, then renamed over it): the workflow saves these files even
 * when a run is stopped part-way, and a half-written one would be unreadable, so everything in it would start again.
 */
export async function saveState(file: string, data: unknown): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  await writeFile(`${file}.tmp`, JSON.stringify(data));
  await rename(`${file}.tmp`, file);
}
