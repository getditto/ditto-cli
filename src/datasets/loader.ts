import type { QueryExecutor } from "../ditto/session.js";
import { Rng } from "./rng.js";
import type { CollectionBatch, DatasetSuite } from "./types.js";

export interface LoadOptions {
  docs: number;
  seed: number;
  batchSize: number;
  onProgress?: (collection: string, inserted: number, total: number) => void;
}

export interface LoadResult {
  collections: Record<string, number>;
  totalDocs: number;
}

/**
 * Generate a dataset and insert it in batches. Uses the benchmark importer's
 * proven pattern: `INSERT INTO <coll> DOCUMENTS (deserialize_json(:docN)),…`
 * with `ON ID CONFLICT DO UPDATE` so reloads are idempotent.
 */
export async function loadDataset(
  session: QueryExecutor,
  suite: DatasetSuite,
  opts: LoadOptions,
): Promise<LoadResult> {
  const batches: CollectionBatch[] = suite.generate({ docs: opts.docs, seed: opts.seed, rng: new Rng(opts.seed) });
  const collections: Record<string, number> = {};
  let totalDocs = 0;

  for (const batch of batches) {
    for (let i = 0; i < batch.docs.length; i += opts.batchSize) {
      const chunk = batch.docs.slice(i, i + opts.batchSize);
      if (chunk.length === 0) continue;
      const args: Record<string, string> = {};
      const placeholders = chunk.map((doc, j) => {
        const key = `doc${j}`;
        args[key] = JSON.stringify(doc);
        return `(deserialize_json(:${key}))`;
      });
      await session.execute(
        `INSERT INTO ${batch.collection} DOCUMENTS ${placeholders.join(", ")} ON ID CONFLICT DO UPDATE`,
        args,
      );
      collections[batch.collection] = (collections[batch.collection] ?? 0) + chunk.length;
      totalDocs += chunk.length;
      opts.onProgress?.(batch.collection, collections[batch.collection]!, batch.docs.length);
    }
  }
  return { collections, totalDocs };
}
