import crypto from "node:crypto";
import type { QueryExecutor } from "../../../ditto/session.js";

/** Import usage/input failures → exit 2. */
export class ImportError extends Error {
  readonly exitCode = 2;
  constructor(message: string) {
    super(message);
    this.name = "ImportError";
  }
}

/** Collection names become DQL identifiers in the INSERT — validate strictly (no injection surface). */
export function isValidCollectionName(name: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(name);
}

function validateDocs(docs: unknown[], file: string): Record<string, unknown>[] {
  for (let i = 0; i < docs.length; i++) {
    const d = docs[i];
    if (typeof d !== "object" || d === null || Array.isArray(d)) {
      throw new ImportError(`${file}: document #${i + 1} is not a JSON object`);
    }
  }
  return docs as Record<string, unknown>[];
}

/**
 * Parse the standard import format: a JSON array of objects (`[{...}, ...]`).
 * NDJSON (one object per line) is also accepted — detected by the first
 * non-whitespace character (`[` → array, `{` → NDJSON).
 */
export function parseImportFile(text: string, file = "input"): Record<string, unknown>[] {
  const trimmed = text.trimStart();
  if (trimmed === "") {
    throw new ImportError(`${file} is empty — expected a JSON array of documents`);
  }
  if (trimmed.startsWith("[")) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (err) {
      throw new ImportError(`${file}: invalid JSON — ${(err as Error).message}`);
    }
    // A leading "[" that parses is always an array.
    return validateDocs(parsed as unknown[], file);
  }
  if (trimmed.startsWith("{")) {
    const docs: unknown[] = [];
    const lines = text.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!.trim();
      if (!line) continue;
      try {
        docs.push(JSON.parse(line));
      } catch {
        throw new ImportError(
          `${file}: line ${i + 1} is not valid JSON (NDJSON = one document per line)`,
        );
      }
    }
    return validateDocs(docs, file);
  }
  throw new ImportError(
    `${file}: expected a JSON array of documents ([...]) or NDJSON (one object per line)`,
  );
}

export interface ImportOptions {
  batchSize?: number;
  onProgress?: (inserted: number, total: number) => void;
}

/**
 * Insert documents in batches using the dataset loader's proven pattern:
 * `INSERT INTO <coll> DOCUMENTS (deserialize_json(:docN)),… ON ID CONFLICT
 * DO UPDATE` so re-imports are idempotent. Documents without an `_id` get a
 * generated UUID (so re-importing a file without ids duplicates them — docs
 * should include `_id` for stable identity).
 */
export async function importDocuments(
  session: QueryExecutor,
  docs: Record<string, unknown>[],
  collection: string,
  opts: ImportOptions = {},
): Promise<number> {
  const batchSize = opts.batchSize ?? 500;
  let inserted = 0;
  for (let i = 0; i < docs.length; i += batchSize) {
    const chunk = docs
      .slice(i, i + batchSize)
      .map((d) => (d._id == null ? { _id: crypto.randomUUID(), ...d } : d));
    if (chunk.length === 0) continue;
    const args: Record<string, string> = {};
    const placeholders = chunk.map((doc, j) => {
      const key = `doc${j}`;
      args[key] = JSON.stringify(doc);
      return `(deserialize_json(:${key}))`;
    });
    await session.execute(
      `INSERT INTO ${collection} DOCUMENTS ${placeholders.join(", ")} ON ID CONFLICT DO UPDATE`,
      args,
    );
    inserted += chunk.length;
    opts.onProgress?.(inserted, docs.length);
  }
  return inserted;
}
