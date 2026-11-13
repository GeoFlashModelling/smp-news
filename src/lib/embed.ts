import { env, pipeline } from "@huggingface/transformers";

/**
 * Local sentence embeddings (all-MiniLM, Apache-2.0, about 25 MB). They run inside the hourly GitHub job.
 * No Gemini call, free or paid. EMBEDDINGS=off skips them and grouping stays on words alone.
 * A headline from a source that forbids AI input is passed as null and is never sent to the model.
 */
const MODEL = "Xenova/all-MiniLM-L6-v2";
const BATCH = 64;

type Embedder = (texts: string[]) => Promise<number[][]>;

let loading: Promise<Embedder> | null = null;

function load(): Promise<Embedder> {
  loading ??= (async () => {
    env.cacheDir = ".cache/models";
    const extractor = await pipeline("feature-extraction", MODEL, { dtype: "q8" });
    return async (texts: string[]) => {
      const out = await extractor(texts, { pooling: "mean", normalize: true });
      return out.tolist() as number[][];
    };
  })();
  return loading;
}

/** One vector per input. Null inputs stay null. Returns null if the model cannot be loaded, so the edition still publishes. */
export async function embedAllowed(texts: (string | null)[]): Promise<(Float32Array | null)[] | null> {
  if (process.env.EMBEDDINGS === "off") return null;
  const todo = texts.flatMap((text, index) => (text && text.trim() ? [index] : []));
  if (!todo.length) return texts.map(() => null);
  try {
    const embed = await load();
    const vectors: (Float32Array | null)[] = texts.map(() => null);
    for (let start = 0; start < todo.length; start += BATCH) {
      const indexes = todo.slice(start, start + BATCH);
      const rows = await embed(indexes.map((index) => texts[index]!));
      indexes.forEach((index, row) => {
        vectors[index] = Float32Array.from(rows[row] ?? []);
      });
    }
    return vectors;
  } catch (err) {
    loading = null;
    console.log(`Embeddings skipped (${err instanceof Error ? err.message : err}). Grouping continues on words alone.`);
    return null;
  }
}
