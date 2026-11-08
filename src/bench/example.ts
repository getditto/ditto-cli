import type { CatalogQuery, DatasetSuite } from "../datasets/types.js";

/** One entry of a sample benchmark file, keys in the order they run. */
export interface ExampleEntry {
  description: string;
  preQueries?: string[];
  resetQueries?: string[];
  query: string;
  postQueries?: string[];
}

const WRITES = new Set(["INSERT", "UPSERT", "UPDATE", "DELETE", "EVICT"]);

const DESCRIBE = {
  read: 'A plain read. Only "query" is required: it is the statement that is timed.',
  index:
    "preQueries run once, before warmup and timing: here they create an index. postQueries run once at the end, even if something failed: here they drop the index so later benchmarks start from the same state.",
  aggregate: "An aggregate over a whole collection: usually the slowest kind of read.",
  join: "A join across two collections, with an index on the join field created in preQueries and dropped in postQueries.",
  resetWrite:
    "A write. resetQueries run before every warmup and timed run, untimed, to put the data back, so each run makes the same change. postQueries remove the test document at the end.",
  repeatWrite:
    "A write that is safe to repeat: preQueries add a test document once, every run updates it, and postQueries remove it at the end.",
};

/** The VALUES keyword reads better than DOCUMENTS (same meaning in DQL). */
function preferValues(statement: string): string {
  return statement.replace(/\b(INSERT\s+INTO\s+\S+\s+)DOCUMENTS(\s*\()/gi, "$1VALUES$2");
}

function entry(description: string, q: CatalogQuery): ExampleEntry {
  const list = (xs?: string[]) => (xs && xs.length > 0 ? xs.map(preferValues) : undefined);
  // Spread in run order so the JSON reads top to bottom as it executes.
  const pre = list(q.preQueries);
  const reset = list(q.resetQueries);
  const post = list(q.postQueries);
  return {
    description,
    ...(pre && { preQueries: pre }),
    ...(reset && { resetQueries: reset }),
    query: preferValues(q.query),
    ...(post && { postQueries: post }),
  };
}

/**
 * A small sample benchmark file drawn from a dataset's query catalog: a
 * plain read, an indexed read, an aggregate, a join (when the dataset has
 * one), and a write that restores its own state, each with a description of
 * what its parts do.
 */
export function exampleBenchFile(suite: DatasetSuite): Record<string, ExampleEntry> {
  const candidates = Object.entries(suite.catalog).filter(
    ([name, q]) => !q.negative && !suite.knownIssues?.[name],
  );
  const first = (test: (q: CatalogQuery) => boolean) => candidates.find(([, q]) => test(q));

  const picks: [string, CatalogQuery, string][] = [];
  const add = (found: [string, CatalogQuery] | undefined, description: string) => {
    if (found && !picks.some(([n]) => n === found[0])) picks.push([...found, description]);
  };

  add(
    first((q) => q.category === "SELECT"),
    DESCRIBE.read,
  );
  add(
    first((q) => /INDEX_SELECT$/.test(q.category) && (q.preQueries?.length ?? 0) > 0),
    DESCRIBE.index,
  );
  add(
    first((q) => q.category === "AGGREGATION"),
    DESCRIBE.aggregate,
  );
  add(
    first((q) => q.category === "JOIN_INNER"),
    DESCRIBE.join,
  );
  const resetWrite = first((q) => WRITES.has(q.category) && (q.resetQueries?.length ?? 0) > 0);
  if (resetWrite) add(resetWrite, DESCRIBE.resetWrite);
  else {
    add(
      first((q) => q.category === "UPDATE" && (q.postQueries?.length ?? 0) > 0),
      DESCRIBE.repeatWrite,
    );
  }

  return Object.fromEntries(picks.map(([name, q, d]) => [name, entry(d, q)]));
}
